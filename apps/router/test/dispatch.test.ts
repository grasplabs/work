import { sha256HexOfBytes } from "@grasp-os/shared/encoding";
import {
  mailFromHeader,
  mailIngressPath,
  mailSentAtHeader,
  mailSha256Header,
  mailSignatureHeader,
  mailSizeHeader,
  mailToHeader,
  verifyMail,
} from "@grasp-os/shared/mail-ingress";
import {
  deriveRouterSecret,
  routerClientIpHeader,
  routerSecretHeader,
} from "@grasp-os/shared/router";
import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";

import router from "../src/index.ts";
import {
  fakeNamespace,
  mapHost,
  routerKeyAdmin,
  testRouterKey,
} from "./fixtures.ts";

// The router on Workers for Platforms (GRA-283; the threat model is on the
// issue): each client's core is a user Worker in the dispatch namespace the
// router binds, reached through that binding by the script its map entry
// names, never over the internet, and only that one: a script the
// namespace doesn't have is a failure, never another client's core. The
// namespace runs only on Cloudflare, so a stand-in takes its place
// (`fakeNamespace`); its scripts are the core stand-in Worker.

const scripts = ["grasp-core-acme", "grasp-core-beta"];

const acme = { clientId: "acme", script: "grasp-core-acme", generation: 3 };
const beta = { clientId: "beta", script: "grasp-core-beta", generation: 1 };

const secretOf = async (clientId: string, generation: number) =>
  await deriveRouterSecret(testRouterKey, clientId, generation);

const raw = [
  "From: Ben <ben@acme.test>",
  "To: invoices@acme.wfp.test",
  "Subject: Invoice INV-7",
  "",
  "Please pay by Friday.",
  "",
].join("\r\n");

/** What became of a message: the reason it bounced with, if it did. */
interface Disposition {
  rejected?: string;
}

/** Hands the router a message for `to`, as Email Routing does. */
const deliver = async (to: string): Promise<Disposition> => {
  const bytes = new TextEncoder().encode(raw);
  const disposition: Disposition = {};
  const message: ForwardableEmailMessage = {
    from: "bounces@acme.test",
    to,
    raw: new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    headers: new Headers(),
    rawSize: bytes.byteLength,
    setReject: (reason) => {
      disposition.rejected = reason;
    },
    forward: async () =>
      await Promise.reject(new Error("The router never forwards mail")),
    reply: async () =>
      await Promise.reject(new Error("The router never replies to mail")),
  };
  await router.email(message, env);
  return disposition;
};

// The route cache lives for the isolate, across tests: each test uses
// hostnames of its own.
describe("the router on Workers for Platforms", () => {
  const namespace = fakeNamespace(scripts);

  beforeAll(async () => {
    const admin = await routerKeyAdmin();
    await admin.create(testRouterKey);
  });

  it("dispatches each hostname into its own client's script, on the hostname it was asked at, with that client's secret", async () => {
    await mapHost("acme.wfp.test", acme);
    await mapHost("beta.wfp.test", beta);
    // Never over the internet: the router's own fetch isn't called.
    const internet = vi.spyOn(globalThis, "fetch");

    const [forAcme, forBeta] = await Promise.all([
      exports.default.fetch("https://acme.wfp.test/api/things?page=2", {
        method: "POST",
        headers: { cookie: "a=b" },
        body: "hello",
      }),
      exports.default.fetch("https://beta.wfp.test/"),
    ]);

    expect({
      acme: await forAcme.json(),
      beta: forBeta.status,
      dispatched: namespace.received
        .map(({ script, url, headers }) => ({
          script,
          url,
          secret: headers.get(routerSecretHeader),
          cookie: headers.get("cookie"),
        }))
        .toSorted((a, b) => a.script.localeCompare(b.script)),
      internet: internet.mock.calls.length,
    }).toStrictEqual({
      // What the stand-in core says reached it.
      acme: {
        url: "https://acme.wfp.test/api/things?page=2",
        method: "POST",
        host: null,
        secret: await secretOf("acme", 3),
        clientIp: null,
        body: "hello",
      },
      beta: 200,
      dispatched: [
        {
          script: "grasp-core-acme",
          url: "https://acme.wfp.test/api/things?page=2",
          secret: await secretOf("acme", 3),
          cookie: "a=b",
        },
        {
          script: "grasp-core-beta",
          url: "https://beta.wfp.test/",
          secret: await secretOf("beta", 1),
          cookie: null,
        },
      ],
      internet: 0,
    });
  });

  it("replaces what a caller made up: a router secret, a client IP, a Host and mail ingress headers", async () => {
    await mapHost("spoof.wfp.test", acme);

    await exports.default.fetch("https://spoof.wfp.test/", {
      headers: {
        host: "beta.wfp.test",
        "cf-connecting-ip": "192.0.2.10",
        [routerClientIpHeader]: "198.51.100.1",
        [routerSecretHeader]: await secretOf("beta", 1),
        [mailToHeader]: "invoices@beta.wfp.test",
        [mailSignatureHeader]: "0".repeat(64),
      },
    });

    const [sent] = namespace.received;
    expect({
      script: sent?.script,
      host: sent?.headers.get("host"),
      secret: sent?.headers.get(routerSecretHeader),
      clientIp: sent?.headers.get(routerClientIpHeader),
      mailTo: sent?.headers.get(mailToHeader),
      signature: sent?.headers.get(mailSignatureHeader),
    }).toStrictEqual({
      script: "grasp-core-acme",
      host: null,
      secret: await secretOf("acme", 3),
      clientIp: "192.0.2.10",
      mailTo: null,
      signature: null,
    });
  });

  it("fails a hostname whose script the namespace doesn't have, and tries no other client", async () => {
    await mapHost("gone.wfp.test", {
      clientId: "gone",
      script: "grasp-core-gone",
      generation: 1,
    });
    const internet = vi.spyOn(globalThis, "fetch");
    const logged: unknown[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(...args);
    });

    const response = await exports.default.fetch(
      "https://gone.wfp.test/api/auth/callback?code=secret-code"
    );

    expect({
      status: response.status,
      asked: namespace.asked,
      dispatched: namespace.received.length,
      internet: internet.mock.calls.length,
      logged,
    }).toStrictEqual({
      status: 502,
      asked: ["grasp-core-gone"],
      dispatched: 0,
      internet: 0,
      // The error's kind alone: its message names the script.
      logged: [
        {
          event: "router.forward_failed",
          host: "gone.wfp.test",
          errorName: "Error",
        },
      ],
    });
  });

  it("routes nowhere for an entry that names both a script and an origin, neither, or no script's name", async () => {
    const refused = [
      { ...acme, coreUrl: "https://grasp-os-core.acme.workers.dev" },
      { clientId: "acme", generation: 3 },
      { ...acme, script: "Grasp-Core" },
      { ...acme, script: "grasp core" },
      { ...acme, script: "-grasp-core" },
      { ...acme, script: "a".repeat(64) },
      { ...acme, script: "../grasp-core-beta" },
    ];
    await Promise.all(
      refused.map(async (entry, index) => {
        await mapHost(`bad-${index}.wfp.test`, entry);
      })
    );

    const statuses = await Promise.all(
      refused.map(async (_, index) => {
        const response = await exports.default.fetch(
          `https://bad-${index}.wfp.test/`
        );
        return response.status;
      })
    );

    expect({
      statuses: new Set(statuses),
      asked: namespace.asked,
    }).toStrictEqual({ statuses: new Set([404]), asked: [] });
  });

  it("never lets a public request reach a client's mail ingress", async () => {
    await mapHost("public.wfp.test", acme);

    const direct = await exports.default.fetch(
      `https://public.wfp.test${mailIngressPath}`,
      { method: "POST", body: raw }
    );

    expect({
      status: direct.status,
      asked: namespace.asked,
    }).toStrictEqual({ status: 404, asked: [] });
  });

  it("hands mail to the script of the client whose hostname is the recipient's domain, signed for exactly its bytes and recipient", async () => {
    await mapHost("acme-mail.wfp.test", acme);
    await mapHost("beta-mail.wfp.test", beta);
    namespace.answerWith(() => new Response(null, { status: 202 }));

    const disposition = await deliver("Invoices@ACME-mail.wfp.test");

    const [sent] = namespace.received;
    const bytes = new TextEncoder().encode(raw);
    const mail = {
      to: sent?.headers.get(mailToHeader) ?? "",
      from: sent?.headers.get(mailFromHeader) ?? "",
      sha256: sent?.headers.get(mailSha256Header) ?? "",
      size: Number(sent?.headers.get(mailSizeHeader)),
      sentAt: sent?.headers.get(mailSentAtHeader) ?? "",
    };
    const signature = sent?.headers.get(mailSignatureHeader) ?? "";
    expect({
      disposition,
      dispatched: namespace.received.map(({ script, url, body }) => ({
        script,
        url,
        body,
      })),
      mail: { ...mail, sentAt: undefined },
      forAcme: await verifyMail(await secretOf("acme", 3), mail, signature),
      forBeta: await verifyMail(await secretOf("beta", 1), mail, signature),
    }).toStrictEqual({
      disposition: {},
      dispatched: [
        {
          script: "grasp-core-acme",
          url: `https://acme-mail.wfp.test${mailIngressPath}`,
          body: raw,
        },
      ],
      mail: {
        to: "Invoices@ACME-mail.wfp.test",
        from: "bounces@acme.test",
        sha256: await sha256HexOfBytes(bytes),
        size: bytes.byteLength,
        sentAt: undefined,
      },
      forAcme: true,
      forBeta: false,
    });
  });

  it("keeps what core does with a message: a bounce with its reason, a failure for now, or a script gone, never another client", async () => {
    await mapHost("kept.wfp.test", acme);
    await mapHost("gone-mail.wfp.test", {
      clientId: "gone",
      script: "grasp-core-gone",
      generation: 1,
    });

    namespace.answerWith(() =>
      Response.json({ reason: "No such address." }, { status: 422 })
    );
    const bounced = await deliver("nobody@kept.wfp.test");
    namespace.answerWith(() => new Response("no", { status: 503 }));
    const failedForNow = await deliver("invoices@kept.wfp.test").then(
      () => "taken",
      (error: unknown) => (error instanceof Error ? error.message : "thrown")
    );
    const gone = await deliver("invoices@gone-mail.wfp.test").then(
      () => "taken",
      () => "thrown"
    );
    const unknown = await deliver("invoices@nobody.wfp.test");

    expect({
      bounced,
      failedForNow: failedForNow.includes("(503)"),
      gone,
      unknown,
      dispatchedTo: namespace.received.map(({ script }) => script),
    }).toStrictEqual({
      bounced: { rejected: "No such address." },
      failedForNow: true,
      // Thrown: Email Routing tells the sender to try again.
      gone: "thrown",
      unknown: { rejected: "No such address." },
      dispatchedTo: ["grasp-core-acme", "grasp-core-acme"],
    });
  });
});
