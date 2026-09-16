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

  const pidFile = path.join(appDir, PID_NAME);
  if (existsSync(pidFile)) {
    const oldPgid = Number(readFileSync(pidFile, "utf8").trim());
    if (oldPgid && isAlive(oldPgid)) {
      try {
        killGroup(oldPgid);
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
  writeFileSync(pidFile, String(child.pid));

  const url = `http://localhost:${port}`;
  await waitFor200(`${url}/`, 15000);
  onLog(`Publishing local preview — published at ${url}`);
  return url;
}

if (process.argv[2] === "stop") {
  const sitesDir = path.join(process.cwd(), "sites");
  let stopped = 0;
  if (existsSync(sitesDir)) {
    for (const site of readdirSync(sitesDir)) {
      const pidFile = path.join(sitesDir, site, "app", PID_NAME);
      if (!existsSync(pidFile)) continue;
      const pgid = Number(readFileSync(pidFile, "utf8").trim());
      if (pgid && isAlive(pgid)) {
        try {
          killGroup(pgid);
          console.log(`stopped preview for ${site} (pgid ${pgid})`);
          stopped++;
        } catch (e) {
          console.log(`failed to kill pgid ${pgid} for ${site}: ${e}`);
        }
      }
      rmSync(pidFile, { force: true });
    }
  }
  if (stopped === 0) console.log("no live previews found");
}
