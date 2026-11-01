import { randomToken } from "@grasp-os/shared/encoding";
import { errorPayloadSchema } from "@grasp-os/shared/errors";
import { interviewApiPath } from "@grasp-os/shared/interview-links";
import type { Roster } from "@grasp-os/shared/onboarding";
import { speechPath } from "@grasp-os/shared/voice";
import type { SpeechRequestBody } from "@grasp-os/shared/voice";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { voiceBudgets } from "../src/onboarding/speech.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import { secondsPerCharacter } from "./ai-providers-fake.ts";
import { mockIdp } from "./idp.ts";
import { onLink, participate } from "./interview-link.ts";
import { carrying } from "./platform-providers.ts";
import { routed, signedInWithRole, unique } from "./sign-in.ts";

// The onboarding's lines said out loud (src/onboarding/speech.ts), over
// the endpoint, as the page asks for them: on someone's interview link, or
// for an admin signed in. ElevenLabs, Grasp's own speech feature's
// provider (@grasp-os/shared/platform-ai), is the outside system: a fake
// behind connect's fetch, which says each character in 25 ms. Connect, the
// store, the cache, the gateway's rules and its ledger are real. The ways
// it can fail, tried here:
//
// - A line said for a link that isn't one, a device that isn't the
//   link's, someone who isn't an admin, or another site.
// - A line said in a tone Stephen may not use, or with a direction of its
//   own.
// - A line said twice paid twice, or the voice running on past its budget.

/** Stephen's voice and Claire's, by their ElevenLabs IDs, the defaults. */
const stephen = "s3TPKV1kjDlVtZbl4Ksh";
const claire = "r1KmysJdVYZjJCm4mL3b";

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

/** A line no other test says, so the cache and the provider have never seen it. */
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

/** What ElevenLabs was asked for the lines carrying `text`: the voice, from the path, and the body. */
const askedFor = async (text: string) => {
  const carried = await carrying(text);
  return carried.map(({ path, body }) => ({
    voice: path.split("/").at(-2),
    ...askedSchema.parse(JSON.parse(body)),
  }));
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
    const said = text.length * secondsPerCharacter * 1000;
    expect({
      status: result.first.status,
      mime: answer.mime,
      words: answer.words.map(({ text: word }) => word),
      ends: answer.words.at(-1)?.endMs,
    }).toStrictEqual({
      status: 200,
      mime: "audio/mpeg",
      words: text.split(" "),
      ends: said,
    });
    expect(result.again).toStrictEqual(result.first);
    await expect(carrying(text)).resolves.toHaveLength(1);
    // Counted once, for the line said: 25 ms for each of its characters.
    await expect(voiceCounted("interviews")).resolves.toBeCloseTo(
      before + text.length * secondsPerCharacter
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
        unknown: { secret: randomToken(), key: link.key },
        elsewhere: { secret: link.secret, key: randomToken() },
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

  it("leads an English line with its tone and takes it out of the timing; another language is said bare", async () => {
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
    expect(asked.map(({ text: spoken }) => spoken)).toStrictEqual([
      `[warm, relaxed] ${text}`,
      text,
    ]);
    // Only the line's words, timed as said: in English after the
    // direction's 16 characters, in 400 ms; in Dutch at once.
    expect(
      said.map((words) => words.map(({ text: word }) => word))
    ).toStrictEqual([text.split(" "), text.split(" ")]);
    expect(said.map((words) => words[0]?.startMs)).toStrictEqual([400, 0]);
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
    ["Stephen's line in Eleven v4", {}, stephen, "eleven_v4"],
    ["a quick line in v4 Turbo", { quick: true }, stephen, "eleven_v4_turbo"],
    ["Claire's line in her voice", { speaker: "claire" }, claire, "eleven_v4"],
  ])("says %s", async (_, change, voice, model) => {
    const { link } = await opened();
    const text = newLine();

    const response = await speak({ text, language: "de", link, ...change });
    await response.body?.cancel();

    await expect(askedFor(text)).resolves.toStrictEqual([
      { voice, text, model_id: model, language_code: "de" },
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

    expect(result).toStrictEqual({
      again: 200,
      new: [429, "speech.limited"],
    });
    await expect(carrying(before)).resolves.toHaveLength(1);
    await expect(carrying(after)).resolves.toStrictEqual([]);
  });

  it("says a line for an admin signed in, counted as their own onboarding's", async () => {
    const { session } = await signedInWithRole(idp, "admin");
    const before = await voiceCounted("reading");
    const text = newLine();

    const response = await speak(
      { text, language: "en", speaker: "mark" },
      { cookie: session, "sec-fetch-site": "same-origin" }
    );
    const result = { status: response.status, body: await response.json() };

    expect(result.status).toBe(200);
    expect(answerSchema.parse(result.body).words).toHaveLength(3);
    await expect(askedFor(text)).resolves.toMatchObject([
      { voice: "cjVigY5qzO86Huf0OWal" },
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
