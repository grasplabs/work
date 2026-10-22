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
  routerSecretHeader,
} from "@grasp-os/shared/router";
import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import router from "../src/index.ts";
import {
  fakeCores,
  mapHost,
  routerKeyAdmin,
  testRouterKey,
} from "./fixtures.ts";

/** What became of a message: the reason it bounced with, if it did. */
interface Disposition {
  rejected?: string;
}

const raw = [
  "From: Ben <ben@acme.test>",
  "To: invoices@acme.grasp.test",
  "Subject: Invoice INV-7",
  "",
  "Please pay by Friday.",
  "",
].join("\r\n");

/** Hands `router` a message for `to`, as Email Routing does. */
const deliver = async (
  to: string,
  body = raw,
  rawSize?: number
): Promise<Disposition> => {
  const bytes = new TextEncoder().encode(body);
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
    rawSize: rawSize ?? bytes.byteLength,
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
describe("the mail sorter", () => {
  const cores = fakeCores();

  beforeAll(async () => {
    const admin = await routerKeyAdmin();
    await admin.create(testRouterKey);
  });

  it("hands a message to the core of the client whose hostname is its recipient's domain, signed for it alone", async () => {
    await mapHost("acme.grasp.test", {
      clientId: "acme",
      coreUrl: "https://grasp-os-core.acme.workers.dev",
      generation: 2,
    });
    await mapHost("globex.grasp.test", {
      clientId: "globex",
      coreUrl: "https://grasp-os-core.globex.workers.dev",
      generation: 1,
    });
    cores.answerWith(() => new Response(null, { status: 202 }));

    const disposition = await deliver("Invoices@ACME.grasp.test");

    expect(disposition).toStrictEqual({});
    expect(cores.received).toHaveLength(1);
    const [sent] = cores.received;
    const secret = await deriveRouterSecret(testRouterKey, "acme", 2);
    const mail = {
      to: sent?.headers.get(mailToHeader) ?? "",
      from: sent?.headers.get(mailFromHeader) ?? "",
      sha256: sent?.headers.get(mailSha256Header) ?? "",
      size: Number(sent?.headers.get(mailSizeHeader)),
      sentAt: sent?.headers.get(mailSentAtHeader) ?? "",
    };
    const bytes = new TextEncoder().encode(raw);
    expect({
      url: sent?.url,
      method: sent?.method,
      secret: sent?.headers.get(routerSecretHeader),
      mail: { ...mail, sentAt: undefined },
      body: sent?.body,
    }).toStrictEqual({
      url: `https://grasp-os-core.acme.workers.dev${mailIngressPath}`,
      method: "POST",
      secret,
      mail: {
        to: "Invoices@ACME.grasp.test",
        from: "bounces@acme.test",
        sha256: await sha256HexOfBytes(bytes),
        size: bytes.byteLength,
        sentAt: undefined,
      },
      body: raw,
    });
    const signature = sent?.headers.get(mailSignatureHeader) ?? "";
    // Signed with acme's router secret, which globex's core doesn't hold.
    await expect(verifyMail(secret, mail, signature)).resolves.toBeTruthy();
    await expect(
      verifyMail(
        await deriveRouterSecret(testRouterKey, "globex", 1),
        mail,
        signature
      )
    ).resolves.toBeFalsy();
  });

  it("bounces mail for a domain no client has, and sends it nowhere", async () => {
    const dispositions = await Promise.all(
      [
        "invoices@unknown.grasp.test",
        "invoices@grasp.test",
        "no-domain",
        "@acme-sorted.grasp.test",
      ].map(async (to) => await deliver(to))
    );

    expect(dispositions).toStrictEqual(
      dispositions.map(() => ({ rejected: "No such address." }))
    );
    expect(cores.received).toStrictEqual([]);
  });

  it("bounces with core's reason, and fails for now, for the sender to try again, when core doesn't take it", async () => {
    await mapHost("bounce.grasp.test", {
      clientId: "bounce",
      coreUrl: "https://grasp-os-core.bounce.workers.dev",
      generation: 1,
    });
    cores.answerWith(() =>
      Response.json({ reason: "No such address." }, { status: 422 })
    );
    await expect(deliver("nobody@bounce.grasp.test")).resolves.toStrictEqual({
      rejected: "No such address.",
    });

    for (const status of [500, 503, 403]) {
      cores.answerWith(() => new Response("no", { status }));
      // oxlint-disable-next-line no-await-in-loop -- one answer at a time
      await expect(deliver("invoices@bounce.grasp.test")).rejects.toThrow(
        `(${status})`
      );
    }
  });

  it("bounces a message too large to pass on, without reading it", async () => {
    await mapHost("large.grasp.test", {
      clientId: "large",
      coreUrl: "https://grasp-os-core.large.workers.dev",
      generation: 1,
    });

    await expect(
      deliver("invoices@large.grasp.test", raw, 26 * 1024 * 1024)
    ).resolves.toStrictEqual({ rejected: "The message is too large." });
    expect(cores.received).toStrictEqual([]);
  });

  it("never lets a public request reach core's mail ingress, or carry its headers", async () => {
    await mapHost("public.grasp.test", {
      clientId: "public",
      coreUrl: "https://grasp-os-core.public.workers.dev",
      generation: 1,
    });

    const direct = await exports.default.fetch(
      `https://public.grasp.test${mailIngressPath}`,
      { method: "POST", body: raw }
    );
    await exports.default.fetch("https://public.grasp.test/api/things", {
      method: "POST",
      headers: {
        [mailToHeader]: "invoices@public.grasp.test",
        [mailFromHeader]: "ceo@acme.test",
        [mailSha256Header]: "0".repeat(64),
        [mailSizeHeader]: "1",
        [mailSentAtHeader]: new Date().toISOString(),
        [mailSignatureHeader]: "0".repeat(64),
      },
      body: raw,
    });

    expect(direct.status).toBe(404);
    expect(cores.received.map(({ url }) => url)).toStrictEqual([
      "https://grasp-os-core.public.workers.dev/api/things",
    ]);
    expect(
      [
        mailToHeader,
        mailFromHeader,
        mailSha256Header,
        mailSizeHeader,
        mailSentAtHeader,
        mailSignatureHeader,
      ].map((name) => cores.received[0]?.headers.get(name))
    ).toStrictEqual([null, null, null, null, null, null]);
  });
});
