/**
 * Reading and sending Stephen's own Gmail mailbox (src/channels.ts), and
 * Google's signing keys for the pushes that tell core of new mail
 * (src/channel-keys.ts): core's Gmail adapter hands connect each Gmail API
 * request, built with the placeholder token, and connect sends it on with
 * the mailbox's access token, or refuses it.
 *
 * The ways it can fail come first: a request sent anywhere but Gmail's
 * API, another mailbox, a call the adapter has no use for, a token of
 * core's own, the mailbox's tokens going back to core, and a mailbox that
 * isn't set up. Then what it is for.
 */
import {
  channelAnswer,
  channelCredentialPlaceholder,
  channelHeader,
} from "@grasp-os/shared/connect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { auditEvents, connectWith } from "./connect.ts";
import { googleGmailFake } from "./google-gmail-fake.ts";

const account = {
  mailbox: "stephen@acme.test",
  clientId: "gmail-client-for-tests",
  clientSecret: "gmail-client-secret-for-tests",
  refreshToken: "gmail-refresh-token-for-tests",
  accessToken: "gmail-access-token-for-tests",
};

const google = googleGmailFake(account);
/** What left connect for anywhere Google doesn't answer. */
const elsewhere: string[] = [];

beforeEach(() => {
  google.reset();
  elsewhere.length = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const answered = await google.answer(request);
    if (answered !== undefined) {
      return answered;
    }
    elsewhere.push(request.url);
    return new Response("Taken");
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

const audit = auditEvents();

const connect = () =>
  connectWith({
    GMAIL_MAILBOX: account.mailbox,
    GMAIL_CLIENT_ID: account.clientId,
    GMAIL_CLIENT_SECRET: account.clientSecret,
    GMAIL_REFRESH_TOKEN: account.refreshToken,
  });

const mailboxApi = `https://gmail.googleapis.com/gmail/v1/users/${encodeURIComponent(account.mailbox)}`;

/** A Gmail API request as the adapter sends one, unless told otherwise. */
const gmailApi = (
  url: string,
  {
    method = "GET",
    authorization = `Bearer ${channelCredentialPlaceholder}`,
    body,
  }: { method?: string; authorization?: string; body?: unknown } = {}
): Request =>
  new Request(url, {
    method,
    headers: { "content-type": "application/json", authorization },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("Stephen's own Gmail mailbox, through connect", () => {
  it("refuses anywhere but Gmail's API on Stephen's mailbox, and calls the adapter has no use for", async () => {
    const urls = [
      "https://oauth2.googleapis.com/token",
      "https://www.googleapis.com/gmail/v1/users/me/profile",
      "http://gmail.googleapis.com/gmail/v1/users/stephen%40acme.test/profile",
      "https://gmail.googleapis.com:8443/gmail/v1/users/stephen%40acme.test/profile",
      // Another mailbox, and Gmail's "me", which names whoever the token is.
      "https://gmail.googleapis.com/gmail/v1/users/ceo%40acme.test/profile",
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      // Settings, filters, forwarding, drafts, attachments, deleting.
      `${mailboxApi}/settings/forwardingAddresses`,
      `${mailboxApi}/settings/filters`,
      `${mailboxApi}/drafts`,
      `${mailboxApi}/messages/m1/attachments/a1`,
    ];
    const answers = [];
    for (const url of urls) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      const response = await connect().channelFetch("gmail", gmailApi(url));
      answers.push({
        url,
        status: response.status,
        kind: response.headers.get(channelHeader),
      });
    }
    const deleted = await connect().channelFetch(
      "gmail",
      gmailApi(`${mailboxApi}/messages/m1`, { method: "DELETE" })
    );
    const sentByGet = await connect().channelFetch(
      "gmail",
      gmailApi(`${mailboxApi}/messages/send`)
    );
    expect({
      answers,
      deleted: deleted.status,
      sentByGet: sentByGet.status,
      asked: google.asked,
      elsewhere,
    }).toStrictEqual({
      answers: urls.map((url) => ({
        url,
        status: 403,
        kind: channelAnswer.refused,
      })),
      deleted: 403,
      sentByGet: 403,
      asked: [],
      elsewhere: [],
    });
  });

  it("refuses a request without the placeholder as its token, and every request while the mailbox isn't set up", async () => {
    const own = await connect().channelFetch(
      "gmail",
      gmailApi(`${mailboxApi}/profile`, { authorization: "Bearer ya29.own" })
    );
    const unset = await connectWith({
      GMAIL_REFRESH_TOKEN: undefined,
    }).channelFetch("gmail", gmailApi(`${mailboxApi}/profile`));
    expect({
      own: own.status,
      unset: unset.status,
      unsetKind: unset.headers.get(channelHeader),
      asked: google.asked,
    }).toStrictEqual({
      own: 403,
      unset: 503,
      unsetKind: channelAnswer.unconfigured,
      asked: [],
    });
  });

  it("reads and sends with the mailbox's access token, which never goes back to core, and records each send", async () => {
    google.deliver({ from: "ann@acme.test", text: "Hello" });
    const profile = await connect().channelFetch(
      "gmail",
      gmailApi(`${mailboxApi}/profile`)
    );
    const sent = await connect().channelFetch(
      "gmail",
      gmailApi(`${mailboxApi}/messages/send`, {
        method: "POST",
        body: { raw: btoa("To: ann@acme.test\r\nSubject: Re\r\n\r\nHi") },
      })
    );
    const answers = `${await profile.text()}${await sent.text()}`;
    const events = await audit.events();
    expect({
      statuses: [profile.status, sent.status],
      asked: google.asked.map(({ host, path, token }) => ({
        host,
        path,
        token,
      })),
      recorded: events.map(({ action, target, detail }) => ({
        action,
        target,
        detail,
      })),
    }).toStrictEqual({
      statuses: [200, 200],
      // One token taken, then used for both.
      asked: [
        { host: "oauth2.googleapis.com", path: "/token", token: "" },
        {
          host: "gmail.googleapis.com",
          path: `/gmail/v1/users/${encodeURIComponent(account.mailbox)}/profile`,
          token: account.accessToken,
        },
        {
          host: "gmail.googleapis.com",
          path: `/gmail/v1/users/${encodeURIComponent(account.mailbox)}/messages/send`,
          token: account.accessToken,
        },
      ],
      recorded: [
        {
          action: "channel.call",
          target: { type: "channel", id: "gmail" },
          detail: {
            outcome: "ok",
            method: "POST",
            host: "gmail.googleapis.com",
            status: 200,
          },
        },
      ],
    });
    for (const secret of [account.accessToken, account.refreshToken]) {
      expect(answers).not.toContain(secret);
    }
    expect(JSON.stringify(events)).not.toContain("ann@acme.test");
  });

  it("gives core Google's signing keys, from Google's own key set", async () => {
    const pair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"]
    );
    if (!("publicKey" in pair)) {
      throw new TypeError("Expected a key pair");
    }
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    if (jwk instanceof ArrayBuffer) {
      throw new TypeError("Expected a JWK");
    }
    google.setKeys([
      { kty: "RSA", kid: "google-1", n: jwk.n, e: jwk.e, alg: "RS256" },
    ]);
    await expect(connect().channelSigningKeys("gmail")).resolves.toStrictEqual({
      keys: [
        { kid: "google-1", kty: "RSA", n: jwk.n, e: jwk.e, endorsements: [] },
      ],
    });
  });
});
