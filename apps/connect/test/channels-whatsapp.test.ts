/**
 * Sending as a client's own WhatsApp Business number (src/channels.ts):
 * core's WhatsApp adapter hands connect each Cloud API request, built with
 * the placeholder token, and connect sends it on with the client's system
 * user token, or refuses it.
 *
 * The ways it can fail come first: a request sent anywhere but the
 * messages endpoint of the client's own number (another number, media,
 * templates, the number's settings), a token of core's own, the client's
 * token going back to core, and a number that isn't set up. Then what it
 * is for.
 */
import {
  channelAnswer,
  channelCredentialPlaceholder,
  channelHeader,
} from "@grasp-os/shared/connect";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { auditEvents, connectWith } from "./connect.ts";
import { fakeProvider, json, route } from "./internet.ts";
import { fakeProviders } from "./oauth-provider.ts";

/** The client's system user token, as connect holds it. */
const accessToken = "test-whatsapp-token-of-the-client";

/** The client's business number, by its Cloud API id. */
const number = "106540352242922";

// The OAuth providers' spy on fetch first, as the internet's expects.
fakeProviders();
const meta = fakeProvider({
  hosts: ["graph.facebook.com"],
  parts: ["number"],
  routes: [
    route(
      "graph.facebook.com",
      "POST",
      String.raw`^/v[\d.]+/(?<number>\d+)/messages$`,
      () =>
        json({
          messaging_product: "whatsapp",
          messages: [{ id: "wamid.HBgLMzE2MTIzNDU2NzgVAgARGBI" }],
        })
    ),
  ],
  unmatched: () => json({ error: { message: "Unknown path" } }, 404),
});
const audit = auditEvents();

const connect = () =>
  connectWith({
    WHATSAPP_PHONE_NUMBER_ID: number,
    WHATSAPP_ACCESS_TOKEN: accessToken,
  });

/** A Cloud API request as the WhatsApp adapter sends one, unless told otherwise. */
const cloudApi = (
  url: string,
  {
    method = "POST",
    authorization = `Bearer ${channelCredentialPlaceholder}`,
  }: { method?: string; authorization?: string } = {}
): Request =>
  new Request(url, {
    method,
    headers: { "content-type": "application/json", authorization },
    body:
      method === "GET"
        ? null
        : JSON.stringify({
            messaging_product: "whatsapp",
            to: "31612345678",
            type: "text",
            text: { body: "Your report is ready" },
          }),
  });

const messagesUrl = `https://graph.facebook.com/v25.0/${number}/messages`;

describe("sending as the client's WhatsApp number", () => {
  it("refuses anywhere but its own number's messages, and every other Graph path", async () => {
    const statuses = [];
    for (const url of [
      `https://attacker.test/v25.0/${number}/messages`,
      `http://graph.facebook.com/v25.0/${number}/messages`,
      `https://graph.facebook.com:8443/v25.0/${number}/messages`,
      `https://graph.facebook.com.attacker.test/v25.0/${number}/messages`,
      // Another business number on the same token.
      "https://graph.facebook.com/v25.0/999999999999999/messages",
      // Media, templates, the number's own settings, anything else.
      `https://graph.facebook.com/v25.0/${number}/media`,
      `https://graph.facebook.com/v25.0/${number}/message_templates`,
      `https://graph.facebook.com/v25.0/${number}`,
      "https://graph.facebook.com/v25.0/me/accounts",
      `https://graph.facebook.com/v25.0/${number}/messages?access_token=core`,
      `https://graph.facebook.com/v25.0/${number}/messages/../media`,
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one URL at a time
      const response = await connect().channelFetch("whatsapp", cloudApi(url));
      statuses.push({
        url,
        status: response.status,
        kind: response.headers.get(channelHeader),
      });
    }
    expect(statuses).toStrictEqual(
      statuses.map(({ url }) => ({
        url,
        status: 403,
        kind: channelAnswer.refused,
      }))
    );
    expect(meta.sent).toStrictEqual([]);
  });

  it("refuses a request without the placeholder as its token, or by GET", async () => {
    const refused = await Promise.all([
      connect().channelFetch(
        "whatsapp",
        cloudApi(messagesUrl, { authorization: "Bearer EAAG-own" })
      ),
      connect().channelFetch(
        "whatsapp",
        cloudApi(messagesUrl, { method: "GET" })
      ),
    ]);
    expect(refused.map(({ status }) => status)).toStrictEqual([403, 403]);
    expect(meta.sent).toStrictEqual([]);
  });

  it("refuses every send while the client's number isn't set up", async () => {
    const answers = await Promise.all(
      [
        { WHATSAPP_ACCESS_TOKEN: undefined, WHATSAPP_PHONE_NUMBER_ID: number },
        {
          WHATSAPP_ACCESS_TOKEN: accessToken,
          WHATSAPP_PHONE_NUMBER_ID: undefined,
        },
      ].map(async (vars) => {
        const response = await connectWith(vars).channelFetch(
          "whatsapp",
          cloudApi(messagesUrl)
        );
        return {
          status: response.status,
          kind: response.headers.get(channelHeader),
        };
      })
    );
    expect({ answers, sent: meta.sent }).toStrictEqual({
      answers: [
        { status: 503, kind: channelAnswer.unconfigured },
        { status: 503, kind: channelAnswer.unconfigured },
      ],
      sent: [],
    });
  });

  it("sends with the client's real token, which never goes back to core, and records it", async () => {
    const response = await connect().channelFetch(
      "whatsapp",
      cloudApi(messagesUrl)
    );
    const answer = await response.text();
    const [sent] = meta.sent;
    const events = await audit.events();
    expect({
      status: response.status,
      answer: z.unknown().parse(JSON.parse(answer)),
      authorization: sent?.headers.authorization,
      recorded: events.map(({ action, target, detail }) => ({
        action,
        target,
        detail,
      })),
    }).toStrictEqual({
      status: 200,
      answer: {
        messaging_product: "whatsapp",
        messages: [{ id: "wamid.HBgLMzE2MTIzNDU2NzgVAgARGBI" }],
      },
      authorization: `Bearer ${accessToken}`,
      recorded: [
        {
          action: "channel.call",
          target: { type: "channel", id: "whatsapp" },
          detail: {
            outcome: "ok",
            method: "POST",
            host: "graph.facebook.com",
            status: 200,
          },
        },
      ],
    });
    expect(answer).not.toContain(accessToken);
    // Neither what was sent nor to whom is in the audit log.
    expect(JSON.stringify(events)).not.toMatch(/report|31612345678/u);
  });
});
