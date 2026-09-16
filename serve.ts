import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

// Value stored here is a pgid, not a plain pid: publishPreview spawns the preview server
// detached (its own process group), so child.pid IS the group's pgid. Always kill with
// process.kill(-pgid, …) — killing the bare pid only reaps the "npx" wrapper and orphans
// the "serve" process holding the port.
const PID_NAME = "serve.pid";

const BUILD_TIMEOUT_MS = 10 * 60 * 1000;
const EXPORT_RETRY_DELAY_MS = 30_000;

// A function, not a module-level const: tests flip HOSTED between calls without re-importing.
export const hosted = () => !!process.env.HOSTED;

/** sites/<domain>/app -> /preview/<domain>/ */
export function previewPathFor(appDir: string): string {
  const domain = path.basename(path.dirname(appDir));
  return `/preview/${domain}/`;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killGroup(pgid: number, signal: NodeJS.Signals = "SIGTERM") {
  process.kill(-pgid, signal);
}

/** Tolerates the legacy bare-pgid format written by earlier code, alongside the current JSON one. */
function readPidFile(file: string): { pgid: number; port: number | null } | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
  if (!raw) return null;
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      const pgid = Number(parsed.pgid);
      if (!pgid) return null;
      return { pgid, port: typeof parsed.port === "number" ? parsed.port : null };
    } catch {
      return null;
    }
  }
  const pgid = Number(raw);
  return pgid ? { pgid, port: null } : null;
}

export type PreviewInfo = { domain: string; pgid: number; port: number | null; url: string | null; alive: boolean };

/** Every live preview under `sites/`. Removes the pid file for any entry that is no longer alive. */
export function listPreviews(root: string = process.cwd()): PreviewInfo[] {
  const sitesDir = path.join(root, "sites");
  const out: PreviewInfo[] = [];
  if (!existsSync(sitesDir)) return out;
  if (hosted()) {
    for (const site of readdirSync(sitesDir)) {
      if (!existsSync(path.join(sitesDir, site, "app", "out", "index.html"))) continue;
      out.push({ domain: site, pgid: 0, port: null, url: `/preview/${site}/`, alive: true });
    }
    return out;
  }
  for (const site of readdirSync(sitesDir)) {
    const pidFile = path.join(sitesDir, site, "app", PID_NAME);
    if (!existsSync(pidFile)) continue;
    const info = readPidFile(pidFile);
    if (!info || !isAlive(info.pgid)) {
      rmSync(pidFile, { force: true });
      continue;
    }
    out.push({
      domain: site,
      pgid: info.pgid,
      port: info.port,
      url: info.port ? `http://localhost:${info.port}` : null,
      alive: true,
    });
  }
  return out;
}

/** Kills the preview's process group and removes its pid file. Returns whether anything was killed. */
export function stopPreview(domain: string, root: string = process.cwd()): boolean {
  if (hosted()) return false; // nginx serves the static export; there is no process to stop
  const pidFile = path.join(root, "sites", domain, "app", PID_NAME);
  if (!existsSync(pidFile)) return false;
  const info = readPidFile(pidFile);
  let killed = false;
  if (info && isAlive(info.pgid)) {
    try {
      killGroup(info.pgid);
      killed = true;
    } catch {
      // already gone
    }
  }
  rmSync(pidFile, { force: true });
  return killed;
}

function freePort(start: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (port: number) => {
      if (port > start + 200) return reject(new Error("no free port found"));
      const srv = createServer();
      srv.once("error", () => tryPort(port + 1));
      srv.once("listening", () => srv.close(() => resolve(port)));
      srv.listen(port, "127.0.0.1");
    };
    tryPort(start);
  });
}

async function waitFor200(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`preview did not respond with 200 within ${timeoutMs}ms: ${url}`);
}

function runBuild(appDir: string, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("npx", ["next", "build"], { cwd: appDir, signal });
    let output = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        new Error(`Publishing local preview failed: "next build" did not finish within ${BUILD_TIMEOUT_MS / 1000}s`),
      );
    }, BUILD_TIMEOUT_MS);
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err.name === "AbortError") {
        reject(new Error("Publishing local preview stopped by user during \"next build\"."));
      } else {
        reject(new Error(`Publishing local preview failed: could not start "npx next build" — ${err.message}`));
      }
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Publishing local preview failed: next build failed:\n${output.split("\n").slice(-40).join("\n")}`));
      } else {
        resolve();
      }
    });
  });
}

// A candidate is a value whose first character is "/" and whose second is not — i.e. it is
// root-absolute and not scheme-relative ("//cdn/..."). Anything else (http(s):, data:, mailto:,
// tel:, "#...", "?...", or already-prefixed) is left untouched, which is what makes this
// idempotent: a URL already under basePath fails the basePath check below and is skipped.
function rebaseValue(value: string, basePath: string): string | null {
  if (value[0] !== "/" || value[1] === "/") return null;
  if (value.startsWith(basePath)) return null;
  return basePath + value;
}

const HTML_ATTR_RE = /\b(src|href)=("|')([^"']*)\2/g;
const HTML_SRCSET_RE = /\bsrcset=("|')([^"']*)\1/g;
const CSS_URL_RE = /url\((["']?)([^"')]*)\1\)/g;

function rebaseHtml(content: string, basePath: string): { content: string; changed: boolean } {
  let changed = false;
  let out = content.replace(HTML_ATTR_RE, (m, attr, q, value) => {
    const rebased = rebaseValue(value, basePath);
    if (rebased === null) return m;
    changed = true;
    return `${attr}=${q}${rebased}${q}`;
  });
  out = out.replace(HTML_SRCSET_RE, (m, q, list) => {
    const rewritten = list
      .split(",")
      .map((candidate: string) => {
        const trimmed = candidate.trim();
        if (!trimmed) return trimmed;
        const spaceIdx = trimmed.search(/\s/);
        const url = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
        const descriptor = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx);
        const rebased = rebaseValue(url, basePath);
        if (rebased === null) return trimmed;
        changed = true;
        return rebased + descriptor;
      })
      .join(", ");
    return `srcset=${q}${rewritten}${q}`;
  });
  return { content: out, changed };
}

function rebaseCss(content: string, basePath: string): { content: string; changed: boolean } {
  let changed = false;
  const out = content.replace(CSS_URL_RE, (m, q, value) => {
    const rebased = rebaseValue(value, basePath);
    if (rebased === null) return m;
    changed = true;
    return `url(${q}${rebased}${q})`;
  });
  return { content: out, changed };
}

function rebaseFile(file: string, basePath: string): boolean {
  const original = readFileSync(file, "utf8");
  const { content, changed } = file.endsWith(".css")
    ? rebaseCss(original, basePath)
    : rebaseHtml(original, basePath);
  if (changed) writeFileSync(file, content);
  return changed;
}

/**
 * Rewrites root-absolute references (src=, href=, srcset=, CSS url()) in every .html/.css file
 * under outDir so they resolve under basePath — e.g. `/logo.png` -> `/preview/foo.com/logo.png`.
 * Never touches .js: Next's runtime already carries the prefix from next.config.ts's basePath.
 * Idempotent — a value already under basePath, or not root-absolute, is left alone. Returns the
 * number of files changed.
 */
export function rebaseExport(outDir: string, basePath: string): number {
  let changed = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".html") || entry.name.endsWith(".css")) {
        if (rebaseFile(full, basePath)) changed++;
      }
    }
  };
  if (existsSync(outDir)) walk(outDir);
  return changed;
}

export async function publishPreview(
  appDir: string,
  onLog: (line: string) => void,
  verifyExport?: (appDir: string) => string[] | Promise<string[]>,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new Error("Publishing local preview stopped by user before it started.");

  await runBuild(appDir, signal);
  onLog("Publishing local preview — static export built.");

  if (verifyExport) {
    let missing = await verifyExport(appDir);
    if (missing.length) {
      onLog(
        `Publishing local preview — export missing ${missing.length} route(s) (${missing.join(", ")}), waiting 30s and re-checking…`,
      );
      await new Promise((r) => setTimeout(r, EXPORT_RETRY_DELAY_MS));
      missing = await verifyExport(appDir);
    }
    if (missing.length) {
      onLog(`Publishing local preview — still missing ${missing.join(", ")}, re-running export…`);
      await runBuild(appDir, signal);
      missing = await verifyExport(appDir);
    }
    if (missing.length) {
      throw new Error(`Publishing local preview failed: export is missing route(s): ${missing.join(", ")}`);
    }
  }

  if (signal?.aborted) throw new Error("Publishing local preview stopped by user before the preview server started.");

  if (hosted()) {
    const previewPath = previewPathFor(appDir);
    const basePath = previewPath.slice(0, -1); // strip the trailing slash next.config.ts's basePath must not carry
    const changed = rebaseExport(path.join(appDir, "out"), basePath);
    onLog(`Publishing local preview — rebased ${changed} file(s) to ${previewPath}`);
    onLog(`Publishing local preview — hosted mode, served by nginx at ${previewPath}`);
    return previewPath;
  }

  const pidFile = path.join(appDir, PID_NAME);
  if (existsSync(pidFile)) {
    const old = readPidFile(pidFile);
    if (old && isAlive(old.pgid)) {
      try {
        killGroup(old.pgid);
      } catch {
        // already gone
      }
    }
    rmSync(pidFile, { force: true });
  }

  const port = await freePort(4321);
  const child = spawn("npx", ["serve", "out", "-l", String(port)], {
    cwd: appDir,
    detached: true,
    stdio: "ignore",
    signal,
  });
  // The signal option only kills the immediate "npx" pid; the detached group's "serve"
  // process needs the same negative-pid teardown as the pid-file path above.
  if (signal) {
    const killOnAbort = () => {
      if (child.pid) {
        try {
          killGroup(child.pid);
        } catch {
          // already gone
        }
      }
    };
    if (signal.aborted) killOnAbort();
    else signal.addEventListener("abort", killOnAbort, { once: true });
  }
  let spawnSettled = false;
  await new Promise<void>((resolve, reject) => {
    child.on("error", (err) => {
      if (spawnSettled) {
        onLog(`Publishing local preview — preview server error after start: ${err.message}`);
        return;
      }
      spawnSettled = true;
      if (err.name === "AbortError") {
        reject(new Error("Publishing local preview stopped by user before the preview server started."));
      } else {
        reject(new Error(`Publishing local preview failed: could not start "npx serve" — ${err.message}`));
      }
    });
    child.once("spawn", () => {
      spawnSettled = true;
      resolve();
    });
  });
  child.unref();
  if (!child.pid) {
    throw new Error("Publishing local preview failed: spawned preview server has no pid.");
  }
  writeFileSync(pidFile, JSON.stringify({ pgid: child.pid, port, startedAt: new Date().toISOString() }));

  const url = `http://localhost:${port}`;
  await waitFor200(`${url}/`, 15000);
  onLog(`Publishing local preview — published at ${url}`);
  return url;
}

if (process.argv[2] === "stop") {
  let stopped = 0;
  for (const p of listPreviews()) {
    if (stopPreview(p.domain)) {
      console.log(`stopped preview for ${p.domain} (pgid ${p.pgid})`);
      stopped++;
    } else {
      console.log(`failed to kill pgid ${p.pgid} for ${p.domain}`);
    }
  }
  if (stopped === 0) console.log("no live previews found");
}
