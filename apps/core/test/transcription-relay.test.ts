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

import { onboardingStore } from "../src/onboarding/store.ts";
import { allEvents, logHead, eventsAfter } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { closeWhenTestEnds } from "./open-sockets.ts";
import { clientOrigin } from "./sign-in-config.ts";
import { routed, signedInWithRole, unique } from "./sign-in.ts";

// What someone says, written down as they say it, relayed through core
// over a WebSocket on the page's own origin (src/onboarding/
// transcription.ts). ElevenLabs's realtime transcription, behind AI
// Gateway, is the outside system: a fake behind the AI binding that
// answers each chunk of audio with a partial transcript, and each commit
// with a final one. The store, the link checks and the audit log are
// real. The ways it can fail, tried here (GRA-361, C4 and A1):
//
// - A socket on a link that isn't one, on another person's link, for
//   nobody signed in or a member who isn't an admin, from another site,
//   or one that sends audio before it says who it is for.
// - One side closing and the other left open, holding the upstream (and
//   its bill) or the page's microphone.
// - Audio kept anywhere: the store, the database, the audit log.

const idp = mockIdp();

const dayMs = 24 * 60 * 60 * 1000;

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The deployment's gateway, allowing a voice model: transcription may run. */
const gatewayConfig = {
  gateway: "grasp-os-test",
  models: ["elevenlabs/eleven_v4"],
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

/** What `run` returns while the fake upstream stands behind the gateway. */
const relaying = async <T>(run: (upstream: Upstream) => Promise<T>) => {
  const before = env.MODEL_GATEWAY;
  const upstream = fakeUpstream();
  const ai: AiBinding = env.AI;
  const spy = vi.spyOn(ai, "fetch").mockImplementation(upstream.fetch);
  env.MODEL_GATEWAY = gatewayConfig;
  try {
    return { upstream, result: await run(upstream) };
  } finally {
    env.MODEL_GATEWAY = before;
    spy.mockRestore();
  }
};

/**
 * An onboarding running since yesterday with two people in Ops, each
 * link out and opened on a device of their own: their secrets and keys.
 */
const openedTwo = async () => {
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
      return { secret, key: key ?? "" };
    })
  );
  if (ada === undefined || bo === undefined) {
    throw new Error("Expected two links");
  }
  return { ada, bo };
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
    ["nobody signed in, without a link", "none", "auth.unauthenticated"],
    ["a member who isn't an admin, without a link", "user", "role.forbidden"],
    ["audio before it says whose it is", "audio", "transcription.invalid"],
    ["a start the relay doesn't take", "invalid", "transcription.invalid"],
  ] as const)(
    "refuses a socket for %s, opening nothing upstream",
    async (_, kind, refusal) => {
      const { ada, bo } = await openedTwo();
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
});
