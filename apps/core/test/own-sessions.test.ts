import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { sessionEndedCloseCode } from "../src/rpc.ts";
import { mockIdp } from "./idp.ts";
import {
  auditedDuring,
  letSessionRecheckPass,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
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

/** The person's own sessions, and another browser of theirs, signed in too. */
const onTwoBrowsers = async () => {
  const me = await signedInApi(idp, "user");
  const otherBrowser = await signedIn(idp, "microsoft", me.person);
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
        detail: { current: false },
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

  it("end the one they are on, too, which then closes", async () => {
    const me = await signedInApi(idp, "user");
    const [current] = await me.api.sessions.list();

    await expect(me.api.sessions.end(current?.id ?? "")).resolves.toBe("ended");
    using _clock = letSessionRecheckPass();

    await expect(outcome(me.api.whoami())).resolves.toBe(
      "auth.unauthenticated"
    );
    await expect(me.closed).resolves.toBe(sessionEndedCloseCode);
  });
});
