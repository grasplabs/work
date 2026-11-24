import { randomToken, toBase64 } from "@grasp-os/shared/encoding";
import type { Roster } from "@grasp-os/shared/onboarding";
import { transcriptionPath } from "@grasp-os/shared/voice";
import type { TranscriptionStart } from "@grasp-os/shared/voice";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { onboardingStore } from "../src/onboarding/store.ts";
import { sessionRecheckMs } from "../src/session-check.ts";
import type { RealtimeSocket } from "./ai-providers-fake.ts";
import { allEvents, logHead, eventsAfter } from "./audit-events.ts";
import { platformOpenAiKey } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import {
  accountOf,
  onLink,
  openLinkAs,
  participate,
  signedInAs,
} from "./interview-link.ts";
import type { Device } from "./interview-link.ts";
import { spentMicros } from "./model-usage.ts";
import { closeWhenTestEnds } from "./open-sockets.ts";
import {
  actOnRealtime,
  connectWithoutGraspKeys,
  newestSocket,
  realtimeSockets,
} from "./platform-providers.ts";
import { clientOrigin, signInConfig } from "./sign-in-config.ts";
import {
  openRpc,
  outcome,
  routed,
  signedIn,
  signedInWithRole,
  staffPerson,
  unique,
  whoami,
  withSignIn,
} from "./sign-in.ts";

// What someone says, written down as they say it, relayed through core
// over a WebSocket on the page's own origin (src/onboarding/
// transcription.ts). OpenAI's realtime transcription, Grasp's own by
// default (@grasp-os/shared/platform-ai), reached through connect, is the
// outside system: a fake behind connect's fetch that answers the first
// audio of a stretch with a delta, and each commit with a transcript
// (test/ai-providers-fake.ts). Connect, the store, the link checks and the
// audit log are real. The ways it can fail, tried here (GRA-361, C4 and
// A1):
//
// - A socket on a link that isn't one, on another person's link, on the
//   link of someone who didn't agree to take part (GRA-329, T1), for
//   nobody signed in, for Grasp's staff who aren't admins, from another
//   site, or one that sends audio before it says who it is for.
// - One side closing and the other left open, holding the upstream (and
//   its bill) or the page's microphone.
// - Audio kept anywhere: the store, the database, the audit log.
// - Listening on after the link or the member no longer may: the person
//   taken off the list, the onboarding paused, the person withdrawing
//   (GRA-329, T5) or signing out, the member removed.
// - Sockets opened side by side on one link, or by one member, each
//   hearing a day's budget; a member hearing more than an admin did, or an
//   admin twice; one member's dictation spending another's budget.
// - Sockets opened and closed with nothing said, each an upstream session
//   and a model call the gateway audits, costing nothing of the day's
//   budget, so a loop of them never runs out.
// - A member's dictation (GRA-1998) audited as the onboarding's, more than
//   once, as the system's, or counted in the onboarding's use.
// - Listening with a model the gateway or the rules don't let it use
//   (GRA-1064). It is charged to Grasp's own key, never the
//   deployment's.
// - What a page is told up front of whether dictation is set up
//   (`dictationSetUp`) saying something else than a dictation then does:
//   offered where core refuses it, or hidden where core listens, for a
//   member who isn't an admin too; a day's budget spent read as not set
//   up; the question itself a model call, audited or charged; or answered
//   to Grasp's staff, whose session reaches the onboarding alone.

const idp = mockIdp();

const dayMs = 24 * 60 * 60 * 1000;

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** What a session answers, as far as these tests read it: the device's key. */

/** The realtime sockets OpenAI's fake took while `run` ran, as they are now. */
interface Upstream {
  opened: RealtimeSocket[];
}

let monthsUsed = 0;

/** A month no other test counts spend in: from 2800, clear of other files. */
const newMonth = (): string => {
  monthsUsed += 1;
  return `${2800 + Math.floor(monthsUsed / 12)}-${String((monthsUsed % 12) + 1).padStart(2, "0")}`;
};

/**
 * What `run` returns with model spend counted in `month`, and the
 * realtime sockets OpenAI's fake took meanwhile.
 */
const relaying = async <T>(
  run: () => Promise<T>,
  { month }: { month?: string } = {}
): Promise<{ upstream: Upstream; result: T }> => {
  const before = env.SPEND_MONTH;
  const { length: known } = await realtimeSockets();
  if (month !== undefined) {
    env.SPEND_MONTH = month;
  }
  try {
    const result = await run();
    const sockets = await realtimeSockets();
    return { upstream: { opened: sockets.slice(known) }, result };
  } finally {
    env.SPEND_MONTH = before;
  }
};

/** How the newest realtime socket closed, once it did. */
const upstreamClosed = async (): Promise<number | null> =>
  await vi.waitFor(
    async () => {
      const last = await newestSocket();
      if (last?.closed === null || last === undefined) {
        throw new Error("The upstream is still open");
      }
      return last.closed;
    },
    { timeout: 10_000, interval: 50 }
  );

/**
 * An onboarding running since yesterday with two people in Ops, each
 * link out and opened on a device of their own, who agreed to take part
 * unless `participating` is false: their secrets and keys.
 */
const openedTwo = async (participating = true) => {
  const store = onboardingStore(env);
  const ids = [`ada-${unique()}`, `bo-${unique()}`] as const;
  const roster: Roster = {
    teams: [{ id: "ops", name: "Ops", lead: null, does: "", off: false }],
    people: ids.map((id) => ({
      id,
      name: `Person ${id}`,
      team: "ops",
      email: `${id}@acme.test`,
      title: "",
      away: false,
    })),
  };
  const by = { type: "system" } as const;
  await store.setPaused(false, by);
  await store.saveRoster(roster, by);
  await store.savePlan({ start: isoDay(Date.now() - dayMs), days: 14 }, by);
  await store.setAgreements(
    { processing: true, assessment: true, council: "none" },
    by
  );
  await store.releaseDue();
  const [ada, bo] = await Promise.all(
    ids.map(async (person) => {
      const link = await store.linkOf(person);
      const secret = link?.split("#")[1] ?? "";
      const { link: device } = await openLinkAs(
        secret,
        await signedInAs(`${person}@acme.test`)
      );
      if (participating) {
        await participate(device);
      }
      return device;
    })
  );
  if (ada === undefined || bo === undefined) {
    throw new Error("Expected two links");
  }
  return { ada, bo, roster };
};

/** What core sends the page, as these tests read it. */
const messageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    session: z.string(),
    maxSeconds: z.number(),
  }),
  z.object({ type: z.literal("partial"), text: z.string() }),
  z.object({
    type: z.literal("final"),
    text: z.string(),
    words: z.array(
      z.object({ text: z.string(), startMs: z.number(), endMs: z.number() })
    ),
  }),
  z.object({
    type: z.literal("error"),
    code: z.string(),
    message: z.string(),
  }),
]);
type Message = z.infer<typeof messageSchema>;

/** A socket the page opened to the relay, read a message at a time. */
const listen = async (headers: Record<string, string> = {}, coreEnv = env) => {
  const response = await routed(
    transcriptionPath,
    { headers: { Upgrade: "websocket", Origin: clientOrigin, ...headers } },
    coreEnv
  );
  const socket = response.webSocket;
  if (!socket) {
    throw new Error(`Expected a WebSocket, got ${response.status}`);
  }
  const received: Message[] = [];
  let read = 0;
  let arrived = Promise.withResolvers<null>();
  const closed = Promise.withResolvers<number>();
  socket.addEventListener("message", (event) => {
    received.push(messageSchema.parse(JSON.parse(String(event.data))));
    arrived.resolve(null);
  });
  socket.addEventListener("close", (event) => {
    closed.resolve(event.code);
    arrived.resolve(null);
  });
  socket.accept();
  closeWhenTestEnds(socket);
  return {
    socket,
    closed: closed.promise,
    /**
     * Sends the first frame: a link in it is its secret alone, as the page
     * sends it; its session went with the upgrade (`listen`'s cookie).
     */
    start: ({
      link,
      ...start
    }: (TranscriptionStart | Record<string, unknown>) & {
      link?: { secret: string };
    }) => {
      socket.send(
        JSON.stringify(
          link === undefined
            ? start
            : { ...start, link: { secret: link.secret } }
        )
      );
    },
    /** The next message core sent; `undefined` once it closed with none left. */
    next: async (): Promise<Message | undefined> => {
      while (read === received.length && socket.readyState === WebSocket.OPEN) {
        arrived = Promise.withResolvers<null>();
        // oxlint-disable-next-line no-await-in-loop -- one message at a time
        await arrived.promise;
      }
      const message = received[read];
      read += 1;
      return message;
    },
    /** Every message not read yet, once the socket closed, and how it closed. */
    ended: async () => {
      const code = await closed.promise;
      return { messages: received.slice(read), code };
    },
  };
};

/** A tenth of a second of 16 kHz audio: 3,200 bytes of `fill`. */
const tenthOfASecond = (fill = 7): Uint8Array =>
  new Uint8Array(3200).fill(fill);

/** An error's code and the close code after it. */
const refusalOf = async (page: Awaited<ReturnType<typeof listen>>) => {
  const { messages, code } = await page.ended();
  return {
    errors: messages.map((message) =>
      message.type === "error" ? message.code : message.type
    ),
    code,
  };
};

/** Two seconds of 8 kHz audio: 32,000 bytes, a frame's most. */
const twoSeconds = (): Uint8Array => new Uint8Array(32_000).fill(7);

/** A start on `link`, its audio at 8 kHz. */
const slowStart = (link: Device) =>
  ({ type: "start", language: "en", sampleRate: 8000, link }) as const;

/** What `seconds` heard cost, in micros: $0.60 an hour. */
const heardMicros = (seconds: number): number =>
  Math.round(((seconds * 0.6) / 3600) * 1e6);

/** What the organization's keys spent in `month`: nothing heard counts there. */
const deploymentSpend = async (month: string) => await spentMicros(month);

/** What Grasp's own key spent in `month`: what was heard counts there. */
const graspSpend = async (month: string) =>
  await spentMicros(month, { credential: "platform" });

/**
 * Holds `seconds` of a link's day as a socket opened elsewhere would,
 * so the next socket on it holds only what is left.
 */
const holdOfDay = async (personId: string, seconds: number) => {
  await onboardingStore(env).transcriptionOpened({
    note: {
      id: crypto.randomUUID(),
      by: { type: "system" },
      person: personId,
    },
    who: `link:${personId}:heard`,
    budget: 60 * 60,
    most: seconds,
  });
};

/** Seconds of audio the onboarding counted as heard for `purpose`. */
const heardCounted = async (purpose: string): Promise<number> => {
  const rows = await onboardingStore(env).usage();
  return rows
    .filter((row) => row.purpose === purpose && row.model === "transcription")
    .reduce((sum, { seconds }) => sum + seconds, 0);
};

/** A member's start: no link, the session the upgrade carried says who. */
const memberStart = {
  type: "start",
  language: "en",
  sampleRate: 16_000,
} as const;

/** Whether dictation is set up, as the page behind `cookie` is told. */
const dictationSetUp = async (cookie: string, coreEnv = env) => {
  const { core } = await openRpc(cookie, { coreEnv });
  try {
    using session = core.authenticate();
    return await session.dictationSetUp();
  } finally {
    core[Symbol.dispose]();
  }
};

/** The purposes the gateway is told a live transcription is for. */
const livePurposes: ReadonlySet<unknown> = new Set([
  "chat.dictation",
  "onboarding.transcription",
]);

/** What the audit log holds after `head` of live transcription, oldest first. */
const transcriptionAudited = async (head: number) => {
  const events = await eventsAfter(head);
  return events
    .filter(
      ({ action, detail }) =>
        action.startsWith("onboarding.transcription.") ||
        (action === "model.call" && livePurposes.has(detail?.purpose))
    )
    .map(({ actor, action, detail }) => ({
      actor,
      action,
      purpose: detail?.purpose,
      platform: detail?.platform,
      seconds: detail?.seconds,
      // What an entry of the onboarding's holds, by name.
      keys:
        action === "model.call"
          ? undefined
          : Object.keys(detail ?? {}).toSorted(),
    }));
};

/** Bytes as text, so audio written anywhere as text or bytes shows. */
const asText = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    inner instanceof ArrayBuffer ? new TextDecoder().decode(inner) : inner
  );

/** Tables SQLite and the runtime keep for themselves. */
const ownTable = /^(?:_cf|sqlite_|d1_)/u;

/** Everything the onboarding's store and the database hold, as text. */
const everythingStored = async (): Promise<string> => {
  const stored = await runInDurableObject(
    onboardingStore(env),
    (_object, state) =>
      state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table'"
        )
        .toArray()
        .filter(({ name }) => !ownTable.test(name))
        .map(({ name }) =>
          asText(state.storage.sql.exec(`SELECT * FROM "${name}"`).toArray())
        )
        .join("\n")
  );
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table'"
  ).all<{ name: string }>();
  const tables = await Promise.all(
    results
      .filter(({ name }) => !ownTable.test(name))
      .map(async ({ name }) => {
        const rows = await env.DB.prepare(`SELECT * FROM "${name}"`).all();
        return asText(rows.results);
      })
  );
  return [stored, ...tables, asText(await allEvents())].join("\n");
};

describe("live transcription relayed through core", { timeout: 60_000 }, () => {
  it("relays a link's audio, resampled for the session, and hears it back as partial and final transcripts", async () => {
    const { ada } = await openedTwo();
    const before = await heardCounted("interviews");

    const { upstream, result } = await relaying(async () => {
      const page = await listen({ cookie: ada.cookie });
      page.start({
        type: "start",
        language: "nl",
        sampleRate: 16_000,
        link: ada,
      });
      const ready = await page.next();
      page.socket.send(tenthOfASecond());
      const partial = await page.next();
      page.socket.send(JSON.stringify({ type: "commit" }));
      const final = await page.next();
      page.socket.close(1000, "Done");
      return { ready: ready?.type, partial, final };
    });

    const [opened] = upstream.opened;
    const session = z
      .object({
        type: z.string(),
        audio: z.object({
          input: z.object({
            format: z.unknown(),
            transcription: z.object({
              model: z.string(),
              language: z.string(),
              prompt: z.string(),
            }),
            turn_detection: z.unknown(),
          }),
        }),
      })
      .parse(opened?.session);
    expect({
      ...result,
      path: opened?.path,
      authorization: opened?.authorization,
      type: session.type,
      format: session.audio.input.format,
      model: session.audio.input.transcription.model,
      language: session.audio.input.transcription.language,
      // What to listen out for is the store's: the team, and its people.
      keyterms: ["Ops", "Person"].every((term) =>
        session.audio.input.transcription.prompt.includes(term)
      ),
      turns: session.audio.input.turn_detection,
      events: opened?.events,
      // A tenth of a second at 16 kHz, as 24 kHz: 2,400 samples but the one
      // after the last, which waits for more; each as sent.
      audio: opened?.audioBytes,
      samples: opened?.firstSamples,
    }).toStrictEqual({
      ready: "ready",
      partial: { type: "partial", text: "Hello" },
      // The session times no words.
      final: { type: "final", text: "Hello there", words: [] },
      path: "/v1/realtime?intent=transcription",
      // Grasp's key, which connect added: core sent none.
      authorization: `Bearer ${platformOpenAiKey}`,
      type: "transcription",
      format: { type: "audio/pcm", rate: 24_000 },
      model: "gpt-4o-transcribe",
      language: "nl",
      keyterms: true,
      turns: { type: "server_vad" },
      events: [
        "session.update",
        "input_audio_buffer.append",
        "input_audio_buffer.commit",
      ],
      audio: 4798,
      samples: Array.from({ length: 8 }, () => 0x07_07),
    });
    // A tenth of a second heard, counted once the socket closed.
    await vi.waitFor(async () => {
      await expect(heardCounted("interviews")).resolves.toBeCloseTo(
        before + 0.1
      );
    });
  });

  it("answers a commit the session already settled at a pause with an empty final, in its place", async () => {
    const { ada } = await openedTwo();

    const { upstream, result } = await relaying(async () => {
      const page = await listen({ cookie: ada.cookie });
      page.start({
        type: "start",
        language: "en",
        sampleRate: 16_000,
        link: ada,
      });
      await page.next();
      page.socket.send(tenthOfASecond());
      await page.next();
      page.socket.send(JSON.stringify({ type: "commit" }));
      // Nothing sent since: nothing to settle.
      page.socket.send(JSON.stringify({ type: "commit" }));
      const finals = [await page.next(), await page.next()];
      page.socket.close(1000, "Done");
      return finals;
    });

    expect({
      finals: result,
      commits: upstream.opened[0]?.events.filter(
        (type) => type === "input_audio_buffer.commit"
      ).length,
    }).toStrictEqual({
      finals: [
        { type: "final", text: "Hello there", words: [] },
        { type: "final", text: "", words: [] },
      ],
      commits: 2,
    });
  });

  it("sends one final for a stretch the session split at a pause, its first part's words written down after the page's commit", async () => {
    const { ada } = await openedTwo();

    const { result } = await relaying(async () => {
      const page = await listen({ cookie: ada.cookie });
      page.start({
        type: "start",
        language: "en",
        sampleRate: 16_000,
        link: ada,
      });
      await page.next();
      page.socket.send(tenthOfASecond());
      const first = await page.next();
      // The person pauses: the session settles what they said so far, and
      // writes it down only after the rest.
      await actOnRealtime({ pause: true });
      await vi.waitFor(async () => {
        const socket = await newestSocket();
        expect(socket?.paused).toBe(1);
      });
      page.socket.send(tenthOfASecond());
      const both = await page.next();
      page.socket.send(JSON.stringify({ type: "commit" }));
      const final = await page.next();
      // Nothing said since: this commit's own final, empty.
      page.socket.send(JSON.stringify({ type: "commit" }));
      const next = await page.next();
      page.socket.close(1000, "Done");
      return { first, both, final, next };
    });

    expect(result).toStrictEqual({
      first: { type: "partial", text: "Hello" },
      // The stretch so far: the part before the pause, then this one.
      both: { type: "partial", text: "Hello Hello" },
      final: {
        type: "final",
        text: "Before the pause Hello there",
        words: [],
      },
      next: { type: "final", text: "", words: [] },
    });
  });

  it.each([
    ["a link that isn't one", "unknown", "interview.link_invalid"],
    [
      "another person's link, signed in as this one",
      "other",
      "interview.link_invalid",
    ],
    ["a link, signed in as nobody", "signedOut", "interview.sign_in"],
    [
      "a link whose person didn't agree to take part",
      "unagreed",
      "interview.not_participating",
    ],
    ["nobody signed in, without a link", "none", "auth.unauthenticated"],
    [
      "a session for an interview alone, without a link",
      "interviewOnly",
      "auth.unauthenticated",
    ],
    ["Grasp's staff who aren't admins, no link", "staff", "role.forbidden"],
    ["audio before it says whose it is", "audio", "transcription.invalid"],
    ["a start the relay doesn't take", "invalid", "transcription.invalid"],
  ] as const)(
    "refuses a socket for %s, opening nothing upstream",
    async (_, kind, refusal) => {
      const { ada, bo } = await openedTwo(kind !== "unagreed");
      const headers: Record<string, string> = {};
      // Staff the deployment's config makes a member, not an admin.
      const coreEnv =
        kind === "staff"
          ? withSignIn({ staff: { ...signInConfig.staff, role: "user" } })
          : env;
      if (kind === "staff") {
        headers.cookie = await signedIn(idp, "grasp-staff", staffPerson(), {
          coreEnv,
        });
      } else if (kind === "interviewOnly") {
        // As signing in for an interview makes one before Grasp's go.
        const member = await signedInWithRole(idp, "user");
        await env.DB.prepare(
          "UPDATE sessions SET interview = 1 WHERE user_id = ?"
        )
          .bind(member.userId)
          .run();
        headers.cookie = member.session;
      } else if (kind !== "none" && kind !== "signedOut") {
        headers.cookie = ada.cookie;
      }

      const { upstream, result } = await relaying(async () => {
        const page = await listen(headers, coreEnv);
        if (kind === "audio") {
          page.socket.send(tenthOfASecond());
        } else if (kind === "invalid") {
          page.start({
            type: "start",
            language: "en",
            sampleRate: 1234,
            link: ada,
          });
        } else {
          const link = {
            unknown: { secret: randomToken() },
            other: { secret: bo.secret },
            signedOut: ada,
            unagreed: ada,
            none: undefined,
            interviewOnly: undefined,
            staff: undefined,
          }[kind];
          page.start({
            type: "start",
            language: "en",
            sampleRate: 16_000,
            ...(link === undefined ? {} : { link }),
          });
        }
        return await refusalOf(page);
      });

      expect({ ...result, upstream: upstream.opened.length }).toStrictEqual({
        errors: [refusal],
        code: 1008,
        upstream: 0,
      });
    }
  );

  it.each(["admin", "user"] as const)(
    "opens no socket from another site, even with the session of a member signed in as %s",
    async (role) => {
      const { session } = await signedInWithRole(idp, role);

      const response = await routed(transcriptionPath, {
        headers: {
          Upgrade: "websocket",
          Origin: "https://elsewhere.example",
          cookie: session,
        },
      });

      expect([response.status, response.webSocket]).toStrictEqual([403, null]);
    }
  );

  it.each([
    ["the page leaves", "page", { upstream: 1000, page: 1000, errors: [] }],
    [
      "the upstream ends",
      "upstream",
      { upstream: 1000, page: 1000, errors: [] },
    ],
    [
      "the upstream fails",
      "failed",
      { upstream: 1011, page: 1011, errors: ["transcription.failed"] },
    ],
  ] as const)("closes both sides when %s", async (_, side, closes) => {
    const { ada } = await openedTwo();

    const { result } = await relaying(async () => {
      const page = await listen({ cookie: ada.cookie });
      page.start({
        type: "start",
        language: "en",
        sampleRate: 16_000,
        link: ada,
      });
      await page.next();
      if (side === "page") {
        page.socket.close(1000, "Done");
      } else {
        await actOnRealtime({ close: side === "upstream" ? 1000 : 1011 });
      }
      const [upstreamCode, ended] = await Promise.all([
        upstreamClosed(),
        page.ended(),
      ]);
      return {
        upstream: upstreamCode,
        page: ended.code,
        errors: ended.messages.map((message) =>
          message.type === "error" ? message.code : message.type
        ),
      };
    });

    expect(result).toStrictEqual(closes);
  });

  it("shares one budget between sockets opened side by side on a link, and gives back what a socket didn't hear", async () => {
    const { ada } = await openedTwo();
    const start = {
      type: "start",
      language: "en",
      sampleRate: 16_000,
      link: ada,
    } as const;

    const { result } = await relaying(async () => {
      // A day's hour on the link: four sockets of fifteen minutes.
      const pages = await Promise.all(
        Array.from(
          { length: 4 },
          async () => await listen({ cookie: ada.cookie })
        )
      );
      for (const page of pages) {
        page.start(start);
      }
      const ready = await Promise.all(
        pages.map(async (page) => await page.next())
      );
      const fifth = await listen({ cookie: ada.cookie });
      fifth.start(start);
      const spent = await refusalOf(fifth);
      // One socket hears a tenth of a second and leaves: the rest is back.
      const [first] = pages;
      first?.socket.send(tenthOfASecond());
      await first?.next();
      first?.socket.close(1000, "Done");
      await first?.ended();
      const again = await vi.waitFor(async () => {
        const page = await listen({ cookie: ada.cookie });
        page.start(start);
        const message = await page.next();
        if (message?.type !== "ready") {
          throw new Error(`Expected ready, got ${message?.type}`);
        }
        return message.maxSeconds;
      });
      return {
        ready: ready.map((message) =>
          message?.type === "ready" ? message.maxSeconds : message?.type
        ),
        spent,
        again,
      };
    });

    expect(result).toStrictEqual({
      ready: [900, 900, 900, 900],
      spent: { errors: ["transcription.limited"], code: 1008 },
      again: 899,
    });
  });

  it.each([
    ["the person is taken off the list", "removed", "interview.link_invalid"],
    ["the onboarding is paused", "paused", "interview.paused"],
    ["the person withdraws", "withdrawn", "interview.withdrawn"],
    ["the person signs out", "signed_out", "interview.sign_in"],
    ["the member is removed", "member_removed", "auth.unauthenticated"],
    ["the member signs out", "member_signed_out", "auth.unauthenticated"],
  ] as const)(
    "stops listening, upstream too, once %s while the socket is open",
    async (_, change, refusal) => {
      const { ada, roster } = await openedTwo();
      const member =
        change === "member_removed" || change === "member_signed_out"
          ? await signedInWithRole(idp, "user")
          : undefined;
      const store = onboardingStore(env);
      const by = { type: "system" } as const;

      const { result } = await relaying(async () => {
        const page = await listen({
          cookie: member === undefined ? ada.cookie : member.session,
        });
        page.start({
          type: "start",
          language: "en",
          sampleRate: 16_000,
          ...(member === undefined ? { link: ada } : {}),
        });
        await page.next();
        if (change === "removed") {
          // Ada leaves; Bo stays.
          await store.saveRoster(
            { ...roster, people: roster.people.slice(1) },
            by
          );
        } else if (change === "paused") {
          await store.setPaused(true, by);
        } else if (change === "withdrawn") {
          await onLink({ action: "withdraw", ...ada });
        } else if (change === "signed_out") {
          await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?")
            .bind(await accountOf(ada))
            .run();
        } else if (change === "member_removed") {
          await env.DB.prepare("DELETE FROM members WHERE user_id = ?")
            .bind(member?.userId ?? "")
            .run();
        } else {
          await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?")
            .bind(member?.userId ?? "")
            .run();
        }
        const [ended, upstreamCode] = await Promise.all([
          refusalOf(page),
          upstreamClosed(),
        ]);
        return { ...ended, upstream: upstreamCode };
      });

      expect(result).toStrictEqual({
        errors: [refusal],
        code: 1008,
        upstream: 1000,
      });
    }
  );

  it.each(["user", "builder", "admin"] as const)(
    "relays for a member signed in as %s, audited once as their own dictation, never in the onboarding's name or use",
    async (role) => {
      const { session, userId } = await signedInWithRole(idp, role);
      const head = await logHead();
      const before = await heardCounted("reading");

      const { result, upstream } = await relaying(async () => {
        const page = await listen({ cookie: session });
        page.start(memberStart);
        const ready = await page.next();
        page.socket.send(tenthOfASecond());
        const partial = await page.next();
        page.socket.close(1000, "Done");
        await page.ended();
        return [ready?.type, partial?.type];
      });

      await vi.waitFor(async () => {
        await expect(transcriptionAudited(head)).resolves.toStrictEqual([
          {
            actor: { type: "person", userId },
            action: "model.call",
            purpose: "chat.dictation",
            platform: "dictation",
            // Whole seconds, rounded up, as the gateway charges.
            seconds: 1,
            keys: undefined,
          },
        ]);
      });
      expect({
        result,
        upstreams: upstream.opened.length,
        onboarding: (await heardCounted("reading")) - before,
      }).toStrictEqual({
        result: ["ready", "partial"],
        upstreams: 1,
        onboarding: 0,
      });
    }
  );

  it.each(["user", "admin"] as const)(
    "shares one budget of half an hour between the sockets a member signed in as %s opens side by side, their own, and gives back what a socket didn't hear",
    async (role) => {
      const member = await signedInWithRole(idp, role);
      const other = await signedInWithRole(idp, "user");

      const { result } = await relaying(async () => {
        // A day's half hour: two sockets of fifteen minutes.
        const pages = await Promise.all(
          Array.from(
            { length: 2 },
            async () => await listen({ cookie: member.session })
          )
        );
        for (const page of pages) {
          page.start(memberStart);
        }
        const ready = await Promise.all(
          pages.map(async (page) => await page.next())
        );
        const third = await listen({ cookie: member.session });
        third.start(memberStart);
        const spent = await refusalOf(third);
        // Someone else's day is untouched by it.
        const theirs = await listen({ cookie: other.session });
        theirs.start(memberStart);
        const others = await theirs.next();
        // One socket hears a tenth of a second and leaves: the rest is back.
        const [first] = pages;
        first?.socket.send(tenthOfASecond());
        await first?.next();
        first?.socket.close(1000, "Done");
        await first?.ended();
        const again = await vi.waitFor(async () => {
          const page = await listen({ cookie: member.session });
          page.start(memberStart);
          const message = await page.next();
          if (message?.type !== "ready") {
            throw new Error(`Expected ready, got ${message?.type}`);
          }
          return message.maxSeconds;
        });
        return {
          ready: ready.map((message) =>
            message?.type === "ready" ? message.maxSeconds : message?.type
          ),
          spent,
          others: others?.type === "ready" ? others.maxSeconds : others?.type,
          again,
        };
      });

      expect(result).toStrictEqual({
        ready: [900, 900],
        spent: { errors: ["transcription.limited"], code: 1008 },
        others: 900,
        again: 899,
      });
    }
  );

  it("counts each socket a member opens against their day as the gateway charges it, a second at least, until none is left", async () => {
    const { session, userId } = await signedInWithRole(idp, "user");
    // Three seconds left of their day.
    await onboardingStore(env).transcriptionOpened({
      who: `user:${userId}:heard`,
      budget: 30 * 60,
      most: 30 * 60 - 3,
    });
    const head = await logHead();

    const { result } = await relaying(async () => {
      const left: number[] = [];
      for (let opened = 0; opened < 3; opened += 1) {
        // Opened and closed with nothing said, once the last one's close is counted.
        // oxlint-disable-next-line no-await-in-loop -- one socket after another
        const { page, maxSeconds } = await vi.waitFor(async () => {
          const next = await listen({ cookie: session });
          next.start(memberStart);
          const message = await next.next();
          if (message?.type !== "ready") {
            throw new Error(`Expected ready, got ${message?.type}`);
          }
          return { page: next, maxSeconds: message.maxSeconds };
        });
        left.push(maxSeconds);
        page.socket.close(1000, "Done");
        // oxlint-disable-next-line no-await-in-loop -- one socket after another
        await page.ended();
      }
      // Each is a model call of theirs, however little it heard.
      const calls = await vi.waitFor(async () => {
        const audited = await transcriptionAudited(head);
        expect(audited).toHaveLength(3);
        return audited.length;
      });
      const fourth = await listen({ cookie: session });
      fourth.start(memberStart);
      return { left, calls, spent: await refusalOf(fourth) };
    });

    expect(result).toStrictEqual({
      left: [3, 2, 1],
      calls: 3,
      spent: { errors: ["transcription.limited"], code: 1008 },
    });
  });

  it.each(["admin", "user"] as const)(
    "tells a member signed in as %s that dictation is set up where core then listens, with no model call made to say so",
    async (role) => {
      const { session } = await signedInWithRole(idp, role);
      const head = await logHead();

      const asked = await relaying(async () => await dictationSetUp(session));
      const events = await eventsAfter(head);
      const modelEvents = events.filter(({ action }) =>
        action.startsWith("model.")
      );
      const listened = await relaying(async () => {
        const page = await listen({ cookie: session });
        page.start(memberStart);
        const ready = await page.next();
        page.socket.close(1000, "Done");
        await page.ended();
        return ready?.type;
      });

      expect({
        setUp: asked.result,
        askedUpstream: asked.upstream.opened.length,
        askedAudited: modelEvents.length,
        heard: listened.result,
      }).toStrictEqual({
        setUp: true,
        askedUpstream: 0,
        askedAudited: 0,
        heard: "ready",
      });
    }
  );

  it("tells a member dictation isn't set up where Grasp has no key to listen with, as a dictation there is refused", async () => {
    const { session } = await signedInWithRole(idp, "user");
    const coreEnv = { ...env, CONNECT: connectWithoutGraspKeys(env.CONNECT) };

    const { upstream, result } = await relaying(async () => {
      const setUp = await dictationSetUp(session, coreEnv);
      const page = await listen({ cookie: session }, coreEnv);
      page.start(memberStart);
      return { setUp, ...(await refusalOf(page)) };
    });

    expect({ ...result, upstream: upstream.opened.length }).toStrictEqual({
      setUp: false,
      errors: ["transcription.unavailable"],
      code: 1011,
      upstream: 0,
    });
  });

  it("still tells a member whose day is spent that dictation is set up", async () => {
    const { session, userId } = await signedInWithRole(idp, "user");
    await onboardingStore(env).transcriptionOpened({
      who: `user:${userId}:heard`,
      budget: 30 * 60,
      most: 30 * 60,
    });

    const { result } = await relaying(async () => {
      const page = await listen({ cookie: session });
      page.start(memberStart);
      return {
        ...(await refusalOf(page)),
        setUp: await dictationSetUp(session),
      };
    });

    expect(result).toStrictEqual({
      errors: ["transcription.limited"],
      code: 1008,
      setUp: true,
    });
  });

  it("doesn't tell Grasp's staff whether dictation is set up", async () => {
    const session = await signedIn(idp, "grasp-staff", staffPerson());

    await expect(outcome(dictationSetUp(session))).resolves.toBe(
      "role.forbidden"
    );
  });

  it("goes on listening for a member whose role changes while the socket is open", async () => {
    const { session, userId } = await signedInWithRole(idp, "admin");

    const { result } = await relaying(async () => {
      const page = await listen({ cookie: session });
      page.start(memberStart);
      const ready = await page.next();
      await env.DB.prepare("UPDATE members SET role = ? WHERE user_id = ?")
        .bind("user", userId)
        .run();
      // Past the next check of who is behind the socket.
      await scheduler.wait(sessionRecheckMs + 1000);
      page.socket.send(tenthOfASecond());
      const partial = await page.next();
      return [ready?.type, partial?.type];
    });

    expect(result).toStrictEqual(["ready", "partial"]);
  });

  it("relays for Grasp's staff as the onboarding's, audited when it opens and closes, with nothing heard", async () => {
    const session = await signedIn(idp, "grasp-staff", staffPerson());
    const { userId } = await whoami(session);
    const head = await logHead();

    await relaying(async () => {
      const page = await listen({ cookie: session });
      page.start(memberStart);
      await page.next();
      page.socket.send(tenthOfASecond());
      await page.next();
      page.socket.close(1000, "Done");
      return await page.ended();
    });

    await vi.waitFor(async () => {
      const audited = await transcriptionAudited(head);
      // The session's close and the gateway's charge land in either order.
      expect(
        audited.toSorted((one, other) => one.action.localeCompare(other.action))
      ).toStrictEqual([
        {
          actor: { type: "staff", userId },
          action: "model.call",
          purpose: "onboarding.transcription",
          platform: undefined,
          seconds: 1,
          keys: undefined,
        },
        {
          actor: { type: "staff", userId },
          action: "onboarding.transcription.closed",
          purpose: undefined,
          platform: undefined,
          seconds: 0,
          keys: ["ended", "seconds", "session"],
        },
        {
          actor: { type: "staff", userId },
          action: "onboarding.transcription.opened",
          purpose: undefined,
          platform: undefined,
          seconds: undefined,
          keys: ["session"],
        },
      ]);
    });
  });

  it("keeps nothing of the audio: not in the store, the database or the audit log", async () => {
    const { ada } = await openedTwo();
    const { session } = await signedInWithRole(idp, "user");
    // Audio that reads as text, so it shows wherever it might be written.
    const sentinel = `Periwinkle abacus ${unique()} `.repeat(40);
    const audio = new TextEncoder().encode(
      sentinel.length % 2 === 0 ? sentinel : `${sentinel} `
    );
    const before = await heardCounted("interviews");

    await relaying(async () => {
      const starts: {
        link?: typeof ada;
        headers: Record<string, string>;
      }[] = [
        { link: ada, headers: { cookie: ada.cookie } },
        { headers: { cookie: session } },
      ];
      for (const start of starts) {
        // oxlint-disable-next-line no-await-in-loop -- one session after another
        const page = await listen(start.headers);
        page.start({
          type: "start",
          language: "en",
          sampleRate: 16_000,
          ...(start.link === undefined ? {} : { link: start.link }),
        });
        // oxlint-disable-next-line no-await-in-loop -- one session after another
        await page.next();
        page.socket.send(audio);
        page.socket.send(JSON.stringify({ type: "commit" }));
        // oxlint-disable-next-line no-await-in-loop -- one session after another
        await page.next();
        page.socket.close(1000, "Done");
        // oxlint-disable-next-line no-await-in-loop -- one session after another
        await page.ended();
      }
    });
    await vi.waitFor(async () => {
      await expect(heardCounted("interviews")).resolves.toBeGreaterThan(before);
    });

    const stored = await everythingStored();
    const marker = sentinel.trim().slice(0, 40);
    expect({
      // What it holds of the sessions, so the scan reads where they went.
      noted: ["transcription.closed", "chat.dictation"].map((what) =>
        stored.includes(what)
      ),
      kept: [
        marker,
        toBase64(new TextEncoder().encode(marker)).slice(0, 24),
      ].filter((needle) => stored.includes(needle)),
    }).toStrictEqual({ noted: [true, true], kept: [] });
  });

  it("charges transcription to Grasp's own key, never to the deployment's spend, and shows staff what it heard by purpose", async () => {
    const { ada, bo, roster } = await openedTwo();
    const [adaPerson, boPerson] = roster.people.map(({ id }) => id);
    // A minute left on each link today: each socket holds a minute.
    await holdOfDay(adaPerson ?? "", 59 * 60);
    await holdOfDay(boPerson ?? "", 59 * 60);
    const month = newMonth();
    const minute = heardMicros(60);
    const head = await logHead();
    const before = await heardCounted("interviews");
    const { upstream, result } = await relaying(
      async () => {
        const first = await listen({ cookie: ada.cookie });
        first.start(slowStart(ada));
        const ready = await first.next();
        // Bo's minute opens beside Ada's.
        const second = await listen({ cookie: bo.cookie });
        second.start(slowStart(bo));
        const alsoReady = await second.next();
        // Ada talks for her whole minute, and leaves; Bo leaves saying nothing.
        for (let frame = 0; frame < 30; frame += 1) {
          first.socket.send(twoSeconds());
        }
        first.socket.close(1000, "Done");
        await first.ended();
        second.socket.close(1000, "Done");
        await second.ended();
        const charged = await vi.waitFor(
          async () => {
            const grasp = await graspSpend(month);
            expect(grasp).toBe(minute);
            return grasp;
          },
          { timeout: 10_000 }
        );
        return {
          ready: ready?.type,
          alsoReady: alsoReady?.type,
          charged,
          deployment: await deploymentSpend(month),
        };
      },
      { month }
    );

    const events = await eventsAfter(head);
    const refused = events.filter(
      ({ action, detail }) =>
        action === "model.refused" &&
        detail?.purpose === "onboarding.transcription"
    );
    // What the onboarding counts heard for interviews, once Ada's socket is counted.
    const heard = await vi.waitFor(
      async () => {
        const seconds = (await heardCounted("interviews")) - before;
        if (seconds < 60) {
          throw new Error(`Expected a minute heard, got ${seconds}`);
        }
        return seconds;
      },
      { timeout: 10_000 }
    );
    expect({
      ...result,
      upstreams: upstream.opened.length,
      refused: refused.length,
      heard,
    }).toStrictEqual({
      ready: "ready",
      alsoReady: "ready",
      charged: minute,
      deployment: 0,
      upstreams: 2,
      refused: 0,
      heard: 60,
    });
  });

  it("listens at OpenAI's EU host, where Grasp's project keeps its data", async () => {
    const { ada } = await openedTwo();

    const { upstream, result } = await relaying(async () => {
      const page = await listen({ cookie: ada.cookie });
      page.start({
        type: "start",
        language: "en",
        sampleRate: 16_000,
        link: ada,
      });
      const ready = await page.next();
      page.socket.close(1000, "Done");
      return ready?.type;
    });

    expect([
      result,
      upstream.opened[0]?.host,
      upstream.opened[0]?.path,
    ]).toStrictEqual([
      "ready",
      "eu.api.openai.com",
      "/v1/realtime?intent=transcription",
    ]);
  });
});
