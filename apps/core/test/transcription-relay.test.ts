import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { randomToken, toBase64 } from "@grasp-os/shared/encoding";
import { interviewApiPath } from "@grasp-os/shared/interview-links";
import type { Roster } from "@grasp-os/shared/onboarding";
import { transcriptionPath } from "@grasp-os/shared/voice";
import type { TranscriptionStart } from "@grasp-os/shared/voice";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { modelLedger } from "../src/model-ledger.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import { transcriptionModel } from "../src/onboarding/transcription.ts";
import { allEvents, logHead, eventsAfter } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { onLink, participate } from "./interview-link.ts";
import { closeWhenTestEnds } from "./open-sockets.ts";
import { clientOrigin } from "./sign-in-config.ts";
import {
  openRpc,
  routed,
  signedIn,
  signedInWithRole,
  staffPerson,
  unique,
} from "./sign-in.ts";

// What someone says, written down as they say it, relayed through core
// over a WebSocket on the page's own origin (src/onboarding/
// transcription.ts). ElevenLabs's realtime transcription, behind AI
// Gateway, is the outside system: a fake behind the AI binding that
// answers each chunk of audio with a partial transcript, and each commit
// with a final one. The store, the link checks and the audit log are
// real. The ways it can fail, tried here (GRA-361, C4 and A1):
//
// - A socket on a link that isn't one, on another person's link, on the
//   link of someone who didn't agree to take part (GRA-329, T1), for
//   nobody signed in or a member who isn't an admin, from another site,
//   or one that sends audio before it says who it is for.
// - One side closing and the other left open, holding the upstream (and
//   its bill) or the page's microphone.
// - Audio kept anywhere: the store, the database, the audit log.
// - Listening on after the link or the admin no longer may: the person
//   taken off the list, the onboarding paused, the person withdrawing
//   (GRA-329, T5), the admin made a member.
// - Sockets opened side by side on one link, each hearing a day's budget.
// - Listening past the deployment's own budgets, or with a model its
//   allowlist or its rules don't let it use (GRA-1064).

const idp = mockIdp();

const dayMs = 24 * 60 * 60 * 1000;

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const voiceModel = "elevenlabs/eleven_v4";

/** The deployment's gateway, allowing the transcription model: transcription may run. */
const gatewayConfig = {
  gateway: "grasp-os-test",
  models: [voiceModel, transcriptionModel],
};

/** What a session answers, as far as these tests read it: the device's key. */
const sessionKey = z.object({ key: z.string().optional() });

/** A chunk core sent the upstream, as Scribe takes it. */
const chunkSchema = z.object({
  message_type: z.literal("input_audio_chunk"),
  audio_base_64: z.string(),
  commit: z.boolean(),
  sample_rate: z.number(),
});

/** What the fake upstream settles every commit as. */
const settled = {
  text: "Hello there",
  words: [
    { text: "Hello", start: 0, end: 0.4, type: "word" },
    { text: " ", start: 0.4, end: 0.5, type: "spacing" },
    { text: "there", start: 0.5, end: 0.9, type: "word" },
  ],
};

/** A request core made to open the upstream, as far as these tests read it. */
interface UpstreamOpened {
  url: URL;
  upgrade: string | null;
  authorization: string | null;
  apiKey: string | null;
}

/**
 * ElevenLabs's realtime transcription behind the gateway: a partial for
 * each chunk with audio, a final for each commit, and the audio it got.
 */
const fakeUpstream = () => {
  const opened: UpstreamOpened[] = [];
  const audio: Uint8Array[] = [];
  const sockets: WebSocket[] = [];
  const closed = Promise.withResolvers<number>();
  const answer = (socket: WebSocket, data: unknown): void => {
    const chunk = chunkSchema.parse(JSON.parse(String(data)));
    if (chunk.audio_base_64 !== "") {
      audio.push(
        Uint8Array.from(atob(chunk.audio_base_64), (c) => c.codePointAt(0) ?? 0)
      );
      socket.send(
        JSON.stringify({ message_type: "partial_transcript", text: "Hello" })
      );
    }
    if (chunk.commit) {
      socket.send(
        JSON.stringify({
          message_type: "committed_transcript",
          text: settled.text,
        })
      );
      socket.send(
        JSON.stringify({
          message_type: "committed_transcript_with_timestamps",
          ...settled,
        })
      );
    }
  };
  const fetch = async (
    input: Request | string | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const request = new Request(input, init);
    opened.push({
      url: new URL(request.url),
      upgrade: request.headers.get("upgrade"),
      authorization: request.headers.get("cf-aig-authorization"),
      apiKey: request.headers.get("xi-api-key"),
    });
    const { 0: core, 1: upstream } = new WebSocketPair();
    upstream.accept();
    sockets.push(upstream);
    upstream.addEventListener("message", (event) => {
      answer(upstream, event.data);
    });
    upstream.addEventListener("close", (event) => {
      closed.resolve(event.code);
    });
    return await Promise.resolve(
      new Response(null, { status: 101, webSocket: core })
    );
  };
  return { fetch, opened, audio, sockets, closed: closed.promise };
};

type Upstream = ReturnType<typeof fakeUpstream>;

let monthsUsed = 0;

/** A month no other test counts budgets in: from 2800, clear of other files. */
const newMonth = (): string => {
  monthsUsed += 1;
  return `${2800 + Math.floor(monthsUsed / 12)}-${String((monthsUsed % 12) + 1).padStart(2, "0")}`;
};

/**
 * What `run` returns while the fake upstream stands behind the gateway,
 * under `config` over the gateway's, budgets counted in `month`.
 */
const relaying = async <T>(
  run: (upstream: Upstream) => Promise<T>,
  { config = {}, month }: { config?: object; month?: string } = {}
) => {
  const before = {
    gateway: env.MODEL_GATEWAY,
    month: env.MODEL_BUDGET_MONTH,
  };
  const upstream = fakeUpstream();
  const ai: AiBinding = env.AI;
  const spy = vi.spyOn(ai, "fetch").mockImplementation(upstream.fetch);
  env.MODEL_GATEWAY = { ...gatewayConfig, ...config };
  if (month !== undefined) {
    env.MODEL_BUDGET_MONTH = month;
  }
  try {
    return { upstream, result: await run(upstream) };
  } finally {
    env.MODEL_GATEWAY = before.gateway;
    env.MODEL_BUDGET_MONTH = before.month;
    spy.mockRestore();
  }
};

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
      email: "",
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
      const session = await routed(interviewApiPath, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "session", secret }),
      });
      const { key } = sessionKey.parse(await session.json());
      const device = { secret, key: key ?? "" };
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
const listen = async (headers: Record<string, string> = {}) => {
  const response = await routed(transcriptionPath, {
    headers: { Upgrade: "websocket", Origin: clientOrigin, ...headers },
  });
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
    start: (start: TranscriptionStart | Record<string, unknown>) => {
      socket.send(JSON.stringify(start));
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
const slowStart = (link: { secret: string; key: string }) =>
  ({ type: "start", language: "en", sampleRate: 8000, link }) as const;

/**
 * Scribe realtime's price, with keyterms, as the ledger pins it: micros
 * per million seconds, rounded up ($0.47 an hour).
 */
const microsPerMillionSeconds = Math.ceil((0.47 / 3600) * 1e12);

/** What `seconds` heard cost, in micros, as the ledger charges them. */
const heardMicros = (seconds: number): number =>
  Math.ceil((seconds * microsPerMillionSeconds) / 1e6);

/** What the deployment spent and holds in `month`, as the ledger counts it. */
const deploymentSpend = async (month: string) => {
  const spent = await modelLedger(env).spendOf(month, ["deployment"], 10);
  const [row] = spent.deployment ?? [];
  return { spent: row?.spentMicros ?? 0, held: row?.reservedMicros ?? 0 };
};

/**
 * Holds `seconds` of a link's day as a socket opened elsewhere would,
 * so the next socket on it holds only what is left.
 */
const holdOfDay = async (personId: string, seconds: number) => {
  await onboardingStore(env).transcriptionOpened({
    id: crypto.randomUUID(),
    by: { type: "system" },
    person: personId,
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
  it("relays a link's audio and hears it back as partial and final transcripts, asking the gateway to keep nothing", async () => {
    const { ada } = await openedTwo();
    const before = await heardCounted("interviews");

    const { upstream, result } = await relaying(async () => {
      const page = await listen();
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
    expect({
      ...result,
      path: opened?.url.pathname,
      query: Object.fromEntries(
        [...(opened?.url.searchParams ?? [])].filter(
          ([name]) => name !== "keyterms"
        )
      ),
      // What to listen out for is the store's: the team, and its people.
      keyterms: ["Ops", "Person"].every((term) =>
        (opened?.url.searchParams.getAll("keyterms") ?? []).includes(term)
      ),
      upgrade: opened?.upgrade,
      apiKey: opened?.apiKey,
      audio: upstream.audio.map((bytes) => bytes.length),
    }).toStrictEqual({
      ready: "ready",
      partial: { type: "partial", text: "Hello" },
      final: {
        type: "final",
        text: "Hello there",
        words: [
          { text: "Hello", startMs: 0, endMs: 400 },
          { text: "there", startMs: 500, endMs: 900 },
        ],
      },
      path: "/ai-gateway/gateways/grasp-os-test/elevenlabs/v1/speech-to-text/realtime",
      query: {
        model_id: "scribe_v2_realtime",
        language_code: "nl",
        audio_format: "pcm_16000",
        commit_strategy: "vad",
        include_timestamps: "true",
        enable_logging: "false",
      },
      keyterms: true,
      upgrade: "websocket",
      apiKey: null,
      audio: [3200],
    });
    // A tenth of a second heard, counted once the socket closed.
    await vi.waitFor(async () => {
      await expect(heardCounted("interviews")).resolves.toBeCloseTo(
        before + 0.1
      );
    });
  });

  it.each([
    ["a link that isn't one", "unknown", "interview.link_invalid"],
    ["another person's link, on this device", "other", "interview.elsewhere"],
    [
      "a link whose person didn't agree to take part",
      "unagreed",
      "interview.not_participating",
    ],
    ["nobody signed in, without a link", "none", "auth.unauthenticated"],
    ["a member who isn't an admin, without a link", "user", "role.forbidden"],
    ["audio before it says whose it is", "audio", "transcription.invalid"],
    ["a start the relay doesn't take", "invalid", "transcription.invalid"],
  ] as const)(
    "refuses a socket for %s, opening nothing upstream",
    async (_, kind, refusal) => {
      const { ada, bo } = await openedTwo(kind !== "unagreed");
      const headers: Record<string, string> = {};
      if (kind === "user") {
        const member = await signedInWithRole(idp, "user");
        headers.cookie = member.session;
      }

      const { upstream, result } = await relaying(async () => {
        const page = await listen(headers);
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
            unknown: { secret: randomToken(), key: ada.key },
            other: { secret: bo.secret, key: ada.key },
            unagreed: ada,
            none: undefined,
            user: undefined,
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

  it("opens no socket from another site, even with an admin's session", async () => {
    const { session } = await signedInWithRole(idp, "admin");

    const response = await routed(transcriptionPath, {
      headers: {
        Upgrade: "websocket",
        Origin: "https://elsewhere.example",
        cookie: session,
      },
    });

    expect([response.status, response.webSocket]).toStrictEqual([403, null]);
  });

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

    const { result } = await relaying(async (upstream) => {
      const page = await listen();
      page.start({
        type: "start",
        language: "en",
        sampleRate: 16_000,
        link: ada,
      });
      await page.next();
      const [socket] = upstream.sockets;
      if (side === "page") {
        page.socket.close(1000, "Done");
      } else {
        socket?.close(side === "upstream" ? 1000 : 1011, "Gone");
      }
      const [upstreamCode, ended] = await Promise.all([
        upstream.closed,
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
        Array.from({ length: 4 }, async () => await listen())
      );
      for (const page of pages) {
        page.start(start);
      }
      const ready = await Promise.all(
        pages.map(async (page) => await page.next())
      );
      const fifth = await listen();
      fifth.start(start);
      const spent = await refusalOf(fifth);
      // One socket hears a tenth of a second and leaves: the rest is back.
      const [first] = pages;
      first?.socket.send(tenthOfASecond());
      await first?.next();
      first?.socket.close(1000, "Done");
      await first?.ended();
      const again = await vi.waitFor(async () => {
        const page = await listen();
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
    ["the admin is made a member", "demoted", "role.forbidden"],
  ] as const)(
    "stops listening, upstream too, once %s while the socket is open",
    async (_, change, refusal) => {
      const { ada, roster } = await openedTwo();
      const admin =
        change === "demoted" ? await signedInWithRole(idp, "admin") : undefined;
      const store = onboardingStore(env);
      const by = { type: "system" } as const;

      const { result } = await relaying(async (upstream) => {
        const page = await listen(
          admin === undefined ? {} : { cookie: admin.session }
        );
        page.start({
          type: "start",
          language: "en",
          sampleRate: 16_000,
          ...(admin === undefined ? { link: ada } : {}),
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
        } else {
          await env.DB.prepare("UPDATE members SET role = ? WHERE user_id = ?")
            .bind("user", admin?.userId ?? "")
            .run();
        }
        const [ended, upstreamCode] = await Promise.all([
          refusalOf(page),
          upstream.closed,
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

  it("relays for an admin signed in, audited when it opens and closes, with nothing heard", async () => {
    const { session, userId } = await signedInWithRole(idp, "admin");
    const head = await logHead();

    await relaying(async () => {
      const page = await listen({ cookie: session });
      page.start({ type: "start", language: "en", sampleRate: 16_000 });
      await page.next();
      page.socket.send(tenthOfASecond());
      await page.next();
      page.socket.close(1000, "Done");
      return await page.ended();
    });

    await vi.waitFor(async () => {
      const events = await eventsAfter(head);
      expect(
        events
          .filter(({ action }) =>
            action.startsWith("onboarding.transcription.")
          )
          .map(({ actor, action, detail }) => ({
            actor,
            action,
            keys: Object.keys(detail ?? {}).toSorted(),
            seconds: detail?.seconds,
          }))
      ).toStrictEqual([
        {
          actor: { type: "person", userId },
          action: "onboarding.transcription.opened",
          keys: ["session"],
          seconds: undefined,
        },
        {
          actor: { type: "person", userId },
          action: "onboarding.transcription.closed",
          keys: ["ended", "seconds", "session"],
          seconds: 0,
        },
      ]);
    });
  });

  it("keeps nothing of the audio: not in the store, the database or the audit log", async () => {
    const { ada } = await openedTwo();
    const { session } = await signedInWithRole(idp, "admin");
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
      }[] = [{ link: ada, headers: {} }, { headers: { cookie: session } }];
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
      noted: ["transcription.closed", "onboarding.transcription.closed"].map(
        (what) => stored.includes(what)
      ),
      kept: [
        marker,
        toBase64(new TextEncoder().encode(marker)).slice(0, 24),
      ].filter((needle) => stored.includes(needle)),
    }).toStrictEqual({ noted: [true, true], kept: [] });
  });

  it("spends the deployment's budget through transcription, refuses the next socket once it is spent, and shows staff what it heard by purpose", async () => {
    const { ada, bo, roster } = await openedTwo();
    const [adaPerson, boPerson] = roster.people.map(({ id }) => id);
    // A minute left on each link today: each socket holds a minute.
    await holdOfDay(adaPerson ?? "", 59 * 60);
    await holdOfDay(boPerson ?? "", 59 * 60);
    const month = newMonth();
    const minute = heardMicros(60);
    const head = await logHead();
    const staff = await signedIn(idp, "grasp-staff", staffPerson());
    const { core } = await openRpc(staff);
    const before = await heardCounted("interviews");
    const { upstream, result } = await relaying(
      async () => {
        const first = await listen();
        first.start(slowStart(ada));
        const ready = await first.next();
        // While Ada's minute is held, Bo's doesn't fit beside it.
        const busy = await listen();
        busy.start(slowStart(bo));
        const held = await refusalOf(busy);
        // Ada talks for her whole minute, and leaves.
        for (let frame = 0; frame < 30; frame += 1) {
          first.socket.send(twoSeconds());
        }
        first.socket.close(1000, "Done");
        await first.ended();
        await vi.waitFor(
          async () => {
            await expect(deploymentSpend(month)).resolves.toStrictEqual({
              spent: minute,
              held: 0,
            });
            // And Bo's minute back on his link, from the socket refused.
            await expect(
              onboardingStore(env).voiceSaid(`link:${boPerson}:heard`)
            ).resolves.toBe(59 * 60);
          },
          { timeout: 10_000 }
        );
        // Spent: what is left is less than Bo's minute.
        const next = await listen();
        next.start(slowStart(bo));
        const spent = await refusalOf(next);
        return { ready: ready?.type, held, spent };
      },
      {
        // A cent: a minute of Scribe realtime (0.78¢) fits, two don't.
        config: { budgets: { deployment: { limit: 0.01 } } },
        month,
      }
    );

    const events = await eventsAfter(head);
    const gateway = events.filter(
      ({ action, detail }) =>
        action.startsWith("model.") &&
        detail?.purpose === "onboarding.transcription"
    );
    const numbers = await core.authenticate();
    // What staff see heard for interviews, once Ada's socket is counted.
    const heard = await vi.waitFor(
      async () => {
        const rows = await numbers.onboardingStaff.aiUse();
        const seconds =
          rows
            .filter(
              ({ purpose, model }) =>
                purpose === "interviews" && model === "transcription"
            )
            .reduce((sum, row) => sum + row.seconds, 0) - before;
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
      gateway: gateway.map(({ action, actor, model, cost, detail }) => ({
        action,
        actor,
        model,
        cost,
        seconds: detail?.seconds,
        reason: detail?.reason,
      })),
      heard,
    }).toStrictEqual({
      ready: "ready",
      held: { errors: ["transcription.busy"], code: 1008 },
      spent: { errors: ["transcription.over_budget"], code: 1008 },
      // Only Ada's socket reached the upstream.
      upstreams: 1,
      gateway: [
        {
          action: "model.refused",
          actor: { type: "system" },
          model: undefined,
          cost: undefined,
          seconds: undefined,
          reason: "model.budget_busy",
        },
        {
          action: "model.call",
          actor: { type: "system" },
          model: {
            provider: "elevenlabs",
            model: "scribe_v2_realtime",
            inputTokens: 0,
            outputTokens: 0,
          },
          // Before the ledger rounds it up to a micro.
          cost: {
            amount: (60 * microsPerMillionSeconds) / 1e12,
            currency: "USD",
          },
          seconds: 60,
          reason: undefined,
        },
        {
          action: "model.refused",
          actor: { type: "system" },
          model: undefined,
          cost: undefined,
          seconds: undefined,
          reason: "model.over_budget",
        },
      ],
      heard: 60,
    });
  });

  it.each([
    [
      "the allowlist names only a voice model",
      { models: [voiceModel] },
      "model.not_allowed",
    ],
    [
      "the sensitive-data rule doesn't name it",
      { sensitive: { models: [voiceModel] } },
      "model.sensitive_data",
    ],
    [
      "the deployment stays in the EU, and the EU rule doesn't name it",
      {
        eu: { deployment: true, models: [voiceModel] },
        voice: { provider: "custom-elevenlabs-eu" },
      },
      "model.eu_only",
    ],
  ] as const)(
    "refuses a socket when %s, opening nothing upstream, audited as a refused model call",
    async (_, config, reason) => {
      const { ada } = await openedTwo();
      const head = await logHead();

      const { upstream, result } = await relaying(
        async () => {
          const page = await listen();
          page.start({
            type: "start",
            language: "en",
            sampleRate: 16_000,
            link: ada,
          });
          return await refusalOf(page);
        },
        { config }
      );

      const events = await eventsAfter(head);
      const refused = events.filter(({ action }) => action === "model.refused");
      expect({
        ...result,
        upstream: upstream.opened.length,
        refused: refused.map(({ detail }) => [detail?.reason, detail?.model]),
      }).toStrictEqual({
        errors: ["transcription.unavailable"],
        code: 1011,
        upstream: 0,
        refused: [[reason, transcriptionModel]],
      });
    }
  );

  it("listens at ElevenLabs's EU host when the deployment stays in the EU and its EU rule names the model", async () => {
    const { ada } = await openedTwo();

    const { upstream, result } = await relaying(
      async () => {
        const page = await listen();
        page.start({
          type: "start",
          language: "en",
          sampleRate: 16_000,
          link: ada,
        });
        const ready = await page.next();
        page.socket.close(1000, "Done");
        return ready?.type;
      },
      {
        config: {
          eu: { deployment: true, models: [transcriptionModel] },
          voice: { provider: "custom-elevenlabs-eu" },
        },
      }
    );

    expect([result, upstream.opened[0]?.url.pathname]).toStrictEqual([
      "ready",
      "/ai-gateway/gateways/grasp-os-test/custom-elevenlabs-eu/v1/speech-to-text/realtime",
    ]);
  });
});
