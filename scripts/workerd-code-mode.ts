/**
 * Code Mode on plain workerd: bundles the executor core runs
 * (apps/core/src/code-mode.ts) into a small Worker
 * (apps/core/test/workerd/code-mode-worker.ts), serves it on plain workerd
 * with a Worker Loader (no Wrangler, no Miniflare), and checks every case
 * ends as it does in core: the module contract, its failures, the limits,
 * cancellation, streamed output and the output budget.
 *
 * Plain workerd enforces no CPU limit on a loaded Worker, and its runs
 * record `cpu_limit_unsupported`. Worse than unbounded: a synchronous busy
 * loop holds the thread the host's own wall-clock timer would fire on, so
 * no case here runs one. The CPU limit is proven on the deployed profile.
 */
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { z } from "zod";

const ATTEMPTS = 100;
const RETRY_DELAY_MS = 100;
const out = mkdtempSync(path.join(tmpdir(), "grasp-os-code-mode-"));
const worker = path.join(
  import.meta.dirname,
  "../apps/core/test/workerd/code-mode-worker.ts"
);

execFileSync(
  "esbuild",
  [
    worker,
    "--bundle",
    "--format=esm",
    "--platform=neutral",
    "--main-fields=module,main",
    "--external:cloudflare:*",
    `--outfile=${path.join(out, "worker.js")}`,
  ],
  { stdio: "inherit" }
);

const freePort = async (): Promise<number> => {
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  probe.close();
  await once(probe, "close");
  if (address === null || typeof address === "string") {
    throw new Error("no free port for workerd");
  }
  return address.port;
};
const PORT = await freePort();

writeFileSync(
  path.join(out, "config.capnp"),
  `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [(name = "main", worker = .main)],
  sockets = [(name = "http", address = "127.0.0.1:${PORT}", http = (), service = "main")],
);

const main :Workerd.Worker = (
  modules = [(name = "worker.js", esModule = embed "worker.js")],
  compatibilityDate = "2026-09-15",
  bindings = [(name = "LOADER", workerLoader = ())],
);
`
);

/** What each case must come to, and the runtime the run records. */
const expected = {
  runtime: {
    runtime: "workerd",
    cpuLimit: "cpu_limit_unsupported",
  },
  calls: 2,
  statuses: {
    complete: "completed",
    network: "threw",
    syntax: "load_failed",
    notAFunction: "load_failed",
    throwsAsItLoads: "load_failed",
    throws: "threw",
    oversized: "refused",
    neverSettles: "wall_expired",
    waitsPastItsTime: "wall_expired",
    cancelled: "cancelled",
    flood: "threw",
  },
};

/** What the Worker answers: the runtime, capability calls, each case. */
const answerSchema = z.object({
  runtime: z.record(z.string(), z.string()),
  calls: z.number(),
  results: z.record(
    z.string(),
    z.object({
      status: z.string(),
      text: z.string(),
      bytes: z.number(),
      cut: z.boolean(),
      streamed: z.number(),
    })
  ),
});

const server = spawn(
  "workerd",
  ["serve", "--experimental", path.join(out, "config.capnp")],
  { stdio: "inherit" }
);

const fetchResults = async (): Promise<z.infer<typeof answerSchema>> => {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`workerd exited with ${server.exitCode}`);
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- polled until workerd answers
      const response = await fetch(`http://127.0.0.1:${PORT}/`);
      // oxlint-disable-next-line no-await-in-loop -- the one answer
      return answerSchema.parse(await response.json());
    } catch {
      // oxlint-disable-next-line no-await-in-loop -- polled until workerd answers
      await sleep(RETRY_DELAY_MS);
    }
  }
  throw new Error("workerd never answered");
};

try {
  const { runtime, calls, results } = await fetchResults();
  const problems: string[] = [];
  for (const [name, status] of Object.entries(expected.statuses)) {
    if (results[name]?.status !== status) {
      problems.push(
        `${name}: ${results[name]?.status ?? "missing"} (${results[name]?.text ?? ""}), expected ${status}`
      );
    }
  }
  if (calls !== expected.calls) {
    problems.push(`capability calls: ${calls}, expected ${expected.calls}`);
  }
  if (
    runtime.runtime !== expected.runtime.runtime ||
    runtime.cpuLimit !== expected.runtime.cpuLimit
  ) {
    problems.push(`runtime: ${JSON.stringify(runtime)}`);
  }
  const { complete, flood, throwsAsItLoads } = results;
  if (
    complete?.text !== 'Returned:\n{"self":null,"ctx":["waitUntil"],"sum":6}'
  ) {
    problems.push(`complete: ${complete?.text}`);
  }
  if (!(throwsAsItLoads?.text.startsWith("Logs:\nloading") ?? false)) {
    problems.push(`throwsAsItLoads kept no log: ${throwsAsItLoads?.text}`);
  }
  if (
    flood === undefined ||
    flood.bytes > 64 * 1024 ||
    !flood.cut ||
    flood.streamed === 0
  ) {
    problems.push(`flood: ${JSON.stringify(flood)}`);
  }
  if (problems.length > 0) {
    throw new Error(`Code Mode on plain workerd:\n${problems.join("\n")}`);
  }
  console.info(
    `Code Mode runs on plain workerd: ${Object.keys(expected.statuses).length} cases (${JSON.stringify(runtime)})`
  );
} finally {
  server.kill();
  rmSync(out, { force: true, recursive: true });
}
