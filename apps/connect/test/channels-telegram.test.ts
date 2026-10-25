/**
 * Sending as a client's own Telegram bot (src/channels.ts): core's
 * Telegram adapter hands connect each Bot API request, the placeholder in
 * its address where the bot's token goes, and connect sends it on with the
 * bot's real token, or refuses it.
 *
 * The ways it can fail come first: a request sent anywhere but the Bot
 * API, a method an adapter has no use for (files, webhooks, members,
 * updates), a token of core's own, the bot's token going back to core,
 * and a bot that isn't set up. Then what it is for.
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

/** The client's bot's token from BotFather, as connect holds it. */
const botToken = "7140326550:AAH-test-telegram-token-of-the-client";

// The OAuth providers' spy on fetch first, as the internet's expects.
fakeProviders();
const telegram = fakeProvider({
  hosts: ["api.telegram.org"],
  parts: ["method"],
  routes: [
    route(
      "api.telegram.org",
      "POST",
      String.raw`^/bot[^/]+/(?<method>\w+)$`,
      ({ method }) =>
        method === "sendMessage"
          ? json({
              ok: true,
              result: { message_id: 42, chat: { id: 1234, type: "private" } },
            })
          : json({ ok: true, result: true })
    ),
  ],
  unmatched: () => json({ ok: false, description: "Not Found" }, 404),
});
const audit = auditEvents();

const connect = () => connectWith({ TELEGRAM_BOT_TOKEN: botToken });

/** The Bot API address of `method`, with `token` where the bot's goes. */
const botApi = (method: string, token = channelCredentialPlaceholder) =>
  `https://api.telegram.org/bot${token}/${method}`;

/** A Bot API request as the Telegram adapter sends one, unless told otherwise. */
const request = (
  url: string,
  { method = "POST" }: { method?: string } = {}
): Request =>
  new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body:
      method === "GET"
        ? null
        : JSON.stringify({ chat_id: 1234, text: "Your report is ready" }),
  });

describe("sending as the client's Telegram bot", () => {
  it("refuses anywhere but the Bot API, and methods an adapter has no use for", async () => {
    const statuses = [];
    for (const url of [
      `https://attacker.test/bot${channelCredentialPlaceholder}/sendMessage`,
      `http://api.telegram.org/bot${channelCredentialPlaceholder}/sendMessage`,
      `https://api.telegram.org:8443/bot${channelCredentialPlaceholder}/sendMessage`,
      `https://api.telegram.org.attacker.test/bot${channelCredentialPlaceholder}/sendMessage`,
      // Files, webhooks, members, updates, anything else.
      botApi("getFile"),
      botApi("sendDocument"),
      botApi("setWebhook"),
      botApi("getChatMember"),
      botApi("getUpdates"),
      `https://api.telegram.org/file/bot${channelCredentialPlaceholder}/photos/1.jpg`,
      `${botApi("sendMessage")}?chat_id=1`,
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one URL at a time
      const response = await connect().channelFetch("telegram", request(url));
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
    expect(telegram.sent).toStrictEqual([]);
  });

  it("refuses a request with a token of core's own in its address, or by GET", async () => {
    const refused = await Promise.all([
      connect().channelFetch(
        "telegram",
        request(botApi("sendMessage", "1234:own-token"))
      ),
      connect().channelFetch(
        "telegram",
        request(botApi("sendMessage"), { method: "GET" })
      ),
    ]);
    expect(refused.map(({ status }) => status)).toStrictEqual([403, 403]);
    expect(telegram.sent).toStrictEqual([]);
  });

  it("refuses every send while the client's bot isn't set up", async () => {
    const response = await connectWith({
      TELEGRAM_BOT_TOKEN: undefined,
    }).channelFetch("telegram", request(botApi("sendMessage")));
    expect({
      status: response.status,
      kind: response.headers.get(channelHeader),
      sent: telegram.sent,
    }).toStrictEqual({
      status: 503,
      kind: channelAnswer.unconfigured,
      sent: [],
    });
  });

  it("sends with the bot's real token, which never goes back to core, and records it", async () => {
    const response = await connect().channelFetch(
      "telegram",
      request(botApi("sendMessage"))
    );
    const answer = await response.text();
    const [sent] = telegram.sent;
    const events = await audit.events();
    expect({
      status: response.status,
      answer: z.unknown().parse(JSON.parse(answer)),
      path: sent?.path,
      recorded: events.map(({ action, target, detail }) => ({
        action,
        target,
        detail,
      })),
    }).toStrictEqual({
      status: 200,
      answer: {
        ok: true,
        result: { message_id: 42, chat: { id: 1234, type: "private" } },
      },
      path: `/bot${botToken}/sendMessage`,
      recorded: [
        {
          action: "channel.call",
          target: { type: "channel", id: "telegram" },
          detail: {
            outcome: "ok",
            method: "POST",
            host: "api.telegram.org",
            status: 200,
          },
        },
      ],
    });
    expect(answer).not.toContain(botToken);
    expect(JSON.stringify(events)).not.toMatch(/report|AAH-test/u);
  });

  it("shows typing and reads who the bot is without recording either", async () => {
    await connect().channelFetch("telegram", request(botApi("sendChatAction")));
    await connect().channelFetch("telegram", request(botApi("getMe")));
    expect({
      tries: telegram.sent.length,
      recorded: await audit.events(),
    }).toStrictEqual({ tries: 2, recorded: [] });
  });
});
