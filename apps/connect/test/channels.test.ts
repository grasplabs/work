/**
 * Sending as a client's own bot (src/channels.ts), Teams first: core's chat
 * adapters hand connect each request, built with a placeholder credential,
 * and connect sends it on as the bot, or refuses it.
 *
 * The ways it can fail come first: a request sent anywhere but the
 * platform's own hosts, one carrying a credential of its own, one that
 * would take the bot's token or secret back to core, and a bot that isn't
 * set up. Then what it is for: sends, edits and typing, the token, a bot
 * removed, a throttled or failing platform.
 */
import {
  channelAnswer,
  channelCredentialPlaceholder,
  channelHeader,
} from "@grasp-os/shared/connect";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import {
  botConnectorHost,
  fakeBotConnector,
  serviceUrl,
} from "./bot-connector.ts";
import { auditEvents, connectWith } from "./connect.ts";
import { teamsBot } from "./provider-config.ts";

const microsoft = fakeBotConnector();
const audit = auditEvents();

const placeholder = `Bearer ${channelCredentialPlaceholder}`;

const conversation = "a:1-acme-person";

/** Where a conversation's activities, or one of them, are sent. */
const activities = (activity?: string, base = serviceUrl): string =>
  `${base}v3/conversations/${encodeURIComponent(conversation)}/activities${
    activity === undefined ? "" : `/${activity}`
  }`;

/** A request as the Teams adapter sends one, unless `init` says otherwise. */
const adapterRequest = (
  url: string,
  {
    method = "POST",
    authorization = placeholder,
    body = { type: "message", text: "Your report is ready" },
    headers = {},
  }: {
    method?: string;
    authorization?: string | null;
    body?: unknown;
    headers?: Record<string, string>;
  } = {}
): Request =>
  new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...(authorization === null ? {} : { authorization }),
      ...headers,
    },
    body: method === "GET" ? null : JSON.stringify(body),
  });

/** The token request Microsoft's SDK sends for the bot, as core's adapter has it. */
const tokenRequest = (
  fields: Record<string, string> = {},
  tenant: string = teamsBot.tenant
): Request =>
  new Request(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: teamsBot.id,
      client_secret: channelCredentialPlaceholder,
      scope: "https://api.botframework.com/.default",
      ...fields,
    }),
  });

/** Connect with a Teams bot of its own, whose token it hasn't fetched. */
const connectForBot = () => connectWith(microsoft.bot());

/** The Bot Connector's own URL, with someone's sign-in in it. */
const withLogin = new URL(activities());
withLogin.username = "someone";

/** Whatever left for the Bot Connector. */
const toBotConnector = () =>
  microsoft.sent.filter(({ host }) => host === botConnectorHost);

describe("what it refuses", () => {
  it("refuses a host off the platform's list before any token is fetched", async () => {
    const connect = connectForBot();
    for (const url of [
      "https://attacker.test/v3/conversations/a/activities",
      // A serviceUrl a verified message named, on a host that isn't
      // Microsoft's Bot Connector.
      "https://smba.trafficmanager.net.attacker.test/emea/v3/conversations/a/activities",
      "https://graph.microsoft.com/v1.0/me/messages",
      // Microsoft's host, but not over HTTPS, on another port, or with
      // credentials in the URL.
      "http://smba.trafficmanager.net/emea/v3/conversations/a/activities",
      "https://smba.trafficmanager.net:8443/emea/v3/conversations/a/activities",
      withLogin.href,
      // The Bot Connector's host, off its conversations API.
      "https://smba.trafficmanager.net/emea/v3/botsignin/GetSignInUrl",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one URL at a time
      const response = await connect.channelFetch("teams", adapterRequest(url));
      expect({ url, status: response.status }).toStrictEqual({
        url,
        status: 403,
      });
      expect(response.headers.get(channelHeader)).toBe(channelAnswer.refused);
    }
    expect(microsoft.sent).toStrictEqual([]);
    expect(microsoft.tokenRequests).toStrictEqual([]);
  });

  it("refuses a request whose credential isn't the placeholder", async () => {
    const connect = connectForBot();
    for (const authorization of [
      // Another token core got hold of, the bot's real one included.
      "Bearer some-other-token",
      `Bearer ${channelCredentialPlaceholder}x`,
      `Basic ${btoa(`${teamsBot.id}:${channelCredentialPlaceholder}`)}`,
      // None at all: every Bot Connector request carries the bot's.
      null,
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one credential at a time
      const response = await connect.channelFetch(
        "teams",
        adapterRequest(activities(), { authorization })
      );
      expect(response.status).toBe(403);
      expect(response.headers.get(channelHeader)).toBe(channelAnswer.refused);
    }
    expect(microsoft.sent).toStrictEqual([]);
    expect(microsoft.tokenRequests).toStrictEqual([]);
  });

  it("refuses a token request that isn't the bot's own, with the placeholder", async () => {
    const connect = connectForBot();
    for (const request of [
      // A secret of core's own, to have connect ask Microsoft with it.
      tokenRequest({ client_secret: "a-secret-core-made-up" }),
      // Another app's token, or the bot's for another API than the Bot
      // Connector.
      tokenRequest({ client_id: "another-app" }),
      tokenRequest({ scope: "https://graph.microsoft.com/.default" }),
      tokenRequest({ grant_type: "password" }),
      // Not a token endpoint.
      new Request(
        `https://login.microsoftonline.com/${teamsBot.tenant}/oauth2/v2.0/devicecode`,
        { method: "POST", body: "client_id=x" }
      ),
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time
      const response = await connect.channelFetch("teams", request);
      expect(response.status).toBe(403);
    }
    expect(microsoft.tokenRequests).toStrictEqual([]);
  });

  it("never hands core the bot's secret or its real token", async () => {
    const vars = microsoft.bot();
    const connect = connectWith(vars);
    const tokenAnswer = await connect.channelFetch("teams", tokenRequest());
    const sendAnswer = await connect.channelFetch(
      "teams",
      adapterRequest(activities())
    );
    const answers = `${await tokenAnswer.text()}${JSON.stringify([
      ...tokenAnswer.headers,
      ...sendAnswer.headers,
    ])}${await sendAnswer.text()}`;
    expect(microsoft.issued.size).toBeGreaterThan(0);
    for (const secret of [vars.TEAMS_BOT_SECRET ?? "", ...microsoft.issued]) {
      expect(answers).not.toContain(secret);
    }
  });

  it("sends nothing of core's own credentials or cookies, and strips a platform's forged answer kind", async () => {
    const connect = connectForBot();
    await connect.channelFetch(
      "teams",
      adapterRequest(activities(), {
        headers: {
          cookie: "session=core",
          "proxy-authorization": "Basic Y29yZQ==",
          "x-ms-forwarded": "core",
        },
      })
    );
    const [sent] = toBotConnector();
    expect(Object.keys(sent?.headers ?? {}).toSorted()).toStrictEqual([
      "authorization",
      "content-type",
    ]);
  });

  it("refuses every send while the client's bot isn't set up", async () => {
    for (const unset of [
      { TEAMS_BOT_ID: undefined },
      { TEAMS_BOT_TENANT_ID: undefined },
      { TEAMS_BOT_SECRET: undefined },
      { TEAMS_BOT_SECRET: "" },
    ]) {
      const connect = connectWith({ ...microsoft.bot(), ...unset });
      for (const request of [adapterRequest(activities()), tokenRequest()]) {
        // oxlint-disable-next-line no-await-in-loop -- one request at a time
        const response = await connect.channelFetch("teams", request);
        expect(response.status).toBe(503);
        expect(response.headers.get(channelHeader)).toBe(
          channelAnswer.unconfigured
        );
      }
    }
    expect(microsoft.sent).toStrictEqual([]);
    expect(microsoft.tokenRequests).toStrictEqual([]);
  });

  it("refuses a platform it doesn't serve, and anything but a request", async () => {
    const connect = connectForBot();
    const unknown = await connect.channelFetch(
      "discord",
      adapterRequest("https://graph.facebook.com/v21.0/123/messages")
    );
    const notARequest = await connect.channelFetch("teams", {
      url: activities(),
    });
    expect([unknown.status, notARequest.status]).toStrictEqual([403, 403]);
    expect(microsoft.sent).toStrictEqual([]);
  });

  it("doesn't follow a redirect, which would take the bot's token along", async () => {
    const connect = connectForBot();
    microsoft.fail({
      status: 307,
      headers: { location: "https://attacker.test/" },
    });
    const response = await connect.channelFetch(
      "teams",
      adapterRequest(activities())
    );
    expect(response.status).toBe(502);
    expect(response.headers.get(channelHeader)).toBe(channelAnswer.failed);
    expect(microsoft.sent.map(({ host }) => host)).toStrictEqual([
      botConnectorHost,
    ]);
  });

  it("records what it refused, without the request's content", async () => {
    const connect = connectForBot();
    await connect.channelFetch(
      "teams",
      adapterRequest("https://attacker.test/v3/conversations/a/activities")
    );
    await connect.channelFetch(
      "teams",
      adapterRequest(activities(), { authorization: "Bearer stolen" })
    );
    const events = await audit.events();
    expect(
      events.map(({ action, actor, target, detail }) => ({
        action,
        actor,
        target,
        detail,
      }))
    ).toStrictEqual([
      {
        action: "channel.call",
        actor: { type: "system" },
        target: { type: "channel", id: "teams" },
        detail: {
          outcome: "refused",
          reason: "host",
          method: "POST",
          host: "other",
        },
      },
      {
        action: "channel.call",
        actor: { type: "system" },
        target: { type: "channel", id: "teams" },
        detail: {
          outcome: "refused",
          reason: "credential",
          method: "POST",
          host: botConnectorHost,
        },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("stolen");
    expect(JSON.stringify(events)).not.toContain("attacker");
  });
});

describe("sending as the bot", () => {
  it("answers the adapter's token request with the placeholder", async () => {
    const connect = connectForBot();
    // For the client's tenant, or Bot Framework's, which Microsoft's SDK
    // names for a multi-tenant bot: connect asks the client's either way.
    for (const tenant of [teamsBot.tenant, "botframework.com"]) {
      // oxlint-disable-next-line no-await-in-loop -- one tenant at a time
      const response = await connect.channelFetch(
        "teams",
        tokenRequest({}, tenant)
      );
      expect(response.status).toBe(200);
      // oxlint-disable-next-line no-await-in-loop -- one tenant at a time
      await expect(response.json()).resolves.toStrictEqual({
        token_type: "Bearer",
        expires_in: 86_400,
        ext_expires_in: 86_400,
        access_token: channelCredentialPlaceholder,
      });
    }
    // Answered by connect itself: Entra is asked only when a send needs it.
    expect(microsoft.tokenRequests).toStrictEqual([]);
  });

  it("passes the sign-in metadata Microsoft's SDK reads on, without anything of core's", async () => {
    const connect = connectForBot();
    for (const path of [
      "/common/discovery/instance?api-version=1.1",
      `/${teamsBot.tenant}/v2.0/.well-known/openid-configuration`,
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one path at a time
      const response = await connect.channelFetch(
        "teams",
        new Request(`https://login.microsoftonline.com${path}`, {
          headers: { authorization: placeholder, cookie: "core" },
        })
      );
      expect(response.status).toBe(200);
    }
    expect(
      microsoft.sent.map(({ path, headers }) => ({
        path,
        headers: Object.keys(headers),
      }))
    ).toStrictEqual([
      { path: "/common/discovery/instance?api-version=1.1", headers: [] },
      {
        path: `/${teamsBot.tenant}/v2.0/.well-known/openid-configuration`,
        headers: [],
      },
    ]);
  });

  it("sends a message, edits it and shows typing, with the bot's real token", async () => {
    const connect = connectForBot();
    const sendResponse = await connect.channelFetch(
      "teams",
      adapterRequest(activities())
    );
    expect(sendResponse.status).toBe(201);
    const { id } = await sendResponse.json<{ id: string }>();
    const edited = await connect.channelFetch(
      "teams",
      adapterRequest(activities(id), {
        method: "PUT",
        body: { type: "message", text: "Your report is ready (updated)" },
      })
    );
    const typing = await connect.channelFetch(
      "teams",
      adapterRequest(activities(), { body: { type: "typing" } })
    );
    expect([edited.status, typing.status]).toStrictEqual([200, 201]);
    const sent = toBotConnector();
    expect(
      sent.map(({ method, path, body }) => ({
        method,
        path,
        body,
      }))
    ).toStrictEqual([
      {
        method: "POST",
        path: `/emea/v3/conversations/${encodeURIComponent(conversation)}/activities`,
        body: JSON.stringify({ type: "message", text: "Your report is ready" }),
      },
      {
        method: "PUT",
        path: `/emea/v3/conversations/${encodeURIComponent(conversation)}/activities/${id}`,
        body: JSON.stringify({
          type: "message",
          text: "Your report is ready (updated)",
        }),
      },
      {
        method: "POST",
        path: `/emea/v3/conversations/${encodeURIComponent(conversation)}/activities`,
        body: JSON.stringify({ type: "typing" }),
      },
    ]);
    // The real token, never the placeholder, and the same one each time.
    const token = [...microsoft.issued].at(-1);
    expect(sent.map(({ authorization }) => authorization)).toStrictEqual([
      `Bearer ${token}`,
      `Bearer ${token}`,
      `Bearer ${token}`,
    ]);
  });

  it("fetches the token once from the client's tenant and reuses it", async () => {
    const vars = microsoft.bot();
    const connect = connectWith(vars);
    await connect.channelFetch("teams", tokenRequest());
    await connect.channelFetch("teams", adapterRequest(activities()));
    await connect.channelFetch("teams", adapterRequest(activities()));
    expect(
      microsoft.tokenRequests.map((form) => Object.fromEntries(form))
    ).toStrictEqual([
      {
        grant_type: "client_credentials",
        client_id: teamsBot.id,
        client_secret: vars.TEAMS_BOT_SECRET,
        scope: "https://api.botframework.com/.default",
      },
    ]);
  });

  it("fetches a new token once the cached one is about to expire, or stops working", async () => {
    const connect = connectForBot();
    // Within the margin connect keeps before a token's expiry.
    microsoft.expireIn(60);
    await connect.channelFetch("teams", adapterRequest(activities()));
    await connect.channelFetch("teams", adapterRequest(activities()));
    expect(microsoft.tokenRequests).toHaveLength(2);
    microsoft.expireIn(3600);
    await connect.channelFetch("teams", adapterRequest(activities()));
    microsoft.revoke();
    const response = await connect.channelFetch(
      "teams",
      adapterRequest(activities())
    );
    expect(response.status).toBe(201);
    expect(microsoft.tokenRequests).toHaveLength(4);
  });

  it("reaches the Bot Connector over RPC, as core does", async () => {
    const response = await exports.default.channelFetch(
      "teams",
      adapterRequest(activities())
    );
    expect(response.status).toBe(201);
  });

  it("reports a send Teams refuses with a 403 as the bot removed", async () => {
    const connect = connectForBot();
    microsoft.remove(conversation);
    const response = await connect.channelFetch(
      "teams",
      adapterRequest(activities())
    );
    expect(response.status).toBe(403);
    expect(response.headers.get(channelHeader)).toBe(channelAnswer.removed);
    await expect(response.json()).resolves.toStrictEqual({
      error: { code: "BotNotInConversationRoster" },
    });
    // Sent once: a removed bot isn't tried again.
    expect(toBotConnector()).toHaveLength(1);
  });

  it("retries a throttled or failing send after the wait Teams asks for", async () => {
    const connect = connectForBot();
    microsoft.fail(
      { status: 429, headers: { "retry-after": "0" } },
      { status: 503, headers: { "retry-after": "0" } }
    );
    const response = await connect.channelFetch(
      "teams",
      adapterRequest(activities())
    );
    expect(response.status).toBe(201);
    expect(toBotConnector()).toHaveLength(3);
  });

  it("passes a throttled answer on when Teams asks for a longer wait than connect's", async () => {
    const connect = connectForBot();
    microsoft.fail({ status: 429, headers: { "retry-after": "120" } });
    const throttled = await connect.channelFetch(
      "teams",
      adapterRequest(activities())
    );
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("retry-after")).toBe("120");
    expect(toBotConnector()).toHaveLength(1);
  });

  it("passes a failing answer on after its last try", async () => {
    const connect = connectForBot();
    microsoft.fail(
      { status: 502, headers: { "retry-after": "0" } },
      { status: 502, headers: { "retry-after": "0" } },
      { status: 502, headers: { "retry-after": "0" } }
    );
    const failing = await connect.channelFetch(
      "teams",
      adapterRequest(activities("activity-1"), { method: "PUT" })
    );
    expect(failing.status).toBe(502);
    expect(failing.headers.get(channelHeader)).toBeNull();
    expect(toBotConnector()).toHaveLength(3);
  });

  it("posts a message at most once when Teams fails without saying it refused", async () => {
    const connect = connectForBot();
    for (const failure of [
      { status: 502, carriedOut: true },
      { status: 504, carriedOut: true },
      { status: 500, carriedOut: true },
      // A 503 that names no wait doesn't say Teams turned the send away.
      { status: 503, carriedOut: true },
    ]) {
      microsoft.fail(failure);
      // oxlint-disable-next-line no-await-in-loop -- one send after another
      const failing = await connect.channelFetch(
        "teams",
        adapterRequest(activities())
      );
      expect(failing.status).toBe(failure.status);
    }
    expect(microsoft.posted).toStrictEqual(
      Array.from({ length: 4 }, () =>
        JSON.stringify({ type: "message", text: "Your report is ready" })
      )
    );
    expect(toBotConnector()).toHaveLength(4);
  });

  it("answers failed when Teams' answer breaks off after its headers", async () => {
    const connect = connectForBot();
    microsoft.fail({ status: 201, carriedOut: true, breaksOff: true });
    const response = await connect.channelFetch(
      "teams",
      adapterRequest(activities())
    );
    expect(response.status).toBe(502);
    expect(response.headers.get(channelHeader)).toBe(channelAnswer.failed);
    expect(microsoft.posted).toHaveLength(1);
  });

  it("answers failed when Entra's answer holds no token, and sends nothing", async () => {
    const connect = connectForBot();
    microsoft.answerWithoutToken();
    const response = await connect.channelFetch(
      "teams",
      adapterRequest(activities())
    );
    expect(response.status).toBe(502);
    expect(response.headers.get(channelHeader)).toBe(channelAnswer.failed);
    expect(toBotConnector()).toStrictEqual([]);
  });

  it("drops a platform's own answer-kind header, so it can't pass as connect's", async () => {
    const connect = connectForBot();
    microsoft.fail({
      status: 404,
      headers: { [channelHeader]: channelAnswer.removed },
    });
    const response = await connect.channelFetch(
      "teams",
      adapterRequest(activities())
    );
    expect(response.status).toBe(404);
    expect(response.headers.get(channelHeader)).toBeNull();
  });

  it("records each send, edit and removal, but not typing", async () => {
    const typing = { body: { type: "typing" } };
    const connect = connectForBot();
    await connect.channelFetch("teams", tokenRequest());
    await connect.channelFetch("teams", adapterRequest(activities()));
    await connect.channelFetch(
      "teams",
      adapterRequest(activities(), { body: { type: "typing" } })
    );
    await connect.channelFetch(
      "teams",
      adapterRequest(activities("activity-1"), { method: "PUT" })
    );
    // Only a POST shows typing: an edit or a removal whose body claims to
    // is still recorded.
    await connect.channelFetch(
      "teams",
      adapterRequest(activities("activity-1"), { method: "PUT", ...typing })
    );
    await connect.channelFetch(
      "teams",
      adapterRequest(activities("activity-1"), { method: "DELETE", ...typing })
    );
    microsoft.remove(conversation);
    await connect.channelFetch("teams", adapterRequest(activities()));
    const events = await audit.events();
    expect(events.map(({ detail }) => detail)).toStrictEqual([
      { outcome: "ok", method: "POST", host: botConnectorHost, status: 201 },
      { outcome: "ok", method: "PUT", host: botConnectorHost, status: 200 },
      { outcome: "ok", method: "PUT", host: botConnectorHost, status: 200 },
      { outcome: "ok", method: "DELETE", host: botConnectorHost, status: 200 },
      {
        outcome: "removed",
        method: "POST",
        host: botConnectorHost,
        status: 403,
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("Your report");
  });
});
