/**
 * Sending as a client's own Slack app (src/channels.ts): core's Slack
 * adapter hands connect each Web API request, built with the placeholder
 * token, and connect sends it on with the app's bot token, or refuses it.
 *
 * The ways it can fail come first: a request sent anywhere but Slack's Web
 * API, a method an adapter has no use for (reading people's messages,
 * inviting, uploading), a token of core's own, the bot's token going back
 * to core, and an app that isn't set up. Then what it is for.
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

/** The client's Slack app's bot token, as connect holds it. */
const botToken = "test-slack-bot-token-of-the-client";

// The OAuth providers' spy on fetch first, as the internet's expects.
fakeProviders();
const slack = fakeProvider({
  hosts: ["slack.com"],
  parts: ["method"],
  routes: [
    route(
      "slack.com",
      "POST",
      String.raw`^/api/(?<method>[\w.]+)`,
      ({ method }) =>
        method === "chat.postMessage"
          ? json({ ok: true, channel: "D0123", ts: "1729771200.000100" })
          : json({ ok: true })
    ),
  ],
  unmatched: () => json({ ok: false, error: "unknown_method" }, 404),
});
const audit = auditEvents();

const connect = () => connectWith({ SLACK_BOT_TOKEN: botToken });

/** A Web API request as Slack's client sends one, unless told otherwise. */
const webApi = (
  url: string,
  {
    method = "POST",
    authorization = `Bearer ${channelCredentialPlaceholder}`,
  }: { method?: string; authorization?: string } = {}
): Request =>
  new Request(url, {
    method,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization,
    },
    body:
      method === "GET"
        ? null
        : new URLSearchParams({
            channel: "D0123",
            text: "Your report is ready",
          }),
  });

describe("sending as the client's Slack app", () => {
  it("refuses anywhere but Slack's Web API, and methods an adapter has no use for", async () => {
    const statuses = [];
    for (const url of [
      "https://attacker.test/api/chat.postMessage",
      "http://slack.com/api/chat.postMessage",
      "https://slack.com:8443/api/chat.postMessage",
      "https://files.slack.com/upload/v1/abc",
      "https://slack.com.attacker.test/api/chat.postMessage",
      // Reading people's messages, inviting, uploading, any admin call.
      "https://slack.com/api/conversations.history",
      "https://slack.com/api/conversations.invite",
      "https://slack.com/api/files.uploadV2",
      "https://slack.com/api/admin.users.list",
      "https://slack.com/api/chat.postMessage?token=core",
      "https://slack.com/api/chat.postMessage/../conversations.history",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one URL at a time
      const response = await connect().channelFetch("slack", webApi(url));
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
    expect(slack.sent).toStrictEqual([]);
  });

  it("refuses a request without the placeholder as its token, or by GET", async () => {
    const url = "https://slack.com/api/chat.postMessage";
    const refused = await Promise.all([
      connect().channelFetch(
        "slack",
        webApi(url, { authorization: "Bearer xoxp-own" })
      ),
      connect().channelFetch("slack", webApi(url, { method: "GET" })),
    ]);
    expect(refused.map(({ status }) => status)).toStrictEqual([403, 403]);
    expect(slack.sent).toStrictEqual([]);
  });

  it("refuses every send while the client's app isn't set up", async () => {
    const response = await connectWith({
      SLACK_BOT_TOKEN: undefined,
    }).channelFetch("slack", webApi("https://slack.com/api/chat.postMessage"));
    expect({
      status: response.status,
      kind: response.headers.get(channelHeader),
      sent: slack.sent,
    }).toStrictEqual({
      status: 503,
      kind: channelAnswer.unconfigured,
      sent: [],
    });
  });

  it("posts with the bot's real token, which never goes back to core, and records it", async () => {
    const response = await connect().channelFetch(
      "slack",
      webApi("https://slack.com/api/chat.postMessage")
    );
    const answer = await response.text();
    const [sent] = slack.sent;
    const events = await audit.events();
    expect({
      status: response.status,
      answer: z.unknown().parse(JSON.parse(answer)),
      authorization: sent?.headers.authorization,
      body: sent?.body,
      recorded: events.map(({ action, target, detail }) => ({
        action,
        target,
        detail,
      })),
    }).toStrictEqual({
      status: 200,
      answer: { ok: true, channel: "D0123", ts: "1729771200.000100" },
      authorization: `Bearer ${botToken}`,
      body: "channel=D0123&text=Your+report+is+ready",
      recorded: [
        {
          action: "channel.call",
          target: { type: "channel", id: "slack" },
          detail: {
            outcome: "ok",
            method: "POST",
            host: "slack.com",
            status: 200,
          },
        },
      ],
    });
    expect(answer).not.toContain(botToken);
    expect(JSON.stringify(events)).not.toContain("report");
  });

  it("reads who the bot is without recording it, and waits out a short rate limit", async () => {
    slack.fail({
      status: 429,
      body: { ok: false },
      headers: { "retry-after": "0" },
    });
    const response = await connect().channelFetch(
      "slack",
      webApi("https://slack.com/api/auth.test")
    );
    expect({
      status: response.status,
      tries: slack.sent.length,
      recorded: await audit.events(),
    }).toStrictEqual({ status: 200, tries: 2, recorded: [] });
  });
});
