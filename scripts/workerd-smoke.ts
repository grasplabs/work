/**
 * On-prem smoke run: bundles core and serves it on plain workerd (no
 * Wrangler, no Miniflare), checks it answers, and waits for its built-in
 * content to install: it fails on any failure core or workerd logs before
 * that. Then opens the frontend through the on-prem profile's assets
 * service, delivers signed raw mail to core's ingress, as the router does
 * in the cloud and a mail bridge on-prem, and has someone sign in, seal an
 * App and call one of its functions, which runs on the sandbox host
 * (workerd-smoke-sealed.ts). Keeps the code on-prem ready: only platform
 * APIs that also run on workerd.
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
import {
  mailIngressRequest,
  mailRejectedStatus,
  mailSignatureHeader,
  signMail,
} from "../packages/shared/src/mail-ingress.ts";
import type { RawMail } from "../packages/shared/src/mail-ingress.ts";
import { routerSecretHeader } from "../packages/shared/src/router.ts";
import { writeAssetsService } from "./workerd-assets.ts";
import { d1DatabasesOf, writeD1Service } from "./workerd-d1.ts";
import { writeR2Service } from "./workerd-r2.ts";
import { nativeWorkerd, startSandboxSupervisor } from "./workerd-sandbox.ts";
import type { SandboxSupervisor } from "./workerd-sandbox.ts";
import { coreWranglerConfig, smokeConfig } from "./workerd-smoke-config.ts";
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
// And its R2 service, and its assets service (over apps/web/dist, which
// `vp run --filter @grasp-os/web build` fills and core's build adds the
// compiler to).
writeR2Service(out);
writeAssetsService(out);

// Durable Objects keep their SQLite databases on disk, as on-prem. Removed
// with the rest of `out`.
const storage = path.join(out, "storage");
mkdirSync(storage);

/** A message to `to`, as Email Routing hands it over, sent now. */
const rawMail = (to: string): RawMail => ({
  to,
  from: "ben@example.com",
  raw: new TextEncoder().encode(
    [
      "From: Ben <ben@example.com>",
      `To: ${to}`,
      "Subject: Invoice INV-7",
      "Message-ID: <inv-7@example.com>",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Please pay by Friday.",
      "",
    ].join("\r\n")
  ),
  sentAt: new Date().toISOString(),
});

/** Throws, saying what core answered instead, unless it's `expected`. */
const expectAnswer = async (
  what: string,
  response: Response,
  expected: { status: number; body: string }
): Promise<void> => {
  const answer = { status: response.status, body: await response.text() };
  if (answer.status !== expected.status || answer.body !== expected.body) {
    throw new Error(
      `${what}: core answered ${JSON.stringify(answer)}, not ${JSON.stringify(expected)}`
    );
  }
};

/**
 * Delivers raw mail to core's ingress as the router's mail sorter sends it
 * (@grasp-os/shared/mail-ingress), and as an on-prem mail bridge would:
 * signed for the client's own address, core takes it to its email
 * triggers; signed with any other key, it refuses it. A fresh deployment
 * has no workflow receiving mail, so what core takes bounces with
 * `receiveEmail`'s reason, as Email Routing would bounce it.
 */
const mailDelivered = async (coreOrigin: string): Promise<void> => {
  const own = await mailIngressRequest(
    coreOrigin,
    ROUTER_SECRET,
    rawMail(`invoices@${new URL(coreOrigin).hostname}`)
  );
  await expectAnswer("signed mail to the client", await fetch(own.request), {
    status: mailRejectedStatus,
    body: JSON.stringify({ reason: "No such address." }),
  });

  // The same message, signed with a key derived from another secret.
  const forged = await mailIngressRequest(
    coreOrigin,
    ROUTER_SECRET,
    rawMail(`invoices@${new URL(coreOrigin).hostname}`)
  );
  forged.request.headers.set(
    mailSignatureHeader,
    await signMail("not-the-router-secret", forged.mail)
  );
  const refused = await fetch(forged.request);
  if (refused.status !== 403) {
    throw new Error(
      `mail signed with another key: core answered ${String(refused.status)}, not 403`
    );
  }
  await refused.body?.cancel();
};

/** A script the page loads from the frontend's own files. */
const pageScript = /<script[^>]*\ssrc="(?<src>\/[^"]+\.js)"/u;

/**
 * Opens the frontend as a browser does, through core and the on-prem
 * assets service: its index page, the same page at one of the frontend's
 * own routes (the single-page-app fallback core's entry relies on), and a
 * script the page loads, typed as JavaScript.
 */
const frontendServed = async (coreOrigin: string): Promise<void> => {
  const headers = { [routerSecretHeader]: ROUTER_SECRET };
  const page = async (pathname: string) => {
    const response = await fetch(new URL(pathname, coreOrigin), { headers });
    const type = response.headers.get("content-type") ?? "";
    const body = await response.text();
    if (!(response.ok && type.startsWith("text/html"))) {
      throw new Error(
        `the frontend at ${pathname}: core answered ${String(response.status)} ${type}, not its index page`
      );
    }
    return body;
  };
  const index = await page("/");
  if ((await page("/workflows")) !== index) {
    throw new Error("the frontend's own route: not its index page");
  }
  const src = pageScript.exec(index)?.groups?.src;
  if (src === undefined) {
    throw new Error("the frontend's index page loads no script of its own");
  }
  const script = await fetch(new URL(src, coreOrigin), { headers });
  await script.body?.cancel();
  const type = script.headers.get("content-type") ?? "";
  if (!(script.ok && type.includes("javascript"))) {
    throw new Error(
      `the frontend's script ${src}: core answered ${String(script.status)} ${type}`
    );
  }
};

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
  await frontendServed(`http://127.0.0.1:${PORT}`);
  await mailDelivered(`http://127.0.0.1:${PORT}`);
  console.info(
    excused.length === 0
      ? "core runs on workerd, its built-in content installed, it serves the frontend, and it takes signed mail"
      : "core runs on workerd, its built-in content installed but for the known gaps above, it serves the frontend, and it takes signed mail"
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
