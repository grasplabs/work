/**
 * On-prem smoke run: bundles core and serves it on plain workerd (no
 * Wrangler, no Miniflare), checks it answers, and waits for its built-in
 * content to install: it fails on any failure core or workerd logs before
 * that. Keeps the code on-prem ready: only platform APIs that also run on
 * workerd.
 */
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

import { routerSecretHeader } from "../packages/shared/src/router.ts";
import { d1DatabasesOf, writeD1Service } from "./workerd-d1.ts";
import { coreWranglerConfig, smokeConfig } from "./workerd-smoke-config.ts";
import { coreStarted, installedOnWorkerd } from "./workerd-smoke-start.ts";
import type { KnownGap } from "./workerd-smoke-start.ts";

const ROUTER_SECRET = "smoke-router-secret";
const ATTEMPTS = 50;
const RETRY_DELAY_MS = 100;
const INSTALL_TIMEOUT_MS = 120_000;

/**
 * What the on-prem profile can't do yet, so the install can't complete:
 * each excuses exactly its own failure, and the run says so. Remove one
 * once its gap is closed; the install must then be complete.
 */
const knownGaps: KnownGap[] = [
  {
    event: "builtins.blueprint_failed",
    errorMessage: "Cannot read properties of undefined (reading 'put')",
    why: "FILES (R2) has no on-prem service yet, so no built-in blueprint installs (GRA-446)",
  },
];
const core = path.join(import.meta.dirname, "../apps/core");
const out = mkdtempSync(path.join(tmpdir(), "grasp-os-workerd-"));

// The same build core's deploy runs, so the bundle below is what ships.
execFileSync("vp", ["run", "build"], { cwd: core, stdio: "inherit" });
execFileSync("wrangler", ["deploy", "--dry-run", "--outdir", out], {
  cwd: core,
  stdio: "inherit",
});

// A port nothing listens on now, picked by the OS and closed again for
// workerd to take, so no other server answers the health check.
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

// Durable Object migrations and the Grasp skills are bundled next to
// index.js as text modules.
const textModule = /(?:\.sql|SKILL\.md)$/u;
const modules = [
  `(name = "index.js", esModule = embed "index.js")`,
  ...readdirSync(out)
    .filter((file) => textModule.test(file))
    .map((file) => `(name = "${file}", text = embed "${file}")`),
];

// The on-prem profile's D1 service, and core's D1 migrations for it.
writeD1Service(out, d1DatabasesOf(coreWranglerConfig));

// Durable Objects keep their SQLite databases on disk, as on-prem. Removed
// with the rest of `out`.
const storage = path.join(out, "storage");
mkdirSync(storage);

writeFileSync(
  path.join(out, "config.capnp"),
  smokeConfig({ port: PORT, routerSecret: ROUTER_SECRET, modules, storage })
);

const server = spawn("workerd", ["serve", path.join(out, "config.capnp")], {
  stdio: ["ignore", "pipe", "pipe"],
});

// Everything workerd writes, line by line, both shown and checked.
const output = new PassThrough();
for (const stream of [server.stdout, server.stderr]) {
  createInterface({ input: stream }).on("line", (line) => {
    console.info(line);
    output.write(`${line}\n`);
  });
}
const lines = createInterface({ input: output })[Symbol.asyncIterator]();

try {
  await coreStarted(server, {
    url: `http://127.0.0.1:${PORT}/health`,
    headers: { [routerSecretHeader]: ROUTER_SECRET },
    fetch,
    attempts: ATTEMPTS,
    retryDelayMs: RETRY_DELAY_MS,
  });
  const excused = await installedOnWorkerd(
    server,
    { [Symbol.asyncIterator]: () => lines },
    knownGaps,
    INSTALL_TIMEOUT_MS
  );
  for (const { why } of excused) {
    console.warn(`known on-prem gap: ${why}`);
  }
  console.info(
    excused.length === 0
      ? "core runs on workerd, and its built-in content installed"
      : "core runs on workerd, and its built-in content installed but for the known gaps above"
  );
} finally {
  server.kill();
  rmSync(out, { force: true, recursive: true });
}
