/**
 * What isolates on the on-prem sandbox print, on plain workerd (GRA-776):
 * nothing, as on Cloudflare, where a Loader isolate's output is dropped.
 *
 * - Through the supervisor, run on its own as on-prem runs it
 *   (workerd-sandbox.ts), with its output, the deployment's logs, read: a
 *   stand-in core (apps/core/test/workerd/isolate-console-worker.ts) runs
 *   an isolate each way core runs one there, as a call and as a session.
 *   Each logs what it holds every way it can and answers with it; the
 *   answer carries it, the output never does.
 * - The supervisor refuses `--verbose`, and every other option it doesn't
 *   take, by name.
 * - On a workerd served `--verbose`, which prints an isolate's uncaught
 *   errors with their message (apps/core/test/workerd/
 *   quiet-isolate-worker.ts): the same isolate loaded as it is prints its
 *   value, the control that shows workerd's output is read; loaded as the
 *   sandbox host loads it, nothing.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { bundle, serveStandIn } from "./workerd-stand-in.ts";
import { cleanUp, serveOnWorkerd, tempDir } from "./workerd-test-server.ts";
import type { Served } from "./workerd-test-server.ts";

/** How long the supervisor may take to say where it listens. */
const START_MS = 30_000;

/** How long an isolate's last output may take to come through. */
const SETTLE_MS = 500;

const supervisorScript = path.join(import.meta.dirname, "workerd-sandbox.ts");

const listeningSchema = z.object({
  event: z.literal("sandbox.listening"),
  socket: z.string(),
});

const ranSchema = z.object({ answered: z.unknown(), value: z.string() });

/** `line` as JSON, or null when it isn't. */
const jsonOf = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

/** Where the supervisor `child` listens, from the line saying so. */
const socketOf = async (child: ChildProcess, output: () => string) => {
  const deadline = Date.now() + START_MS;
  while (Date.now() < deadline) {
    // Whole lines only: the last may still be coming in.
    for (const line of output().split("\n").slice(0, -1)) {
      const parsed = listeningSchema.safeParse(jsonOf(line));
      if (parsed.success) {
        return parsed.data.socket;
      }
    }
    if (child.exitCode !== null) {
      break;
    }
    // oxlint-disable-next-line no-await-in-loop -- polling its output
    await sleep(50);
  }
  throw new Error(`The supervisor didn't start: ${output()}`);
};

/** Spawns the supervisor with `args`, its stdout and stderr read into one. */
const supervisorWith = (args: string[]) => {
  const child = spawn(process.execPath, [supervisorScript, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const read = (chunk: Buffer) => {
    output += chunk.toString();
  };
  child.stdout.on("data", read);
  child.stderr.on("data", read);
  return { child, output: () => output };
};

describe("isolates on the on-prem sandbox", () => {
  let supervisor: ReturnType<typeof supervisorWith>;
  let coreUrl: string;

  beforeAll(async () => {
    supervisor = supervisorWith(["--processes=2"]);
    const socket = await socketOf(supervisor.child, supervisor.output);
    coreUrl = await serveStandIn("isolate-console-worker.ts", socket);
  }, 180_000);

  afterAll(async () => {
    if (supervisor.child.exitCode === null) {
      supervisor.child.kill("SIGTERM");
      await once(supervisor.child, "exit");
    }
    cleanUp();
  });

  it.each([
    ["a call", "call"],
    ["a session that reaches back into core", "session"],
  ])(
    "print nothing of what they log to the deployment's logs, run as %s",
    async (_case, route) => {
      const response = await fetch(`${coreUrl}${route}`);
      const ran = ranSchema.parse(await response.json());
      await sleep(SETTLE_MS);

      expect({
        answered: ran.answered,
        // The supervisor's own lines come through, so its output is read.
        read: supervisor.output().includes("sandbox.listening"),
        logged: supervisor.output().includes(ran.value),
      }).toStrictEqual({ answered: ran.value, read: true, logged: false });
    }
  );
});

describe("the on-prem sandbox supervisor", () => {
  it.each([["--verbose"], ["--processes=1", "--verbose"], ["--debug"]])(
    "refuses an option it doesn't take, by name: %s",
    async (...args) => {
      const { child, output } = supervisorWith(args);
      await once(child, "exit");
      const code = child.exitCode;
      const said = output()
        .split("\n")
        .map((line) => jsonOf(line))
        .find(
          (line) =>
            typeof line === "object" &&
            line !== null &&
            Reflect.get(line, "event") === "sandbox.failed_to_start"
        );
      const { error } = z.object({ error: z.string() }).parse(said);
      expect({
        code,
        named: args.some(
          (arg) =>
            arg.startsWith("--") && !arg.includes("=") && error.includes(arg)
        ),
        listened: output().includes("sandbox.listening"),
      }).toStrictEqual({ code: 1, named: true, listened: false });
    },
    60_000
  );
});

describe("an isolate the sandbox host loads, on a workerd served --verbose", () => {
  let served: Served;

  beforeAll(async () => {
    const out = tempDir();
    const modules = bundle(out, "quiet-isolate-worker.ts");
    served = await serveOnWorkerd(
      out,
      (address) => `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [(name = "host", worker = .host)],
  sockets = [(name = "http", address = "${address}", http = (), service = "host")],
);

const host :Workerd.Worker = (
  modules = [${modules.join(", ")}],
  compatibilityDate = "2026-09-15",
  compatibilityFlags = ["nodejs_compat"],
  bindings = [(name = "LOADER", workerLoader = ())],
);
`,
      // The loader is experimental in workerd; an isolate's uncaught error
      // is printed at info level only.
      ["--experimental", "--verbose"]
    );
  }, 120_000);

  afterAll(() => {
    cleanUp();
  });

  it("prints nothing of what it logs or leaves uncaught, where the same isolate loaded as it is does", async () => {
    const run = async (route: string) => {
      const response = await fetch(new URL(route, served.url));
      return ranSchema.parse(await response.json());
    };
    const loud = await run("/loud");
    const quiet = await run("/quiet");
    await sleep(SETTLE_MS);

    expect({
      answered: [loud.answered, quiet.answered],
      loud: served.logs().includes(loud.value),
      quiet: served.logs().includes(quiet.value),
    }).toStrictEqual({
      answered: [loud.value, quiet.value],
      loud: true,
      quiet: false,
    });
  });
});
