import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { sessionEndedCloseCode } from "../src/rpc.ts";
import { mockIdp } from "./idp.ts";
import {
  auditedDuring,
  callAuth,
  letSessionRecheckPass,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  whoami,
} from "./sign-in.ts";

// A person's own sessions (Settings → Security). The ways it can fail,
// first: listing or ending someone else's session, a session's token
// reaching the browser (it is what the cookie holds), and an ended session
// that keeps working on a connection already open.

const idp = mockIdp();

/** The tokens of `userId`'s sessions, as core stores them. */
const tokensOf = async (userId: string): Promise<string[]> => {
  const { results } = await env.DB.prepare(
    "SELECT token FROM sessions WHERE user_id = ?"
  )
    .bind(userId)
    .all<{ token: string }>();
  return results.map(({ token }) => token);
};

/** A phone's browser, as it names itself. */
const iPhoneSafari =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

/** The person's own sessions, and another browser of theirs, signed in too. */
const onTwoBrowsers = async () => {
  const me = await signedInApi(idp, "user");
  const otherBrowser = await signedIn(idp, "microsoft", me.person, {
    userAgent: iPhoneSafari,
  });
  const sessions = await me.api.sessions.list();
  const elsewhere = sessions.find(({ current }) => !current);
  if (elsewhere === undefined) {
    throw new Error("Expected the other browser's session listed");
  }
  return { me, otherBrowser, sessions, elsewhere };
};

describe("a person's own sessions", { timeout: 60_000 }, () => {
  it("list the browsers they are signed in on, this one marked, without any token, and nobody else's", async () => {
    const { me, sessions } = await onTwoBrowsers();
    const someoneElse = await signedInApi(idp, "user");
    const theirs = await someoneElse.api.sessions.list();

    // Two of theirs, this one among them; one of the other person's.
    expect(
      [sessions, theirs].map((listed) => [
        listed.length,
        listed.filter(({ current }) => current).length,
      ])
    ).toStrictEqual([
      [2, 1],
      [1, 1],
    ]);
    const listed = JSON.stringify([sessions, theirs]);
    const tokens = [
      ...(await tokensOf(me.userId)),
      ...(await tokensOf(someoneElse.userId)),
    ];
    expect(tokens.filter((token) => listed.includes(token))).toStrictEqual([]);
    // Nor where or with what they signed in, beyond the device's names.
    expect(sessions.find(({ current }) => !current)?.device).toStrictEqual({
      browser: "Safari",
      system: "iPhone",
      mobile: true,
    });
    expect(
      new Set(sessions.flatMap((session) => Object.keys(session)))
    ).toStrictEqual(
      new Set([
        "id",
        "device",
        "signedInAt",
        "lastActiveAt",
        "expiresAt",
        "current",
      ])
    );
  });

  it("end one, which closes its open connections within seconds and is audited, leaving this one signed in", async () => {
    const { me, otherBrowser, elsewhere } = await onTwoBrowsers();
    const there = await openRpc(otherBrowser);
    const thereApi = there.core.authenticate();

    const audited = await auditedDuring(async () => {
      await expect(me.api.sessions.end(elsewhere.id)).resolves.toBe("ended");
    });
    using _clock = letSessionRecheckPass();

    expect(audited).toStrictEqual([
      expect.objectContaining({
        actor: { type: "person", userId: me.userId },
        action: "session.ended",
        target: { type: "session", id: elsewhere.id },
      }),
    ]);
    await expect(outcome(thereApi.whoami())).resolves.toBe(
      "auth.unauthenticated"
    );
    await expect(there.closed).resolves.toBe(sessionEndedCloseCode);
    await expect(me.api.sessions.list()).resolves.toStrictEqual([
      expect.objectContaining({ current: true }),
    ]);
  });

  it("refuse to end another person's session, or one that names none, as not found, changing and recording nothing", async () => {
    const { me, elsewhere } = await onTwoBrowsers();
    const someoneElse = await signedInApi(idp, "admin");
    const [mine] = await me.api.sessions.list();

    const audited = await auditedDuring(async () => {
      await expect(
        Promise.all([
          someoneElse.api.sessions.end(elsewhere.id),
          someoneElse.api.sessions.end(mine?.id ?? ""),
          me.api.sessions.end(""),
          me.api.sessions.end("x".repeat(1000)),
          me.api.sessions.end(crypto.randomUUID()),
        ])
      ).resolves.toStrictEqual(Array.from({ length: 5 }, () => "not_found"));
    });

    expect(audited).toStrictEqual([]);
    await expect(me.api.sessions.list()).resolves.toHaveLength(2);
  });

  it("refuse to end the one they are on, which is signing out, changing and recording nothing", async () => {
    const { me, sessions } = await onTwoBrowsers();
    const current = sessions.find((session) => session.current);

    const audited = await auditedDuring(async () => {
      await expect(me.api.sessions.end(current?.id ?? "")).resolves.toBe(
        "current"
      );
    });
    using _clock = letSessionRecheckPass();

    expect(audited).toStrictEqual([]);
    await expect(me.api.whoami()).resolves.toMatchObject({
      userId: me.userId,
    });
    await expect(me.api.sessions.list()).resolves.toHaveLength(2);
  });
});

describe("Better Auth's own session routes", { timeout: 60_000 }, () => {
  it("are closed: they would hand the browser every session's token, or end sessions by it", async () => {
    const { me, otherBrowser } = await onTwoBrowsers();
    const [token] = await tokensOf(me.userId);

    const statuses = await Promise.all([
      callAuth("/list-sessions", me.session),
      callAuth("/revoke-session", me.session, { token }),
      callAuth("/revoke-sessions", me.session, {}),
      callAuth("/revoke-other-sessions", me.session, {}),
    ]);

    expect(statuses.map(({ status }) => status)).toStrictEqual([
      404, 404, 404, 404,
    ]);
    const bodies = await Promise.all(
      statuses.map(async (response) => await response.text())
    );
    const stored = await tokensOf(me.userId);
    expect(
      stored.filter((kept) => bodies.some((body) => body.includes(kept)))
    ).toStrictEqual([]);
    await expect(whoami(otherBrowser)).resolves.toMatchObject({
      userId: me.userId,
    });
    await expect(me.api.sessions.list()).resolves.toHaveLength(2);
  });
});
