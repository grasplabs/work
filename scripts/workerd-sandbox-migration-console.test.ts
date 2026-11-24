/**
 * A migration's transform logging a record's values on the on-prem
 * sandbox, on plain workerd: a stand-in core (apps/core/test/workerd/
 * migration-console-worker.ts) runs a batch in the isolate core runs it in,
 * with `SANDBOX_HOST` bound to the supervisor, run on its own as on-prem
 * runs it (workerd-sandbox.ts). Its processes print an isolate's console to
 * the supervisor's own output, the deployment's logs, so that is what is
 * read here: no record value may reach it. Since GRA-776 the sandbox host
 * silences every isolate, so another isolate's log doesn't reach it
 * either; the supervisor's own lines show the output is read at all
 * (workerd-sandbox-console.test.ts has the rest).
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { serveStandIn } from "./workerd-stand-in.ts";
import { cleanUp } from "./workerd-test-server.ts";

/** How long the supervisor may take to say where it listens. */
const START_MS = 30_000;

/** How long an isolate's last log may take to come through. */
const SETTLE_MS = 500;

const listeningSchema = z.object({
  event: z.literal("sandbox.listening"),
  socket: z.string(),
});

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

describe("a migration's transform on the on-prem sandbox", () => {
  let supervisor: ChildProcess;
  let output = "";
  let coreUrl: string;

  beforeAll(async () => {
    supervisor = spawn(
      process.execPath,
      [path.join(import.meta.dirname, "workerd-sandbox.ts"), "--processes=1"],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    const read = (chunk: Buffer) => {
      output += chunk.toString();
    };
    supervisor.stdout?.on("data", read);
    supervisor.stderr?.on("data", read);
    const socket = await socketOf(supervisor, () => output);
    coreUrl = await serveStandIn("migration-console-worker.ts", socket);
  }, 180_000);

  afterAll(async () => {
    if (supervisor.exitCode === null) {
      supervisor.kill("SIGTERM");
      await once(supervisor, "exit");
    }
    cleanUp();
  });

  it("leaves no record value in the logs, however it logs", async () => {
    const response = await fetch(`${coreUrl}run`);
    const ran = z
      .object({
        transformed: z.string(),
        logged: z.string(),
        recordValue: z.string(),
        controlValue: z.string(),
      })
      .parse(await response.json());
    await sleep(SETTLE_MS);

    expect({
      answered: ran.transformed.includes(ran.recordValue),
      logged: ran.logged,
      read: output.includes("sandbox.listening"),
      control: output.includes(ran.controlValue),
      record: output.includes(ran.recordValue),
    }).toStrictEqual({
      answered: true,
      logged: "logged",
      read: true,
      control: false,
      record: false,
    });
  });
});
