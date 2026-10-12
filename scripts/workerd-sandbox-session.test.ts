/**
 * Sessions on the on-prem sandbox, on plain workerd: a stand-in core
 * (apps/core/test/workerd/session-worker.ts) runs the same `runInSession`
 * core runs, with `SANDBOX_HOST` bound to the supervisor
 * (workerd-sandbox.ts), and passes capabilities of its own into isolates
 * that reach back through them. No Wrangler dev server, no Miniflare.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { nativeWorkerd, startSandboxSupervisor } from "./workerd-sandbox.ts";
import type { SandboxSupervisor } from "./workerd-sandbox.ts";
import { cleanUp, serveOnWorkerd, tempDir } from "./workerd-test-server.ts";

const repo = path.join(import.meta.dirname, "..");
const core = path.join(repo, "apps/core");

/** How long core may take to answer another request meanwhile. */
const ANSWER_MS = 500;

const outcomeSchema = z.object({
  status: z.enum(["ok", "refused", "unavailable"]),
  value: z.unknown().optional(),
  message: z.string().optional(),
  ms: z.number(),
  reachedAfter: z.number(),
  reachedInternal: z.number(),
  logged: z.array(z.unknown()),
});

/**
 * The stand-in core bundled into `out` as core's own deploy bundles, by
 * Wrangler's dry run, as capnp module entries for a config in `out`.
 */
const bundle = (out: string): string[] => {
  const config = path.join(out, "wrangler.jsonc");
  writeFileSync(
    config,
    JSON.stringify({
      name: "session-test",
      main: path.join(core, "test/workerd/session-worker.ts"),
      compatibility_date: "2026-09-15",
      compatibility_flags: ["nodejs_compat"],
    })
  );
  const bundled = path.join(out, "bundle");
  execFileSync(
    path.join(repo, "node_modules/.bin/wrangler"),
    ["deploy", "--dry-run", "--outdir", bundled, "--config", config],
    { cwd: core, stdio: "ignore" }
  );
  return [
    `(name = "worker.js", esModule = embed "bundle/session-worker.js")`,
    ...readdirSync(bundled)
      .filter((file) => file.endsWith(".sql"))
      .map((file) => `(name = "${file}", text = embed "bundle/${file}")`),
  ];
};

describe("a session on the on-prem sandbox", () => {
  let supervisor: SandboxSupervisor;
  let coreUrl: string;

  beforeAll(async () => {
    supervisor = await startSandboxSupervisor({
      workerd: nativeWorkerd,
      processes: 2,
      log: () => {},
    });
    const out = tempDir();
    const modules = bundle(out);
    const served = await serveOnWorkerd(
      out,
      (address) => `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "core", worker = .core),
    (name = "sandbox", external = (address = "unix:${supervisor.socket}", http = ())),
  ],
  sockets = [(name = "http", address = "${address}", http = (), service = "core")],
);

const core :Workerd.Worker = (
  modules = [${modules.join(", ")}],
  compatibilityDate = "2026-09-15",
  compatibilityFlags = ["nodejs_compat"],
  bindings = [
    (name = "RUNTIME_PROFILE", text = "workerd"),
    (name = "SANDBOX_HOST", service = "sandbox"),
  ],
);
`
    );
    coreUrl = served.url;
  }, 120_000);

  afterAll(async () => {
    await supervisor.stop();
    cleanUp();
  });

  const run = async (name: string) => {
    const response = await fetch(`${coreUrl}run?case=${name}`);
    return outcomeSchema.parse(await response.json());
  };

  /** How long core takes to answer a request that runs no App code. */
  const answerTime = async (): Promise<number> => {
    const started = Date.now();
    const response = await fetch(coreUrl, {
      signal: AbortSignal.timeout(2000),
    });
    await response.text();
    return Date.now() - started;
  };

  it("hands the isolate core's capabilities, as objects and functions, with callbacks both ways and an empty env", async () => {
    const outcome = await run("capabilities");
    expect(outcome).toMatchObject({
      status: "ok",
      value: { a: 101, b: 41, c: 102, env: [] },
      logged: ["started"],
    });
  });

  it("ends a busy loop on its CPU-time budget while core keeps answering", async () => {
    const busy = run("busy");
    const answers: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one after another, during the loop
      answers.push(await answerTime());
    }
    const outcome = await busy;
    expect(outcome.status).toBe("refused");
    expect(outcome.message).toContain("CPU time");
    // Its 500 ms of CPU, read every 100 ms, well before its wall-clock cap.
    expect(outcome.ms).toBeLessThan(3000);
    expect(Math.max(...answers)).toBeLessThan(ANSWER_MS);
    expect(supervisor.stats().cpu).toBeGreaterThanOrEqual(1);
  });

  it("doesn't count time spent waiting on core against the CPU budget", async () => {
    await expect(run("waits")).resolves.toMatchObject({
      status: "ok",
      value: "slow",
    });
  });

  it("ends a call past its wall-clock cap", async () => {
    const outcome = await run("wallClock");
    expect(outcome.status).toBe("refused");
    expect(outcome.message).toContain("ran past its time");
  });

  it("refuses a capability used after its call is over", async () => {
    const outcome = await run("replay");
    expect(outcome).toMatchObject({ status: "ok", value: "returned" });
    expect(outcome.reachedAfter).toBe(0);
  });

  it("gives the isolate only the methods core named", async () => {
    const outcome = await run("undeclared");
    expect(outcome.status).toBe("refused");
    // Refused in the isolate: its capability has no such method at all.
    expect(outcome.message).toContain(
      'does not implement the method "internal"'
    );
    expect(outcome.reachedInternal).toBe(0);
  });

  it("passes on what the isolate threw, as the App's", async () => {
    await expect(run("throws")).resolves.toMatchObject({
      status: "refused",
      message: "an App error",
    });
  });

  it("gives the isolate no network", async () => {
    const outcome = await run("network");
    expect(outcome.status).toBe("refused");
    expect(outcome.message).toContain("not permitted to access the internet");
  });

  it("says the sandbox is unavailable, not the App's fault, when the supervisor is gone", async () => {
    await supervisor.stop();
    await expect(run("capabilities")).resolves.toMatchObject({
      status: "unavailable",
    });
  });
});
