import { appWebhookHeaders } from "@grasp-os/shared/app-webhooks";
import type { WebhookPost } from "@grasp-os/shared/app-webhooks";
import { env } from "cloudflare:workers";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { webhookPost } from "../src/webhooks.ts";

// Sending an App's events to a company's webhook (src/webhooks.ts), from
// its threat model: core passing on anything but a delivery, a URL inside
// a network, a redirect followed. Core's app-webhooks.test.ts sends them
// the whole way, from an App's event to the receiver.

/** One request that left connect. */
interface Sent {
  method: string;
  host: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

const sent: Sent[] = [];

/** A delivery, as core signs it. */
const post = (changes: Partial<WebhookPost> = {}): WebhookPost => ({
  url: "https://hooks.example.com/forms?token=receiver-own",
  app: "invoice-desk",
  webhook: "webhook-1",
  delivery: "delivery-1",
  event: "form_sent",
  timestamp: 1_793_000_000,
  signature: `v1=${"a".repeat(64)}`,
  body: '{"id":"delivery-1"}',
  ...changes,
});

describe(webhookPost, () => {
  beforeEach(() => {
    sent.length = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      sent.push({
        method: request.method,
        host: url.hostname,
        path: `${url.pathname}${url.search}`,
        headers: Object.fromEntries(request.headers),
        body: await request.text(),
      });
      if (url.pathname === "/moved") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://elsewhere.example/" },
        });
      }
      return new Response("ignored", { status: 202 });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends a delivery as a POST with its own headers alone, and reads only its status", async () => {
    const outcome = await webhookPost(env, post());

    expect({ outcome, sent }).toStrictEqual({
      outcome: { outcome: "delivered", status: 202 },
      sent: [
        {
          method: "POST",
          host: "hooks.example.com",
          path: "/forms?token=receiver-own",
          headers: {
            "content-type": "application/json",
            "user-agent": "Grasp-Webhooks/1",
            [appWebhookHeaders.id]: "delivery-1",
            [appWebhookHeaders.event]: "form_sent",
            [appWebhookHeaders.timestamp]: "1793000000",
            [appWebhookHeaders.signature]: `v1=${"a".repeat(64)}`,
          },
          body: '{"id":"delivery-1"}',
        },
      ],
    });
  });

  it("sends nothing for a request that isn't a delivery, nor to a URL inside a network, and follows no redirect", async () => {
    const outcomes = [
      // A header of core's own choosing: not a delivery.
      await webhookPost(env, { ...post(), headers: { cookie: "x" } }),
      await webhookPost(env, post({ signature: "anything" })),
      await webhookPost(env, post({ url: "http://hooks.example.com/" })),
      await webhookPost(env, post({ url: "https://10.0.0.8/" })),
      await webhookPost(env, post({ url: "https://hooks.internal/" })),
      await webhookPost(
        env,
        post({ url: "https://someone@hooks.example.com/" })
      ),
    ];
    const refusedSent = sent.length;
    const redirected = await webhookPost(
      env,
      post({ url: "https://hooks.example.com/moved" })
    );

    expect({
      outcomes,
      refusedSent,
      redirected,
      hosts: sent.map(({ host }) => host),
    }).toStrictEqual({
      outcomes: [
        { outcome: "refused", reason: "invalid" },
        { outcome: "refused", reason: "invalid" },
        { outcome: "refused", reason: "scheme" },
        { outcome: "refused", reason: "ip_literal" },
        { outcome: "refused", reason: "private_network" },
        { outcome: "refused", reason: "userinfo" },
      ],
      refusedSent: 0,
      redirected: { outcome: "failed", reason: "redirect", status: 302 },
      hosts: ["hooks.example.com"],
    });
  });
});
