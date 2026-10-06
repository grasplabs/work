import type { SessionApi } from "@grasp-os/shared/rpc";
import type { RpcStub } from "capnweb";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { sessionEndedCloseCode } from "../src/rpc.ts";
import { sessionRecheckMs } from "../src/session-check.ts";
import { mockIdp } from "./idp.ts";
import { acmeTenant, clientOrigin } from "./sign-in-config.ts";
import {
  callAuth,
  coreOrigin,
  countingSessionReads,
  entraPerson,
  openRpc,
  outcome,
  routed,
  signedIn,
  whoami,
} from "./sign-in.ts";

const idp = mockIdp();

const hour = 60 * 60 * 1000;
/** Calls a page makes at once, as a busy one does. */
const callsPerBurst = 20;
const clientHost = new URL(clientOrigin).host;

describe("sessions end", () => {
  it("after twelve hours, and aren't extended by use", async () => {
    const startedAt = Date.now();
    const session = await signedIn(idp, "microsoft", entraPerson(acmeTenant));
    const first = await whoami(session);
    const again = await whoami(session);

    expect(Date.parse(first.expiresAt)).toBeGreaterThan(startedAt);
    expect(Date.parse(first.expiresAt)).toBeLessThanOrEqual(
      startedAt + 12 * hour + 1000
    );
    expect(again.expiresAt).toBe(first.expiresAt);
  });

  it("when they expire", async () => {
    const person = entraPerson(acmeTenant);
    const session = await signedIn(idp, "microsoft", person);
    // Twelve hours pass.
    await env.DB.prepare(
      "UPDATE sessions SET expires_at = ? WHERE user_id = (SELECT user_id FROM accounts WHERE account_id = ?)"
    )
      .bind(Date.now() - 1000, person.sub)
      .run();

    await expect(outcome(whoami(session))).resolves.toBe(
      "auth.unauthenticated"
    );
    const response = await callAuth("/get-session", session);
    await expect(response.json()).resolves.toBeNull();
  });

  it("when the person signs out", async () => {
    const session = await signedIn(idp, "microsoft", entraPerson(acmeTenant));
    const signedOut = await callAuth("/sign-out", session, {});
    expect(signedOut.status).toBe(200);

    await expect(outcome(whoami(session))).resolves.toBe(
      "auth.unauthenticated"
    );
  });

  it("when the person revokes them from another session", async () => {
    const person = entraPerson(acmeTenant);
    const laptop = await signedIn(idp, "microsoft", person);
    const phone = await signedIn(idp, "microsoft", person);

    const revoked = await callAuth("/revoke-other-sessions", laptop, {});
    expect(revoked.status).toBe(200);
    await expect(outcome(whoami(phone))).resolves.toBe("auth.unauthenticated");
    await expect(whoami(laptop)).resolves.toMatchObject({
      email: person.email,
    });
  });

  it.each([
    {
      how: "revoked from another session",
      end: async (_phone: string, laptop: string) =>
        await callAuth("/revoke-other-sessions", laptop, {}),
    },
    {
      how: "signed out",
      end: async (phone: string) => await callAuth("/sign-out", phone, {}),
    },
  ])(
    "on an open connection too, within a few seconds, when $how: its calls are refused, it closes, idle or not, and can't be opened again",
    async ({ end }) => {
      const person = entraPerson(acmeTenant);
      const laptop = await signedIn(idp, "microsoft", person);
      const phone = await signedIn(idp, "microsoft", person);
      // Held from before the connections open, so their rechecks keep it.
      // It goes on with real time too, so the close a refusal schedules
      // comes on its own; only the window is skipped.
      vi.useFakeTimers({
        toFake: ["Date", "setTimeout", "clearTimeout"],
        shouldAdvanceTime: true,
      });
      try {
        const busy = await openRpc(phone);
        const idle = await openRpc(phone);
        using session = busy.core.authenticate();
        // Read late in the first window (a second before its end, as real
        // time moves the clock too): the busy connection's reading then
        // holds most of a window past the idle one's.
        await vi.advanceTimersByTimeAsync(sessionRecheckMs - 1000);
        await expect(session.whoami()).resolves.toMatchObject({
          email: person.email,
        });

        const ended = await end(phone, laptop);
        expect(ended.status).toBe(200);
        await vi.advanceTimersByTimeAsync(sessionRecheckMs);

        // Both closed by their own recheck, without a call: within a window
        // of the session ending, however late the last reading was.
        await expect(
          Promise.all([busy.closed, idle.closed])
        ).resolves.toStrictEqual([
          sessionEndedCloseCode,
          sessionEndedCloseCode,
        ]);
        await expect(session.whoami()).rejects.toBeInstanceOf(Error);
        await expect(outcome(whoami(phone))).resolves.toBe(
          "auth.unauthenticated"
        );
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it("are read once every few seconds on an open connection, however many calls it carries", async () => {
    const reads = { sessions: 0 };
    const counted = { ...env, DB: countingSessionReads(env.DB, reads) };
    const session = await signedIn(idp, "microsoft", entraPerson(acmeTenant));
    const burst = async (api: RpcStub<SessionApi>) =>
      await Promise.all(
        Array.from({ length: callsPerBurst }, async () => await api.whoami())
      );
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { core } = await openRpc(session, { coreEnv: counted });
      // The upgrade reads the cookie to decide what the connection gets.
      const opening = reads.sessions;
      using api = core.authenticate();
      await burst(api);
      const first = reads.sessions - opening;
      vi.setSystemTime(Date.now() + sessionRecheckMs - 1);
      await burst(api);
      const stillFirst = reads.sessions - opening;
      vi.setSystemTime(Date.now() + 1);
      await burst(api);
      await burst(api);
      expect({
        opening,
        first,
        stillFirst,
        second: reads.sessions - opening,
      }).toStrictEqual({ opening: 1, first: 1, stillFirst: 1, second: 2 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("cross-site WebSocket upgrades", () => {
  it("are refused, even with a valid session", async () => {
    const session = await signedIn(idp, "microsoft", entraPerson(acmeTenant));
    const origins = [
      "https://evil.example",
      `https://${clientHost}.evil.example`,
      `https://evil.${clientHost}`,
      `http://${clientHost}`,
      // Core's own address is not the client's hostname the router forwards.
      coreOrigin,
      "null",
    ];
    const responses = await Promise.all(
      origins.map(
        async (origin) =>
          await routed("/rpc", {
            headers: { Upgrade: "websocket", Origin: origin, cookie: session },
          })
      )
    );
    for (const response of responses) {
      expect(response.status).toBe(403);
      expect(response.webSocket).toBeNull();
    }
  });

  it("are refused without an Origin", async () => {
    const session = await signedIn(idp, "microsoft", entraPerson(acmeTenant));
    const response = await routed("/rpc", {
      headers: { Upgrade: "websocket", cookie: session },
    });
    expect(response.status).toBe(403);
    expect(response.webSocket).toBeNull();
  });

  it("from the client's own page are accepted", async () => {
    const session = await signedIn(idp, "microsoft", entraPerson(acmeTenant));
    const response = await routed("/rpc", {
      headers: { Upgrade: "websocket", Origin: clientOrigin, cookie: session },
    });
    expect(response.status).toBe(101);
    response.webSocket?.accept();
    response.webSocket?.close();
  });
});
