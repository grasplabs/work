import type { SessionApi } from "@grasp-os/shared/rpc";
import type { RpcStub } from "capnweb";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import { workspace } from "../src/durable-objects.ts";
import { personalWorkspaceId } from "../src/personal-workspace.ts";
import { reconnectCloseCode, sessionEndedCloseCode } from "../src/rpc.ts";
import { recheckedEvery, sessionRecheckMs } from "../src/session-check.ts";
import { mockIdp } from "./idp.ts";
import { acmeTenant, clientOrigin } from "./sign-in-config.ts";
import {
  callAuth,
  coreOrigin,
  countingSessionReads,
  endOtherSessions,
  entraPerson,
  openRpc,
  outcome,
  routed,
  signedIn,
  untilConnected,
  whoami,
} from "./sign-in.ts";

const idp = mockIdp();

const hour = 60 * 60 * 1000;
/** Calls a page makes at once, as a busy one does. */
const callsPerBurst = 20;
const clientHost = new URL(clientOrigin).host;

describe("sessions end", () => {
  it("after twelve hours, and aren't extended by use", async () => {
    const person = entraPerson(acmeTenant);
    // The clock stands still while signing in: Better Auth stamps the
    // session's end and then its start with clock reads of their own
    // (`createSession`: `getDate(expiresIn)`, then `new Date()`), which a
    // millisecond's tick may fall between. Held, the sign-in's window is
    // one instant, so its end is exactly twelve hours after it: a second
    // longer or shorter, or a millisecond, is caught. (Better Auth is
    // left as it is; only the test's clock is held.)
    vi.useFakeTimers({ toFake: ["Date"] });
    let signedInAt: number;
    let first: Awaited<ReturnType<typeof whoami>>;
    let again: Awaited<ReturnType<typeof whoami>>;
    try {
      signedInAt = Date.now();
      const session = await signedIn(idp, "microsoft", person);
      // Used six hours on, twice: a session refreshed by use would end
      // later than twelve hours after signing in.
      vi.setSystemTime(signedInAt + 6 * hour);
      first = await whoami(session);
      again = await whoami(session);
    } finally {
      vi.useRealTimers();
    }
    const stored = async () =>
      await env.DB.prepare(
        "SELECT created_at AS createdAt, expires_at AS expiresAt FROM sessions WHERE user_id = (SELECT user_id FROM accounts WHERE account_id = ?)"
      )
        .bind(person.sub)
        .first<{ createdAt: number; expiresAt: number }>();

    expect({
      stored: await stored(),
      shown: Date.parse(first.expiresAt),
      afterUse: again.expiresAt,
    }).toStrictEqual({
      stored: { createdAt: signedInAt, expiresAt: signedInAt + 12 * hour },
      shown: signedInAt + 12 * hour,
      afterUse: first.expiresAt,
    });
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

  it("when the person ends them from another session", async () => {
    const person = entraPerson(acmeTenant);
    const laptop = await signedIn(idp, "microsoft", person);
    const phone = await signedIn(idp, "microsoft", person);

    await expect(endOtherSessions(laptop)).resolves.toStrictEqual(["ended"]);
    await expect(outcome(whoami(phone))).resolves.toBe("auth.unauthenticated");
    await expect(whoami(laptop)).resolves.toMatchObject({
      email: person.email,
    });
  });

  it.each([
    {
      how: "ended from another session",
      end: async (_phone: string, laptop: string) => {
        const ended = await endOtherSessions(laptop);
        return ended.every((each) => each === "ended");
      },
    },
    {
      how: "signed out in another tab",
      end: async (phone: string) => {
        const signedOut = await callAuth("/sign-out", phone, {});
        return signedOut.ok;
      },
    },
  ])(
    "on every open connection too, at once, when $how: each closes, its calls are refused, and it can't be opened again",
    async ({ end }) => {
      const person = entraPerson(acmeTenant);
      const laptop = await signedIn(idp, "microsoft", person);
      const phone = await signedIn(idp, "microsoft", person);
      const first = await openRpc(phone);
      const second = await openRpc(phone);
      using session = first.core.authenticate();
      const { userId } = await session.whoami();
      await untilConnected(userId, 2);

      await expect(end(phone, laptop)).resolves.toBeTruthy();

      // Told by the person's object: nothing else closes a connection that
      // nothing is asked of.
      await expect(
        Promise.all([first.closed, second.closed])
      ).resolves.toStrictEqual([sessionEndedCloseCode, sessionEndedCloseCode]);
      await expect(session.whoami()).rejects.toBeInstanceOf(Error);
      await expect(outcome(whoami(phone))).resolves.toBe(
        "auth.unauthenticated"
      );
    }
  );

  it("reach nothing more on a connection whose telling was lost, once its reading is a few seconds old", async () => {
    const person = entraPerson(acmeTenant);
    const phone = await signedIn(idp, "microsoft", person);
    const { userId } = await whoami(phone);
    const connection = await openRpc(phone);
    await untilConnected(userId, 1);
    using session = connection.core.authenticate();
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    try {
      await session.whoami();
      // Ended with nothing told, as a telling lost on its way.
      await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?")
        .bind(userId)
        .run();
      // Within its reading's window it still answers from that reading.
      const within = await session.whoami();

      vi.setSystemTime(Date.now() + sessionRecheckMs);

      expect({
        within,
        after: await outcome(session.whoami()),
        closed: await connection.closed,
      }).toMatchObject({
        within: { userId },
        after: "auth.unauthenticated",
        closed: sessionEndedCloseCode,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reach nothing more on a connection whose session ended before its socket to the person's object opened: what it read before is read again", async () => {
    const person = entraPerson(acmeTenant);
    const phone = await signedIn(idp, "microsoft", person);
    const { userId } = await whoami(phone);
    await untilConnected(userId, 0);
    // The person's object holds off the connection's socket while the
    // connection reads, its session ends, and the telling finds no socket.
    // Let go of by the test through memory they share (one isolate): the
    // object waits on its own clock, as a promise of the test's wouldn't
    // wake it.
    const held = { now: true, started: false };
    const holding = runInDurableObject(
      workspace(env, personalWorkspaceId(userId)),
      async (_instance, state) => {
        await state.blockConcurrencyWhile(async () => {
          held.started = true;
          while (held.now) {
            // oxlint-disable-next-line no-await-in-loop -- until let go of
            await scheduler.wait(10);
          }
        });
      }
    );
    await vi.waitFor(() => {
      expect(held.started).toBeTruthy();
    });
    // The date held: no reading runs out, whatever the machine's speed.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const connection = await openRpc(phone);
    using session = connection.core.authenticate();
    const before = await session.whoami();
    await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?")
      .bind(userId)
      .run();
    held.now = false;
    await holding;
    await untilConnected(userId, 1);

    // Its reading came before the socket: read again, though it is young.
    expect({
      before,
      after: await outcome(session.whoami()),
      closed: await connection.closed,
    }).toMatchObject({
      before: { userId },
      after: "auth.unauthenticated",
      closed: sessionEndedCloseCode,
    });
  });

  it("refuse a connection's calls while the database can't be read, without closing it, and answer once it can", async () => {
    const person = entraPerson(acmeTenant);
    const phone = await signedIn(idp, "microsoft", person);
    const away = { now: false };
    const flaky = {
      ...env,
      DB: new Proxy(env.DB, {
        get: (target, property) => {
          if (property === "prepare" && away.now) {
            return () => {
              throw new Error("D1 is away.");
            };
          }
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function"
            ? (...args: unknown[]): unknown =>
                Reflect.apply(value, target, args)
            : value;
        },
      }),
    };
    const connection = await openRpc(phone, { coreEnv: flaky });
    using session = connection.core.authenticate();
    const { userId } = await session.whoami();
    await untilConnected(userId, 1);
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    try {
      away.now = true;
      vi.setSystemTime(Date.now() + sessionRecheckMs);
      const refused = await outcome(session.whoami());
      away.now = false;
      const open = await Promise.race([
        connection.closed.then(() => false),
        scheduler.wait(200).then(() => true),
      ]);

      expect({
        refused,
        open,
        after: await session.whoami(),
      }).toMatchObject({
        refused: "internal.unexpected",
        open: true,
        after: { userId },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("close a connection whose invocation made all the subrequests it may, for the page to connect again", async () => {
    const person = entraPerson(acmeTenant);
    const phone = await signedIn(idp, "microsoft", person);
    const spent = { now: false };
    const capped = {
      ...env,
      DB: new Proxy(env.DB, {
        get: (target, property) => {
          if (property === "prepare" && spent.now) {
            return () => {
              throw new Error("Too many subrequests.");
            };
          }
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function"
            ? (...args: unknown[]): unknown =>
                Reflect.apply(value, target, args)
            : value;
        },
      }),
    };
    const connection = await openRpc(phone, { coreEnv: capped });
    using session = connection.core.authenticate();
    await session.whoami();
    spent.now = true;

    // A call that reads the database, within its session reading's window.
    await outcome(session.sessions.list());

    await expect(connection.closed).resolves.toBe(reconnectCloseCode);
  });

  it("close an open connection as the session's own time runs out, with nothing told", async () => {
    const person = entraPerson(acmeTenant);
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout"],
      shouldAdvanceTime: true,
    });
    try {
      const phone = await signedIn(idp, "microsoft", person);
      const connection = await openRpc(phone);
      using session = connection.core.authenticate();
      await session.whoami();

      await vi.advanceTimersByTimeAsync(12 * hour);

      await expect(connection.closed).resolves.toBe(sessionEndedCloseCode);
    } finally {
      vi.useRealTimers();
    }
  });

  it("are not read for an idle connection, however long it stays open", async () => {
    const reads = { sessions: 0 };
    const counted = { ...env, DB: countingSessionReads(env.DB, reads) };
    const phone = await signedIn(idp, "microsoft", entraPerson(acmeTenant));
    const { userId } = await whoami(phone);
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout"],
      shouldAdvanceTime: true,
    });
    try {
      const { closed } = await openRpc(phone, { coreEnv: counted });
      await untilConnected(userId, 1);
      const opened = reads.sessions;
      await vi.advanceTimersByTimeAsync(60 * sessionRecheckMs);
      const later = reads.sessions;
      const open = await Promise.race([
        closed.then(() => false),
        scheduler.wait(50).then(() => true),
      ]);

      expect({ opened, later, open }).toStrictEqual({
        opened: 1,
        later: 1,
        open: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("are no longer read for a connection once it has closed, whatever happens to them later", async () => {
    const reads = { sessions: 0 };
    const counted = { ...env, DB: countingSessionReads(env.DB, reads) };
    const person = entraPerson(acmeTenant);
    const laptop = await signedIn(idp, "microsoft", person);
    const phone = await signedIn(idp, "microsoft", person);
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout"],
      shouldAdvanceTime: true,
    });
    try {
      const { socket, closed } = await openRpc(phone, { coreEnv: counted });
      socket.close();
      await closed;
      const afterClose = reads.sessions;
      const { userId } = await whoami(laptop);
      await endOtherSessions(laptop);
      // Told as the ending tells it, and waited for: nobody is left to read.
      await workspace(env, personalWorkspaceId(userId)).identityChanged();
      await vi.advanceTimersByTimeAsync(3 * sessionRecheckMs);
      expect(reads.sessions).toBe(afterClose);
    } finally {
      vi.useRealTimers();
    }
  });

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

// How a connection keeps its reading (`recheckedEvery`), as pure logic: a
// reading that failed for a reason other than an ended session (a busy
// database) must never keep refusing once the database is back.
describe("a reading of the session", () => {
  it("that failed isn't kept: the next ask reads again, in the same moment", async () => {
    let reads = 0;
    const read = recheckedEvery(sessionRecheckMs, async () => {
      reads += 1;
      return reads === 1
        ? await Promise.reject(new Error("The database is busy"))
        : reads;
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await expect(read()).rejects.toThrow("The database is busy");
      await expect(read()).resolves.toBe(2);
      // And the reading that succeeded is kept for the window.
      await expect(read()).resolves.toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("that failed late doesn't drop a newer one made meanwhile", async () => {
    const older = Promise.withResolvers<string>();
    const answers = [older.promise, Promise.resolve("newer")];
    let reads = 0;
    const read = recheckedEvery(sessionRecheckMs, async () => {
      const answer = answers[reads] ?? Promise.resolve("read again");
      reads += 1;
      return await answer;
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const first = read();
      // The older reading runs past its window; the next ask reads anew.
      vi.setSystemTime(Date.now() + sessionRecheckMs);
      await expect(read()).resolves.toBe("newer");
      older.reject(new Error("The database is busy"));
      await expect(first).rejects.toThrow("The database is busy");
      expect({ kept: await read(), reads }).toStrictEqual({
        kept: "newer",
        reads: 2,
      });
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
