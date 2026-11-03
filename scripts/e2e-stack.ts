/**
 * `vp run e2e:stack`: the e2e stack (playwright.config.ts's `webServer`:
 * core with connect, the fake AI providers and the fake IdP), started from
 * empty state as a plain `vp run e2e` starts it, then left running. Runs
 * with `GRASP_E2E_REUSE=1` use it instead of building and starting their
 * own (`reuseStack`), so running a file again takes its tests' time alone,
 * not the stack's few minutes too. Start it again for a fresh stack, which
 * the serial projects (onboarding, interview, journeys) need. When one of
 * them stops, or this script is stopped, all of them stop.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { connect } from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { origin } from "../e2e/stack.ts";
import config from "../playwright.config.ts";

const root = path.join(import.meta.dirname, "..");

const servers = [config.webServer ?? []].flat();

/**
 * Each server runs its command in a process group of its own, from the
 * repository's root as Playwright runs it, so stopping it stops what it
 * started too (wrangler's workerd).
 */
const children: ChildProcess[] = servers.map(({ command, env }) =>
  spawn("sh", ["-c", command], {
    cwd: root,
    stdio: "inherit",
    detached: true,
    env: { ...process.env, ...env },
  })
);

/** How long a stopped process group gets to finish before it's killed. */
const killAfterMs = 5000;

/** Set once everything is being stopped: exits from then on are expected. */
let stopping = false;
let killTimer: NodeJS.Timeout | undefined;
let running = children.length;

const signalAll = (signal: NodeJS.Signals): void => {
  for (const { pid } of children) {
    if (pid !== undefined) {
      try {
        process.kill(-pid, signal);
      } catch {
        // The group is already gone.
      }
    }
  }
};

/** Kills whatever is left at once, grandchildren that outlived theirs too. */
const killAll = (): void => {
  clearTimeout(killTimer);
  signalAll("SIGKILL");
};

/** Asks every group to stop, and kills them if they haven't in time. */
const stopAll = (): void => {
  if (stopping) {
    return;
  }
  stopping = true;
  signalAll("SIGTERM");
  killTimer = setTimeout(killAll, killAfterMs);
};

/**
 * One that stops by itself fails the whole with its code, or 1 when a
 * signal from elsewhere ended it; the rest, stopped here, don't count, so
 * a clean Ctrl+C exits 0.
 */
const exited = (code: number | null): void => {
  running -= 1;
  if (!stopping) {
    process.exitCode = code ?? 1;
  }
  stopAll();
  if (running === 0) {
    killAll();
  }
};

/** The first Ctrl+C stops everything; a second one kills it at once. */
const interrupted = (): void => {
  if (stopping) {
    killAll();
  } else {
    stopAll();
  }
};

for (const child of children) {
  child.on("error", (error) => {
    console.error(`An e2e server failed to start: ${error.message}`);
    process.exitCode = 1;
    stopAll();
  });
  child.on("exit", exited);
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, interrupted);
}

/** Whether something accepts connections on `port` on this machine. */
const listening = async (port: number): Promise<boolean> => {
  const answer = Promise.withResolvers<boolean>();
  const socket = connect({ port, host: "localhost" });
  socket.once("connect", () => {
    socket.destroy();
    answer.resolve(true);
  });
  socket.once("error", () => {
    answer.resolve(false);
  });
  return await answer.promise;
};

/** How often a port is tried while its server starts. */
const pollMs = 500;

/**
 * Waits until every server listens on its port, within the time the config
 * gives it, as Playwright waits; stops them all when one doesn't.
 */
const ready = async (): Promise<boolean> => {
  const started = Date.now();
  for (const { port, timeout = 60_000 } of servers) {
    if (port !== undefined) {
      // oxlint-disable-next-line no-await-in-loop -- one port at a time
      while (!(await listening(port))) {
        if (stopping || Date.now() - started > timeout) {
          return false;
        }
        // oxlint-disable-next-line no-await-in-loop -- polling until it's up
        await sleep(pollMs);
      }
    }
  }
  return true;
};

if (await ready()) {
  console.log(
    `\nThe e2e stack is up at ${origin}. In another terminal:\n` +
      "  GRASP_E2E_REUSE=1 vp run e2e --project=chromium e2e/<file>.e2e.ts\n" +
      "Stop it with Ctrl+C.\n"
  );
} else if (!stopping) {
  console.error("The e2e stack didn't come up in time.");
  process.exitCode = 1;
  stopAll();
}
