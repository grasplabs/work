import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { randomToken } from "@grasp-os/shared/encoding";
import { errorPayloadSchema } from "@grasp-os/shared/errors";
import { interviewApiPath } from "@grasp-os/shared/interview-links";
import type { Roster } from "@grasp-os/shared/onboarding";
import { speechPath } from "@grasp-os/shared/voice";
import type { SpeechRequestBody } from "@grasp-os/shared/voice";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { voiceBudgets } from "../src/onboarding/speech.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import { fakeGateway } from "./ai-gateway.ts";
import type { GatewayReply, GatewayRequest } from "./ai-gateway.ts";
import { mockIdp } from "./idp.ts";
import { routed, signedInWithRole, unique } from "./sign-in.ts";

// The onboarding's lines said out loud (src/onboarding/speech.ts), over
// the endpoint, as the page asks for them: on someone's interview link, or
// for an admin signed in. AI Gateway, and ElevenLabs behind it, is the
// outside system: a fake behind the AI binding, which says each character
// in 100 ms. The store, the cache, the gateway's rules and its ledger are
// real. The ways it can fail, tried here:
//
// - A line said for a link that isn't one, a device that isn't the
//   link's, someone who isn't an admin, or another site.
// - A line said in a tone Stephen may not use, or with a direction of its
//   own.
// - A line said twice paid twice, or the voice running on past its budget.

const voiceModel = "elevenlabs/eleven_v4";
const quickVoice = "elevenlabs/eleven_v4_turbo";

/** Stephen's voice and Claire's, by their ElevenLabs IDs. */
const stephen = "s3TPKV1kjDlVtZbl4Ksh";
const claire = "r1KmysJdVYZjJCm4mL3b";

const said: GatewayReply = { speech: { audio: "mp3 bytes" } };

const dayMs = 24 * 60 * 60 * 1000;

const idp = mockIdp();

/** What a session answers, as far as these tests read it: the device's key. */
const sessionKey = z.object({ key: z.string().optional() });

/** A line said, as these tests read it. */
const answerSchema = z.object({
  audio: z.string(),
  mime: z.string(),
  words: z.array(
    z.object({ text: z.string(), startMs: z.number(), endMs: z.number() })
  ),
});

/** What ElevenLabs was asked, as far as these tests read it. */
const askedSchema = z.object({
  text: z.string(),
  model_id: z.string(),
  language_code: z.string(),
});

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A line no other test says, so the cache has never seen it. */
const newLine = (): string =>
  `Hello there, ${unique().replaceAll(/\d/gu, "x")}.`;

/**
 * An onboarding running since yesterday, with one person whose link is
 * out, opened on a device: who they are, their secret and key.
 */
const opened = async () => {
  const store = onboardingStore(env);
  const person = `oli-${unique()}`;
  const roster: Roster = {
    teams: [{ id: "ops", name: "Ops", lead: null, does: "", off: false }],
    people: [
      {
        id: person,
        name: "Oli Olsen",
        team: "ops",
        email: "",
        title: "",
        away: false,
      },
    ],
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
  const link = await store.linkOf(person);
  const secret = link?.split("#")[1] ?? "";
  const session = await routed(interviewApiPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "session", secret }),
  });
  const { key } = sessionKey.parse(await session.json());
  return { person, link: { secret, key: key ?? "" } };
};

/** Asks for `body` to be said, as the page does. */
const speak = async (
  body: SpeechRequestBody | Record<string, unknown>,
  headers: Record<string, string> = {}
): Promise<Response> =>
  await routed(speechPath, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

/** A refusal's status and code. */
const codeOf = async (response: Response) => {
  const parsed = errorPayloadSchema.safeParse(await response.json());
  return [response.status, parsed.success ? parsed.data.code : null];
};

/** What `run` returns while the gateway answers with `replies`, under `models`. */
const answering = async <T>(
  replies: GatewayReply[],
  run: () => Promise<T>,
  models: string[] = [voiceModel, quickVoice]
) => {
  const before = env.MODEL_GATEWAY;
  const fake = fakeGateway(...replies);
  const ai: AiBinding = env.AI;
  const spy = vi.spyOn(ai, "fetch").mockImplementation(fake.binding.fetch);
  env.MODEL_GATEWAY = { gateway: "grasp-os-test", models };
  try {
    return { requests: fake.requests, result: await run() };
  } finally {
    env.MODEL_GATEWAY = before;
    spy.mockRestore();
  }
};

/** What ElevenLabs was asked: the voice, from the route, and the body. */
const askedOf = ({ url, body }: GatewayRequest) => ({
  voice: new URL(url).pathname.split("/").at(-2),
  ...askedSchema.parse(body),
});

/** Seconds of voice the onboarding counted for `purpose`. */
const voiceCounted = async (purpose: string): Promise<number> => {
  const rows = await onboardingStore(env).usage();
  return rows
    .filter((row) => row.purpose === purpose && row.model === "voice")
    .reduce((sum, { seconds }) => sum + seconds, 0);
};

describe("lines said at the speech endpoint", { timeout: 60_000 }, () => {
  it("says a line on someone's link with when each word is said, and the second time from the cache, for nothing", async () => {
    const { link } = await opened();
    const text = newLine();
    const before = await voiceCounted("interviews");

    const { requests, result } = await answering([said, said], async () => {
      const first = await speak({ text, language: "en", link });
      const again = await speak({ text, language: "en", link });
      return {
        first: { status: first.status, body: await first.json() },
        again: { status: again.status, body: await again.json() },
      };
    });

    const answer = answerSchema.parse(result.first.body);
    expect({
      status: result.first.status,
      audio: atob(answer.audio),
      mime: answer.mime,
      words: answer.words.map(({ startMs, endMs }) => [startMs, endMs]),
    }).toStrictEqual({
      status: 200,
      audio: "mp3 bytes",
      mime: "audio/mpeg",
      words: [
        [0, 500],
        [600, 1200],
        [1300, 1300 + (text.length - 13) * 100],
      ],
    });
    expect(result.again).toStrictEqual(result.first);
    expect(requests).toHaveLength(1);
    // Counted once, for the line said: 100 ms for each of its characters.
    await expect(voiceCounted("interviews")).resolves.toBeCloseTo(
      before + text.length / 10
    );
  });

  it.each([
    ["a link that isn't one", "unknown", 404, "interview.link_invalid"],
    [
      "a device the link isn't open on",
      "elsewhere",
      403,
      "interview.elsewhere",
    ],
  ] as const)(
    "refuses a line for %s, sending nothing",
    async (_, kind, status, code) => {
      const { link } = await opened();
      const asked =
        kind === "unknown"
          ? { secret: randomToken(), key: link.key }
          : { secret: link.secret, key: randomToken() };

      const { requests, result } = await answering(
        [said],
        async () =>
          await codeOf(
            await speak({ text: newLine(), language: "en", link: asked })
          )
      );

      expect(result).toStrictEqual([status, code]);
      expect(requests).toStrictEqual([]);
    }
  );

  it("leads an English line with its tone and takes it out of the timing; another language is said bare", async () => {
    const { link } = await opened();
    const text = "Hello there, Ada.";

    const { requests, result } = await answering([said, said], async () => {
      const english = await speak({
        text,
        language: "en",
        tone: "warm, relaxed",
        link,
      });
      const dutch = await speak({
        text,
        language: "nl",
        tone: "warm, relaxed",
        link,
      });
      return [
        answerSchema.parse(await english.json()).words,
        answerSchema.parse(await dutch.json()).words,
      ];
    });

    expect(requests.map((request) => askedOf(request).text)).toStrictEqual([
      `[warm, relaxed] ${text}`,
      text,
    ]);
    // The direction's 16 characters come first, said in 1.6 s.
    expect(result).toStrictEqual([
      [
        { text: "Hello", startMs: 1600, endMs: 2100 },
        { text: "there,", startMs: 2200, endMs: 2800 },
        { text: "Ada.", startMs: 2900, endMs: 3300 },
      ],
      [
        { text: "Hello", startMs: 0, endMs: 500 },
        { text: "there,", startMs: 600, endMs: 1200 },
        { text: "Ada.", startMs: 1300, endMs: 1700 },
      ],
    ]);
  });

  it.each([
    ["a direction of its own", { text: "[sad] I'm sorry to hear that." }],
    ["a tone Stephen may not use", { tone: "sad, quiet" }],
    ["more than one request may have said", { text: "a".repeat(601) }],
    ["a language the onboarding isn't held in", { language: "it" }],
    ["a speaker there isn't", { speaker: "adam" }],
  ])("refuses a line with %s, sending nothing", async (_, change) => {
    const { link } = await opened();

    const { requests, result } = await answering(
      [said],
      async () =>
        await codeOf(
          await speak({ text: newLine(), language: "en", link, ...change })
        )
    );

    expect(result).toStrictEqual([400, "speech.invalid"]);
    expect(requests).toStrictEqual([]);
  });

  it.each([
    [
      "Stephen's line in Eleven v4",
      {},
      [voiceModel, quickVoice],
      stephen,
      "eleven_v4",
    ],
    [
      "a quick line in v4 Turbo",
      { quick: true },
      [voiceModel, quickVoice],
      stephen,
      "eleven_v4_turbo",
    ],
    [
      "a quick line in v4 where the deployment allows no Turbo",
      { quick: true },
      [voiceModel],
      stephen,
      "eleven_v4",
    ],
    [
      "Claire's line in her voice",
      { speaker: "claire" },
      [voiceModel, quickVoice],
      claire,
      "eleven_v4",
    ],
  ])("says %s", async (_, change, models, voice, model) => {
    const { link } = await opened();

    const { requests } = await answering(
      [said],
      async () =>
        await speak({ text: newLine(), language: "de", link, ...change }),
      models
    );

    expect(requests.map(askedOf)).toMatchObject([
      { voice, model_id: model, language_code: "de" },
    ]);
  });

  it("refuses a new line once the link's voice for the day is used up, and still says one it said before", async () => {
    const { person, link } = await opened();
    const before = newLine();
    const after = newLine();

    const { requests, result } = await answering([said, said], async () => {
      const first = await speak({ text: before, language: "en", link });
      await first.body?.cancel();
      await onboardingStore(env).countVoice(
        `link:${person}`,
        "interviews",
        voiceBudgets.link
      );
      const again = await speak({ text: before, language: "en", link });
      await again.body?.cancel();
      const fresh = await speak({ text: after, language: "en", link });
      return { again: again.status, new: await codeOf(fresh) };
    });

    expect(result).toStrictEqual({
      again: 200,
      new: [429, "speech.limited"],
    });
    expect(requests).toHaveLength(1);
  });

  it("says a line for an admin signed in, counted as their own onboarding's", async () => {
    const { session } = await signedInWithRole(idp, "admin");
    const before = await voiceCounted("reading");

    const { requests, result } = await answering([said], async () => {
      const response = await speak(
        { text: "Hello there, Ada.", language: "en", speaker: "mark" },
        { cookie: session, "sec-fetch-site": "same-origin" }
      );
      return { status: response.status, body: await response.json() };
    });

    expect(result.status).toBe(200);
    expect(answerSchema.parse(result.body).words).toHaveLength(3);
    expect(requests).toHaveLength(1);
    await expect(voiceCounted("reading")).resolves.toBeCloseTo(before + 1.7);
  });

  it.each([
    ["nobody signed in", "none", 401, "auth.unauthenticated"],
    ["a member who isn't an admin", "user", 403, "role.forbidden"],
    [
      "another site, with an admin's session",
      "elsewhere",
      403,
      "request.forbidden",
    ],
  ] as const)(
    "refuses a line without a link for %s, sending nothing",
    async (_, who, status, code) => {
      const headers: Record<string, string> = {};
      if (who !== "none") {
        const { session } = await signedInWithRole(
          idp,
          who === "user" ? "user" : "admin"
        );
        headers.cookie = session;
      }
      if (who === "elsewhere") {
        headers["sec-fetch-site"] = "cross-site";
      }

      const { requests, result } = await answering(
        [said],
        async () =>
          await codeOf(
            await speak({ text: newLine(), language: "en" }, headers)
          )
      );

      expect(result).toStrictEqual([status, code]);
      expect(requests).toStrictEqual([]);
    }
  );
});
