import { randomToken } from "@grasp-os/shared/encoding";
import { errorPayloadSchema } from "@grasp-os/shared/errors";
import type { Roster } from "@grasp-os/shared/onboarding";
import { speechPath } from "@grasp-os/shared/voice";
import type { SpeechRequestBody } from "@grasp-os/shared/voice";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { voiceBudgets } from "../src/onboarding/speech.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import { platformAi } from "../src/platform-ai.ts";
import { storedKeyOf } from "../src/speech-cache.ts";
import { secondsPerCharacter } from "./ai-providers-fake.ts";
import { platformMistralKey } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import {
  onLink,
  openLinkAs,
  participate,
  signedInAs,
} from "./interview-link.ts";
import { carrying, plan } from "./platform-providers.ts";
import { routed, signedInWithRole, unique, uniqueLetters } from "./sign-in.ts";

// The onboarding's lines said out loud (src/onboarding/speech.ts), over
// the endpoint, as the page asks for them: on someone's interview link, or
// for an admin signed in. Mistral, Grasp's own speech feature's
// provider (@grasp-os/shared/platform-ai), is the outside system: a fake
// behind connect's fetch, which says each character in 30 ms. Connect, the
// store, the cache, the gateway's rules and its ledger are real. The ways
// it can fail, tried here:
//
// - A line said for a link that isn't one, a device that isn't the
//   link's, someone who isn't an admin, or another site.
// - A line said in a tone Stephen may not use, or with a direction of its
//   own.
// - A line said twice paid twice, or the voice running on past its budget.

/** Stephen's voice, by its Mistral ID. */
const stephen = "voice_485";

const dayMs = 24 * 60 * 60 * 1000;

const idp = mockIdp();

/** A line said, as these tests read it. */
const answerSchema = z.object({
  audio: z.string(),
  mime: z.string(),
  words: z.array(
    z.object({ text: z.string(), startMs: z.number(), endMs: z.number() })
  ),
});

/** What Mistral was asked, as far as these tests read it. */
const askedSchema = z.object({
  input: z.string(),
  model: z.string(),
  voice_id: z.string(),
});

/** An event of a line answered as it is made. */
const streamEventSchema = z.union([
  z.object({ audio: z.string() }),
  z.object({ words: answerSchema.shape.words }),
  z.object({ failed: z.literal(true) }),
]);

/** Every event of a line answered as it is made, a line of JSON each. */
const eventsOf = (body: string) =>
  body
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => streamEventSchema.parse(JSON.parse(line)));

/** The audio of a line's events, each piece as its bytes. */
const audioOf = (events: ReturnType<typeof eventsOf>): string[] =>
  events.flatMap((event) => ("audio" in event ? [atob(event.audio)] : []));

/** The voice turning a line away for a moment. */
const busy = { status: 429, headers: { "retry-after": "1" } };

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A line no other test says, so the cache and the provider have never seen it. */
const newLine = (): string => `Hello there, ${uniqueLetters()}.`;

/**
 * An onboarding running since yesterday, with one person whose link is
 * out, opened signed in as them: who they are, and their link as the page
 * holds it.
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
        email: `${person}@acme.test`,
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
  const { link: device } = await openLinkAs(
    secret,
    await signedInAs(`${person}@acme.test`)
  );
  return { person, link: device };
};

/**
 * Asks for `body` to be said, as the page does: a link in it is its secret
 * alone, and its session goes as the browser's cookie.
 */
const speak = async (
  {
    link,
    ...body
  }: (SpeechRequestBody | Record<string, unknown>) & {
    link?: { secret: string; cookie?: string };
  },
  headers: Record<string, string> = {}
): Promise<Response> =>
  await routed(speechPath, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      ...(link?.cookie === undefined ? {} : { cookie: link.cookie }),
      ...headers,
    },
    body: JSON.stringify(
      link === undefined ? body : { ...body, link: { secret: link.secret } }
    ),
  });

/** A refusal's status and code. */
const codeOf = async (response: Response) => {
  const parsed = errorPayloadSchema.safeParse(await response.json());
  return [response.status, parsed.success ? parsed.data.code : null];
};

/** What Mistral was asked for the lines carrying `text`. */
const askedFor = async (text: string) => {
  const carried = await carrying(text);
  return carried.map(({ body }) => askedSchema.parse(JSON.parse(body)));
};

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

    const first = await speak({ text, language: "en", link });
    const again = await speak({ text, language: "en", link });
    const result = {
      first: { status: first.status, body: await first.json() },
      again: { status: again.status, body: await again.json() },
    };

    const answer = answerSchema.parse(result.first.body);
    const said = Math.round(text.length * secondsPerCharacter * 1000);
    expect({
      status: result.first.status,
      mime: answer.mime,
      words: answer.words.map(({ text: word }) => word),
      ends: answer.words.at(-1)?.endMs,
    }).toStrictEqual({
      status: 200,
      mime: "audio/wav",
      words: text.split(" "),
      ends: said,
    });
    expect(result.again).toStrictEqual(result.first);
    await expect(carrying(text)).resolves.toHaveLength(1);
    // Counted once, for the line said: 30 ms for each of its characters.
    await expect(voiceCounted("interviews")).resolves.toBeCloseTo(
      before + text.length * secondsPerCharacter
    );
  });

  it("answers a line asked for streamed as it is made: its audio in pieces, then its words, and keeps it whole for the next to ask", async () => {
    const { link } = await opened();
    const text = newLine();
    const before = await voiceCounted("interviews");

    const streamed = await speak({ text, language: "en", link, stream: true });
    const events = eventsOf(await streamed.text());
    // Kept and counted once the answer is out: asked again only then.
    await vi.waitFor(async () => {
      await expect(voiceCounted("interviews")).resolves.toBeGreaterThan(before);
    });
    const asWhole = await speak({ text, language: "en", link });
    const whole = answerSchema.parse(await asWhole.json());
    const again = await speak({ text, language: "en", link, stream: true });
    const kept = eventsOf(await again.text());

    const said = Math.round(text.length * secondsPerCharacter * 1000);
    expect({
      status: streamed.status,
      type: streamed.headers.get("content-type"),
      // The provider's pieces, as they came: more than one.
      inPieces: audioOf(events).length > 1,
      audio: audioOf(events).join("") === atob(whole.audio),
      last: events.at(-1),
      keptAudio: audioOf(kept).join("") === atob(whole.audio),
      keptLast: kept.at(-1),
    }).toStrictEqual({
      status: 200,
      type: "application/x-ndjson",
      inPieces: true,
      audio: true,
      last: { words: whole.words },
      keptAudio: true,
      keptLast: { words: whole.words },
    });
    expect(whole.words.at(-1)?.endMs).toBe(said);
    // Said once, and counted once, however often and however it was asked.
    await expect(carrying(text)).resolves.toHaveLength(1);
    await expect(voiceCounted("interviews")).resolves.toBeCloseTo(
      before + text.length * secondsPerCharacter
    );
  });

  it("refuses a line asked for streamed at once when the voice is busy, as one asked for whole", async () => {
    const { link } = await opened();
    const text = newLine();
    // Busy, and busy again when asked once more.
    await plan(platformMistralKey, [busy, busy]);

    const result = await codeOf(
      await speak({ text, language: "en", link, stream: true })
    );

    expect(result).toStrictEqual([429, "speech.busy"]);
  });

  it("tells the page when a line breaks off halfway, and keeps nothing of it", async () => {
    const { link } = await opened();
    const text = newLine();
    // A piece of the file, and then the stream ends without saying it is done.
    await plan(platformMistralKey, [
      {
        sse: `data: ${JSON.stringify({ type: "speech.audio.delta", audio_data: btoa("RIFF") })}\n\n`,
      },
    ]);

    const broken = await speak({ text, language: "en", link, stream: true });
    const events = eventsOf(await broken.text());
    // Asked again, it is said anew: nothing was kept.
    const again = await speak({ text, language: "en", link });

    expect({
      status: broken.status,
      audio: audioOf(events),
      last: events.at(-1),
      again: again.status,
    }).toStrictEqual({
      status: 200,
      audio: ["RIFF"],
      last: { failed: true },
      again: 200,
    });
    await expect(carrying(text)).resolves.toHaveLength(2);
  });

  it.each([
    ["a link that isn't one", "unknown", 404, "interview.link_invalid"],
    ["someone else signed in", "elsewhere", 404, "interview.link_invalid"],
    ["nobody signed in", "signedOut", 401, "interview.sign_in"],
    // Before taking part the voice reads them what this is; once they
    // withdrew it says nothing more (GRA-329, T5).
    ["someone who withdrew", "withdrawn", 410, "interview.withdrawn"],
  ] as const)(
    "refuses a line for %s, sending nothing",
    async (_, kind, status, code) => {
      const { link } = await opened();
      if (kind === "withdrawn") {
        await participate(link);
        await onLink({ action: "withdraw", ...link });
      }
      const asked = {
        unknown: { ...link, secret: randomToken() },
        elsewhere: {
          ...link,
          cookie: await signedInAs(`someone-${unique()}@acme.test`),
        },
        signedOut: { secret: link.secret, cookie: "" },
        withdrawn: link,
      }[kind];

      const text = newLine();

      const result = await codeOf(
        await speak({ text, language: "en", link: asked })
      );

      expect(result).toStrictEqual([status, code]);
      await expect(carrying(text)).resolves.toStrictEqual([]);
    }
  );

  it("says a line bare whatever its tone, in any language, and times only the line's words", async () => {
    const { link } = await opened();
    const text = newLine();

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
    const said = [
      answerSchema.parse(await english.json()).words,
      answerSchema.parse(await dutch.json()).words,
    ];

    const asked = await askedFor(text);
    // No tone leads a line: a tag changed his delivery line by line.
    expect(asked.map(({ input }) => input)).toStrictEqual([text, text]);
    expect(
      said.map((words) => words.map(({ text: word }) => word))
    ).toStrictEqual([text.split(" "), text.split(" ")]);
    expect(said.map((words) => words[0]?.startMs)).toStrictEqual([0, 0]);
  });

  it("says a line as long as one may be, with no tone in front", async () => {
    const { link } = await opened();
    const start = newLine();
    const text = `${start}${"a".repeat(600 - start.length)}`;

    const response = await speak({
      text,
      language: "en",
      tone: "warm, grateful",
      link,
    });
    await response.body?.cancel();

    expect(response.status).toBe(200);
    await expect(askedFor(start)).resolves.toMatchObject([{ input: text }]);
  });

  it.each([
    ["a direction of its own", { text: "[sad] I'm sorry to hear that." }],
    ["a tone Stephen may not use", { tone: "sad, quiet" }],
    ["more than one request may have said", { text: "a".repeat(601) }],
    ["a language the onboarding isn't held in", { language: "it" }],
    ["a speaker there isn't", { speaker: "adam" }],
  ])("refuses a line with %s, sending nothing", async (_, change) => {
    const { link } = await opened();
    const text = newLine();

    const result = await codeOf(
      await speak({ text, language: "en", link, ...change })
    );

    expect(result).toStrictEqual([400, "speech.invalid"]);
    await expect(carrying(text)).resolves.toStrictEqual([]);
  });

  it.each([
    ["Stephen's line in his voice", {}],
    ["a quick line as any other", { quick: true }],
    ["a line asked for in Claire's voice in his", { speaker: "claire" }],
  ])("says %s", async (_, change) => {
    const { link } = await opened();
    const text = newLine();

    const response = await speak({ text, language: "de", link, ...change });
    await response.body?.cancel();

    await expect(askedFor(text)).resolves.toStrictEqual([
      { input: text, model: "voxtral-mini-tts-3-0", voice_id: stephen },
    ]);
  });

  it("refuses a new line once the link's voice for the day is used up, and still says one it said before", async () => {
    const { person, link } = await opened();
    const before = newLine();
    const after = newLine();

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
    const result = { again: again.status, new: await codeOf(fresh) };
    // What was said is noted for its erasure (GRA-1897); a line refused is
    // never said, and nothing of it is noted.
    const noted = await runInDurableObject(
      onboardingStore(env),
      async (_instance, state) => {
        const keys = [await storedKeyOf(before), await storedKeyOf(after)];
        return keys.map(
          (key) =>
            state.storage.sql
              .exec(
                "SELECT key FROM spoken_keys WHERE who = ? AND key = ?",
                `link:${person}`,
                key
              )
              .toArray().length
        );
      }
    );

    expect({ ...result, noted }).toStrictEqual({
      again: 200,
      new: [429, "speech.limited"],
      noted: [1, 0],
    });
    await expect(carrying(before)).resolves.toHaveLength(1);
    await expect(carrying(after)).resolves.toStrictEqual([]);
  });

  it("says a line for an admin signed in with ElevenLabs, counted as their own onboarding's", async () => {
    const { session } = await signedInWithRole(idp, "admin");
    const before = await voiceCounted("reading");
    const text = newLine();

    const response = await speak(
      { text, language: "en", speaker: "mark" },
      { cookie: session, "sec-fetch-site": "same-origin" }
    );
    const result = { status: response.status, body: await response.json() };

    expect(result.status).toBe(200);
    expect(answerSchema.parse(result.body)).toMatchObject({
      mime: "audio/mpeg",
      words: text.split(" ").map((word) => ({ text: word })),
    });
    // An admin's onboarding is said with ElevenLabs, in its own voices.
    const carried = await carrying(text);
    expect(carried.map(({ host, path }) => ({ host, path }))).toStrictEqual([
      {
        host: "api.eu.residency.elevenlabs.io",
        path: `/v1/text-to-speech/${platformAi.onboardingSpeech.voices.mark}/with-timestamps?enable_logging=false&output_format=mp3_44100_128`,
      },
    ]);
    await expect(voiceCounted("reading")).resolves.toBeCloseTo(
      before + text.length * secondsPerCharacter
    );
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

      const text = newLine();

      const result = await codeOf(
        await speak({ text, language: "en" }, headers)
      );

      expect(result).toStrictEqual([status, code]);
      await expect(carrying(text)).resolves.toStrictEqual([]);
    }
  );
});
