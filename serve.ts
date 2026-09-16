import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

const PID_NAME = "serve.pid";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

export async function publishPreview(appDir: string, onLog: (line: string) => void): Promise<string> {
  onLog("Building static export…");
  const build = await new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn("npx", ["next", "build"], { cwd: appDir });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    child.on("close", (code) => resolve({ code, output }));
  });
  if (build.code !== 0) {
    throw new Error(`next build failed:\n${build.output.split("\n").slice(-40).join("\n")}`);
  }
  onLog("Static export built.");

  const pidFile = path.join(appDir, PID_NAME);
  if (existsSync(pidFile)) {
    const oldPid = Number(readFileSync(pidFile, "utf8").trim());
    if (oldPid && isAlive(oldPid)) {
      try {
        process.kill(oldPid);
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
  });
  child.unref();
  writeFileSync(pidFile, String(child.pid));

  const url = `http://localhost:${port}`;
  await waitFor200(`${url}/`, 15000);
  onLog(`Preview published at ${url}`);
  return url;
}

if (process.argv[2] === "stop") {
  const sitesDir = path.join(process.cwd(), "sites");
  let stopped = 0;
  if (existsSync(sitesDir)) {
    for (const site of readdirSync(sitesDir)) {
      const pidFile = path.join(sitesDir, site, "app", PID_NAME);
      if (!existsSync(pidFile)) continue;
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      if (pid && isAlive(pid)) {
        try {
          process.kill(pid);
          console.log(`stopped preview for ${site} (pid ${pid})`);
          stopped++;
        } catch (e) {
          console.log(`failed to kill pid ${pid} for ${site}: ${e}`);
        }
      }
      rmSync(pidFile, { force: true });
    }
  }
  if (stopped === 0) console.log("no live previews found");
}
