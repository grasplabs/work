/**
 * On-prem smoke run: bundles core and serves it on plain workerd (no
 * Wrangler, no Miniflare), checks it answers, and waits for its built-in
 * content to install: it fails on any failure core or workerd logs before
 * that. Then opens the frontend through the on-prem profile's assets
 * service, and delivers signed raw mail to core's ingress, as the router
 * does in the cloud and a mail bridge on-prem. Keeps the code on-prem
 * ready: only platform APIs that also run on workerd.
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
import { createServer as createHttpServer } from "node:http";
import type { Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

import { hkdfHmacKey } from "../packages/shared/src/client-secrets.ts";
import { toHex } from "../packages/shared/src/encoding.ts";
import {
  mailIngressRequest,
  mailRejectedStatus,
  mailSignatureHeader,
  signMail,
} from "../packages/shared/src/mail-ingress.ts";
import type { RawMail } from "../packages/shared/src/mail-ingress.ts";
import {
  modelTransportReportPath,
  modelTransportReportPurpose,
  modelTransportReportSchema,
} from "../packages/shared/src/model-transport-report.ts";
import { platformUpdateSignatureHeader } from "../packages/shared/src/platform-change.ts";
import { routerSecretHeader } from "../packages/shared/src/router.ts";
import { writeAssetsService } from "./workerd-assets.ts";
import { d1DatabasesOf, writeD1Service } from "./workerd-d1.ts";
import { writeR2Service } from "./workerd-r2.ts";
import { nativeWorkerd, startSandboxSupervisor } from "./workerd-sandbox.ts";
import type { SandboxSupervisor } from "./workerd-sandbox.ts";
import {
  coreWranglerConfig,
  smokeAuthSecret,
  smokeConfig,
  smokeHostname,
  smokeModel,
} from "./workerd-smoke-config.ts";
import { coreStarted, installedOnWorkerd } from "./workerd-smoke-start.ts";
import type { KnownGap } from "./workerd-smoke-start.ts";

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
const MODEL_PORT = await freePort();

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
const mailDelivered = async (origin: string): Promise<void> => {
  const own = await mailIngressRequest(
    origin,
    ROUTER_SECRET,
    rawMail(`invoices@${smokeHostname}`)
  );
  await expectAnswer("signed mail to the client", await fetch(own.request), {
    status: mailRejectedStatus,
    body: JSON.stringify({ reason: "No such address." }),
  });

  // The same message, signed with a key derived from another secret.
  const forged = await mailIngressRequest(
    origin,
    ROUTER_SECRET,
    rawMail(`invoices@${smokeHostname}`)
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

/** A chat completion streamed as an OpenAI-compatible server streams one. */
const completionEvents = [
  {
    id: "smoke",
    object: "chat.completion.chunk",
    created: 0,
    model: "smoke-model",
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "OK" },
        finish_reason: null,
      },
    ],
  },
  {
    id: "smoke",
    object: "chat.completion.chunk",
    created: 0,
    model: "smoke-model",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  },
  {
    id: "smoke",
    object: "chat.completion.chunk",
    created: 0,
    model: "smoke-model",
    choices: [],
    usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 },
  },
];

/**
 * The model on the deployment's own network: an OpenAI-compatible server
 * on the machine, answering every chat completion with "OK", and counting
 * what it was asked.
 */
const startModelServer = async (): Promise<{
  server: Server;
  asked: string[];
}> => {
  const asked: string[] = [];
  const server = createHttpServer((request, response) => {
    asked.push(`${request.method ?? ""} ${request.url ?? ""}`);
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of completionEvents) {
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      response.end("data: [DONE]\n\n");
    });
  }).listen(MODEL_PORT, "127.0.0.1");
  await once(server, "listening");
  return { server, asked };
};

/**
 * Asks core, as the admin does, to probe its model transport: one call
 * through the model gateway, admitted, charged and audited like any, to
 * the model server on the deployment's own network, with no AI binding.
 */
const modelReached = async (origin: string, asked: string[]): Promise<void> => {
  const body = JSON.stringify({
    sentAt: new Date().toISOString(),
    probe: true,
  });
  const key = await hkdfHmacKey(smokeAuthSecret, modelTransportReportPurpose, [
    "sign",
  ]);
  const signature = toHex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))
    )
  );
  const response = await fetch(new URL(modelTransportReportPath, origin), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [routerSecretHeader]: ROUTER_SECRET,
      [platformUpdateSignatureHeader]: signature,
    },
    body,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `the model transport report: core answered ${String(response.status)} ${text}`
    );
  }
  const { probe } = modelTransportReportSchema.parse(JSON.parse(text));
  if (
    probe?.ok !== true ||
    probe.model !== smokeModel ||
    probe.transport !== "openai-compatible/smoke" ||
    !asked.includes("POST /v1/chat/completions")
  ) {
    throw new Error(
      `the model probe didn't reach the deployment's own model server: ${JSON.stringify({ probe, asked })}`
    );
  }
};

/** A script the page loads from the frontend's own files. */
const pageScript = /<script[^>]*\ssrc="(?<src>\/[^"]+\.js)"/u;

/**
 * Opens the frontend as a browser does, through core and the on-prem
 * assets service: its index page, the same page at one of the frontend's
 * own routes (the single-page-app fallback core's entry relies on), and a
 * script the page loads, typed as JavaScript.
 */
const frontendServed = async (origin: string): Promise<void> => {
  const headers = { [routerSecretHeader]: ROUTER_SECRET };
  const page = async (pathname: string) => {
    const response = await fetch(new URL(pathname, origin), { headers });
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
  const script = await fetch(new URL(src, origin), { headers });
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
let server: ChildProcess | undefined;
let modelServer: Server | undefined;
try {
  const model = await startModelServer();
  modelServer = model.server;
  // The sandbox supervisor core's SANDBOX_HOST reaches, with its pool of
  // workerd processes, as on-prem runs it beside core.
  sandbox = await startSandboxSupervisor({ workerd: nativeWorkerd });

  writeFileSync(
    path.join(out, "config.capnp"),
    smokeConfig({
      port: PORT,
      modelPort: MODEL_PORT,
      sandboxSocket: sandbox.socket,
      routerSecret: ROUTER_SECRET,
      modules,
      storage,
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
  await modelReached(`http://127.0.0.1:${PORT}`, model.asked);
  console.info(
    excused.length === 0
      ? "core runs on workerd, its built-in content installed, it serves the frontend, it takes signed mail, and it reaches a model on its own network"
      : "core runs on workerd, its built-in content installed but for the known gaps above, it serves the frontend, it takes signed mail, and it reaches a model on its own network"
  );
} finally {
  server?.kill();
  modelServer?.close();
  await sandbox?.stop();
  rmSync(out, { force: true, recursive: true });
}
