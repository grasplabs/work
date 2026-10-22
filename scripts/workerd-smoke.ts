/**
 * On-prem smoke run: bundles core and serves it on plain workerd (no
 * Wrangler, no Miniflare), checks it answers, and waits for its built-in
 * content to install: it fails on any failure core or workerd logs before
 * that. Then someone signs in, seals an App and calls one of its functions,
 * which runs on the sandbox host (workerd-smoke-sealed.ts). Keeps the code
 * on-prem ready: only platform APIs that also run on workerd.
 */
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
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

import { localSignIn } from "../apps/core/test/sign-in-config.ts";
import { routerSecretHeader } from "../packages/shared/src/router.ts";
import { d1DatabasesOf, writeD1Service } from "./workerd-d1.ts";
import { writeR2Service } from "./workerd-r2.ts";
import { nativeWorkerd, startSandboxSupervisor } from "./workerd-sandbox.ts";
import type { SandboxSupervisor } from "./workerd-sandbox.ts";
import {
  assetsWorkerSource,
  coreWranglerConfig,
  smokeConfig,
} from "./workerd-smoke-config.ts";
import { sealedCallOnWorkerd } from "./workerd-smoke-sealed.ts";
import { coreStarted, installedOnWorkerd } from "./workerd-smoke-start.ts";
import type { KnownGap } from "./workerd-smoke-start.ts";
import { tapSocket } from "./workerd-socket-tap.ts";
import type { SocketTap } from "./workerd-socket-tap.ts";

const ROUTER_SECRET = "smoke-router-secret";
const ATTEMPTS = 50;
const RETRY_DELAY_MS = 100;
const INSTALL_TIMEOUT_MS = 120_000;

/**
 * What the on-prem profile can't do yet, so the install can't complete:
 * each would excuse exactly its own failure (its event, error and the
 * function that threw it), and the run says so. None now: the install must
 * be complete.
 */
const knownGaps: KnownGap[] = [];
const core = path.join(import.meta.dirname, "../apps/core");
const out = mkdtempSync(path.join(tmpdir(), "grasp-os-workerd-"));
/** Where core's build puts the assets a seal reads (the compiler, SDK, kit). */
const assets = path.join(import.meta.dirname, "../apps/web/dist");

// The same build core's deploy runs, so the bundle below is what ships.
execFileSync("vp", ["run", "build"], { cwd: core, stdio: "inherit" });
execFileSync("wrangler", ["deploy", "--dry-run", "--outdir", out], {
  cwd: core,
  stdio: "inherit",
});
// The fake IdP people sign in through, bundled the same way, beside core.
const idpOut = path.join(out, "idp");
execFileSync(
  "wrangler",
  ["deploy", "--dry-run", "-c", "test/idp.wrangler.jsonc", "--outdir", idpOut],
  { cwd: core, stdio: "inherit" }
);

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
const IDP_PORT = await freePort();
const origin = `http://127.0.0.1:${PORT}`;
const idpOrigin = `http://127.0.0.1:${IDP_PORT}`;

// Durable Object migrations and the Grasp skills are bundled next to
// index.js as text modules, and WebAssembly (the jq evaluator) as wasm
// modules.
const textModule = /(?:\.sql|SKILL\.md)$/u;
const files = readdirSync(out);
const modules = [
  `(name = "index.js", esModule = embed "index.js")`,
  ...files
    .filter((file) => textModule.test(file))
    .map((file) => `(name = "${file}", text = embed "${file}")`),
  ...files
    .filter((file) => file.endsWith(".wasm"))
    .map((file) => `(name = "${file}", wasm = embed "${file}")`),
];

// The on-prem profile's D1 service, and core's D1 migrations for it.
writeD1Service(out, d1DatabasesOf(coreWranglerConfig));
// And its R2 service.
writeR2Service(out);

// Durable Objects keep their SQLite databases on disk, as on-prem. Removed
// with the rest of `out`.
const storage = path.join(out, "storage");
mkdirSync(storage);

// Everything from here runs inside the scope that stops the sandbox
// supervisor and core and removes `out`, however the run ends.
let sandbox: SandboxSupervisor | undefined;
let tap: SocketTap | undefined;
let server: ChildProcess | undefined;
try {
  // The sandbox supervisor core's SANDBOX_HOST reaches, with its pool of
  // workerd processes, as on-prem runs it beside core; through a tap that
  // records whose sessions core asks it for.
  sandbox = await startSandboxSupervisor({ workerd: nativeWorkerd });
  tap = await tapSocket(sandbox.socket, out);

  writeFileSync(path.join(out, "assets.js"), assetsWorkerSource);
  writeFileSync(
    path.join(out, "config.capnp"),
    smokeConfig({
      port: PORT,
      sandboxSocket: tap.socket,
      routerSecret: ROUTER_SECRET,
      modules,
      storage,
      signIn: {
        idpPort: IDP_PORT,
        idpModules: readdirSync(idpOut)
          .filter((file) => file.endsWith(".js"))
          .map((file) => `(name = "${file}", esModule = embed "idp/${file}")`),
        assets,
        // Only test values, for this machine (apps/core/test/sign-in-config.ts),
        // and a session secret made for this run.
        vars: {
          ...localSignIn(origin, idpOrigin),
          BETTER_AUTH_SECRET: crypto.randomUUID(),
        },
      },
    })
  );

  const coreProcess = spawn(
    "workerd",
    ["serve", path.join(out, "config.capnp")],
    {
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  server = coreProcess;

  // Everything workerd writes, line by line, both shown and checked.
  const output = new PassThrough();
  for (const stream of [coreProcess.stdout, coreProcess.stderr]) {
    createInterface({ input: stream }).on("line", (line) => {
      console.info(line);
      output.write(`${line}\n`);
    });
  }
  const lines = createInterface({ input: output })[Symbol.asyncIterator]();

  await coreStarted(coreProcess, {
    url: `http://127.0.0.1:${PORT}/health`,
    headers: { [routerSecretHeader]: ROUTER_SECRET },
    fetch,
    attempts: ATTEMPTS,
    retryDelayMs: RETRY_DELAY_MS,
  });
  const excused = await installedOnWorkerd(
    coreProcess,
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
  await sealedCallOnWorkerd(
    { origin, idpOrigin, headers: { [routerSecretHeader]: ROUTER_SECRET } },
    tap.owners
  );
  console.info(
    "a sealed App's function ran on the sandbox host, in a Worker Loader isolate"
  );
} finally {
  server?.kill();
  await tap?.close();
  await sandbox?.stop();
  rmSync(out, { force: true, recursive: true });
}
