/**
 * Serving a test Worker on plain workerd, for the tests of the on-prem
 * services (workerd-d1.test.ts, workerd-r2.test.ts): temporary directories,
 * a free port, and a workerd that answers on it.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const workerdBinary = path.join(
  import.meta.dirname,
  "../node_modules/.bin/workerd"
);
const STARTUP_ATTEMPTS = 100;
const STARTUP_RETRY_MS = 50;

const temporary: string[] = [];
const running: ChildProcess[] = [];

/** A new directory, removed by `cleanUp`. */
export const tempDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "grasp-os-workerd-test-"));
  temporary.push(dir);
  return dir;
};

/** A new directory for Durable Object storage, outliving any one workerd. */
export const storageDir = (): string => {
  const dir = path.join(tempDir(), "storage");
  mkdirSync(dir);
  return dir;
};

/** Stops every workerd still running and removes every temporary directory. */
export const cleanUp = (): void => {
  for (const workerd of running.splice(0)) {
    workerd.kill();
  }
  for (const dir of temporary.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
};

const freePort = async (): Promise<number> => {
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  probe.close();
  await once(probe, "close");
  if (address === null || typeof address === "string") {
    throw new Error("no free port");
  }
  return address.port;
};

const waitUntilServing = async (
  url: string,
  workerd: ChildProcess,
  stderr: () => string,
  attempt = 0
): Promise<void> => {
  if (workerd.exitCode !== null) {
    throw new Error(`workerd exited (${workerd.exitCode}): ${stderr()}`);
  }
  if (attempt >= STARTUP_ATTEMPTS) {
    throw new Error(`workerd did not start: ${stderr()}`);
  }
  try {
    await fetch(url, { method: "POST", body: "[]" });
  } catch {
    await sleep(STARTUP_RETRY_MS);
    await waitUntilServing(url, workerd, stderr, attempt + 1);
  }
};

/** A workerd serving a test Worker. */
export interface Served {
  /** Where the test Worker answers. */
  url: string;
  stop: () => Promise<void>;
  /** Kills workerd at once (SIGKILL), as a crash would, mid-request too. */
  kill: () => Promise<void>;
}

/**
 * Serves the config `configFor` writes for a socket address, from `out`,
 * once its socket answers.
 */
export const serveOnWorkerd = async (
  out: string,
  configFor: (address: string) => string
): Promise<Served> => {
  const address = `127.0.0.1:${await freePort()}`;
  writeFileSync(path.join(out, "config.capnp"), configFor(address));
  const workerd = spawn(
    workerdBinary,
    ["serve", path.join(out, "config.capnp")],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  running.push(workerd);
  // What workerd says when it can't start: a startup failure names it.
  let stderr = "";
  workerd.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const url = `http://${address}/`;
  await waitUntilServing(url, workerd, () => stderr);
  return {
    url,
    stop: async () => {
      workerd.kill();
      await once(workerd, "exit");
    },
    kill: async () => {
      workerd.kill("SIGKILL");
      await once(workerd, "exit");
    },
  };
};
