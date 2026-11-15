import { sha256Hex } from "@grasp-os/shared/encoding";
import { removedLine } from "@grasp-os/shared/interview-links";
import type {
  InterviewFact,
  InterviewProgress,
} from "@grasp-os/shared/interview-links";
import { speechPath } from "@grasp-os/shared/voice";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { onboardingStore } from "../src/onboarding/store.ts";
import { platformAi } from "../src/platform-ai.ts";
import { keepLine, keptLine } from "../src/speech-cache.ts";
import type { SpokenKey } from "../src/speech-cache.ts";
import { platformElevenLabsKey } from "./connect-providers.ts";
import { approve, codeOf, onLink, openedFor } from "./interview-link.ts";
import type { Device } from "./interview-link.ts";
import { d1ColumnsWith, onboardingTablesWith } from "./kept-where.ts";
import { carrying, plan, release } from "./platform-providers.ts";
import { auditedDuring, routed, unique } from "./sign-in.ts";

// Someone removes a line of their own interview (GRA-1897): only they
// read what was said, so only they can say which words go, from their
// link, on the device it is open on. The ways it can fail, from the
// threat model on the issue:
//
// - The words left anywhere: the interview as kept, a mark, a file's name,
//   a table, core's database, or the speech cache for a line of Stephen's.
// - The removal in the audit log, whose moment would tell the company's
//   admin whose interview it was.
// - A line marked removed that still holds words.
// - A device's older copy, or a save landing alongside, bringing it back.

/** The speech model lines are said in: the platform's default. */
const speechModel = `${platformAi.speech.provider}/${platformAi.speech.model}`;

/** A line as Stephen says it in English, as the speech cache keeps it. */
const spokenKey = (text: string): SpokenKey => ({
  text,
  spoken: `[warm] ${text}`,
  voice: platformAi.speech.voices.stephen,
  model: speechModel,
  language: "en",
});

/** A word only this test says, lower case as the scans look for it. */
const markerOf = (): string => `zqline${unique()}`;

/** An interview where Stephen said `stephen`, they said `theirs` (marked, with a file), and then something to keep. */
const progressOf = (stephen: string, theirs: string): InterviewProgress => ({
  person: "progress",
  told: true,
  mode: "type",
  lines: [
    {
      from: "stephen",
      text: `So ${stephen} is where it starts?`,
      tone: "warm",
    },
    {
      from: "person",
      text: `Yes, ${theirs} is the first step.`,
      typed: true,
      marks: [{ quote: `${theirs} is the first step`, tag: "step" }],
      file: `${theirs}.pdf`,
    },
    { from: "stephen", text: "And after that?" },
    { from: "person", text: "Then the lead signs it off.", typed: true },
  ],
  facts: [],
  phase: "steps",
  wants: "answer",
  startedAt: Date.now(),
  confirmed: 0,
  adding: false,
  addedAt: 0,
});

/** `progress` with the lines at `places` removed, as the page removes them. */
const removing = (
  progress: InterviewProgress,
  ...places: number[]
): InterviewProgress => ({
  ...progress,
  lines: progress.lines.map((line, at) =>
    places.includes(at) ? removedLine(line) : line
  ),
});

const savedSchema = z.object({ saved: z.boolean(), version: z.number() });

/** Saves `progress` from `device` over `version`: whether it was kept, and the version now. */
const save = async (
  device: Device,
  version: number,
  progress: unknown
): Promise<z.output<typeof savedSchema>> => {
  const response = await onLink({
    action: "save",
    ...device,
    version,
    progress,
  });
  return savedSchema.parse(await response.json());
};

/** Asks for a line to be said, as the page does. */
const speak = async (body: unknown): Promise<Response> =>
  await routed(speechPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** Their interview as kept. */
const keptOf = async (person: string) =>
  await onboardingStore(env).interviewStored(person);

/** What the onboarding's own log noted about `person`. */
const notedAbout = async (person: string): Promise<string[]> =>
  await runInDurableObject(onboardingStore(env), (_instance, state) =>
    state.storage.sql
      .exec<{ what: string }>("SELECT what FROM events WHERE about = ?", person)
      .toArray()
      .map(({ what }) => what)
  );

/** A device whose interview holds both markers, and the version it is at. */
const saying = async (stephen: string, theirs: string) => {
  const { link, person } = await openedFor();
  const progress = progressOf(stephen, theirs);
  const { version } = await save(link, 0, progress);
  return { link, person, progress, version };
};

describe("removing a line of an interview", { timeout: 60_000 }, () => {
  it("takes its words, marks and file out of everything kept, Stephen's from the speech cache, and keeps the rest", async () => {
    const stephen = markerOf();
    const theirs = markerOf();
    const { link, person, progress, version } = await saying(stephen, theirs);
    const audio = JSON.stringify({
      audio: "AAAA",
      mime: "audio/mpeg",
      words: [],
    });
    const [said] = progress.lines;
    const elsewhere = `And after that? ${unique()}`;
    await keepLine(env, spokenKey(said?.text ?? ""), audio);
    await keepLine(env, spokenKey(elsewhere), audio);
    const before = {
      stephen: await onboardingTablesWith(stephen),
      theirs: await onboardingTablesWith(theirs),
    };

    let saved: z.output<typeof savedSchema> | undefined;
    const events = await auditedDuring(async () => {
      saved = await save(link, version, removing(progress, 0, 1));
    });
    const kept = await keptOf(person);
    const noted = await notedAbout(person);

    expect({
      saved: saved?.saved,
      before,
      onboarding: [
        ...(await onboardingTablesWith(stephen)),
        ...(await onboardingTablesWith(theirs)),
      ],
      core: [
        ...(await d1ColumnsWith(env.DB, stephen)),
        ...(await d1ColumnsWith(env.DB, theirs)),
      ],
      cached: await keptLine(env, spokenKey(said?.text ?? "")),
      elsewhere: await keptLine(env, spokenKey(elsewhere)),
      lines: kept !== null && "progress" in kept ? kept.progress.lines : null,
      audited: events.map(({ action }) => action),
      noted: noted.filter((what) => what === "interview.line_removed"),
    }).toStrictEqual({
      saved: true,
      // The positive control: both were kept before.
      before: { stephen: ["interviews"], theirs: ["interviews"] },
      onboarding: [],
      core: [],
      cached: undefined,
      elsewhere: audio,
      lines: [
        { from: "stephen", text: "", removed: true },
        { from: "person", text: "", removed: true },
        { from: "stephen", text: "And after that?" },
        { from: "person", text: "Then the lead signs it off.", typed: true },
      ],
      // Nothing for the company's admin to read a moment from.
      audited: [],
      noted: ["interview.line_removed"],
    });
  });

  it("refuses a removed line that still holds words, and keeps the interview as it was", async () => {
    const theirs = markerOf();
    const { link, person, progress, version } = await saying(
      markerOf(),
      theirs
    );
    const [, line] = progress.lines;

    const response = await onLink({
      action: "save",
      ...link,
      version,
      progress: {
        ...progress,
        lines: progress.lines.map((each, at) =>
          at === 1 ? { ...line, text: "Still here.", removed: true } : each
        ),
      },
    });

    expect({
      refused: await codeOf(response),
      kept: JSON.stringify(await keptOf(person)).includes(theirs),
    }).toStrictEqual({ refused: [400, "interview.invalid"], kept: true });
  });

  it("refuses the device's older copy, so the words don't come back", async () => {
    const theirs = markerOf();
    const { link, person, progress, version } = await saying(
      markerOf(),
      theirs
    );
    await save(link, version, removing(progress, 1));

    const older = await save(link, version, progress);

    expect({
      saved: older.saved,
      kept: await onboardingTablesWith(theirs),
      lines: await keptOf(person).then((kept) =>
        kept !== null && "progress" in kept ? kept.progress.lines[1] : null
      ),
    }).toStrictEqual({
      saved: false,
      kept: [],
      lines: { from: "person", text: "", removed: true },
    });
  });

  it.each(["removal", "other"] as const)(
    "keeps one of two saves made in one tick over the same version, the %s first",
    async (firstly) => {
      const stephen = markerOf();
      const { link, person, progress, version } = await saying(
        stephen,
        markerOf()
      );
      const removal = removing(progress, 0);
      const other: InterviewProgress = {
        ...progress,
        lines: [...progress.lines, { from: "stephen", text: "And then?" }],
      };
      const secretMark = await sha256Hex(link.secret);
      const keyMark = await sha256Hex(link.key);

      // Both inside the store at once: the removal waits on hashing the
      // voice's line, and the other save may land meanwhile.
      const answers = await runInDurableObject(
        onboardingStore(env),
        async (instance) =>
          await Promise.all(
            (firstly === "removal" ? [removal, other] : [other, removal]).map(
              async (copy) =>
                await instance.saveInterview(secretMark, keyMark, version, copy)
            )
          )
      );
      const kept = await keptOf(person);
      const lines =
        kept !== null && "progress" in kept ? kept.progress.lines : [];

      expect({
        saved: answers.filter((answer) => answer.ok && answer.value.saved)
          .length,
        // Whichever was kept is whole: the removal, or the other copy.
        whole:
          JSON.stringify(lines) === JSON.stringify(removal.lines) ||
          JSON.stringify(lines) === JSON.stringify(other.lines),
      }).toStrictEqual({ saved: 1, whole: true });
    }
  );

  it("refuses a copy that brings back a line they removed, at the version kept too", async () => {
    const theirs = markerOf();
    const { link, person, progress, version } = await saying(
      markerOf(),
      theirs
    );
    const { version: removed } = await save(
      link,
      version,
      removing(progress, 1)
    );

    // Another tab's copy, saved over the version kept: the line is back in it.
    const back = await save(link, removed, progress);

    expect({
      saved: back.saved,
      kept: await onboardingTablesWith(theirs),
      line: await keptOf(person).then((kept) =>
        kept !== null && "progress" in kept ? kept.progress.lines[1] : null
      ),
    }).toStrictEqual({
      saved: false,
      kept: [],
      line: { from: "person", text: "", removed: true },
    });
  });

  it("erases what was written down from a removed line once they take it out and the interview is completed", async () => {
    const theirs = markerOf();
    const { link, person, progress, version } = await saying(
      markerOf(),
      theirs
    );
    const fact: InterviewFact = {
      id: "f1",
      tag: "step",
      text: `${theirs} is the first step.`,
      record: `${theirs} is the first step.`,
    };
    const other: InterviewFact = {
      id: "f2",
      tag: "handoff",
      text: "The lead signs it off.",
      record: "The lead signs it off.",
    };
    const written = { ...progress, facts: [fact, other] };
    const { version: v1 } = await save(link, version, written);
    await approve(link, written.facts);
    const audio = JSON.stringify({
      audio: "AAAA",
      mime: "audio/mpeg",
      words: [],
    });
    await keepLine(env, spokenKey(fact.text), audio);
    await keepLine(env, spokenKey(other.text), audio);

    // The line removed and what was written from it taken out: until the
    // interview is completed, it can still be put back.
    const out = {
      ...removing(written, 1),
      facts: [{ ...fact, out: true as const }, other],
    };
    const { version: v2 } = await save(link, v1, out);
    const putBack = await onboardingTablesWith(theirs);
    const { saved } = await save(link, v2, {
      ...out,
      person: "completed",
    });
    const kept = await keptOf(person);

    expect({
      putBack,
      saved,
      onboarding: await onboardingTablesWith(theirs),
      core: await d1ColumnsWith(env.DB, theirs),
      cached: await keptLine(env, spokenKey(fact.text)),
      other: await keptLine(env, spokenKey(other.text)),
      facts:
        kept !== null && "progress" in kept
          ? kept.progress.facts.map(({ id }) => id)
          : null,
    }).toStrictEqual({
      putBack: ["interviews"],
      saved: true,
      onboarding: [],
      core: [],
      cached: undefined,
      other: audio,
      facts: ["f2"],
    });
  });

  it("takes a line of Stephen's out of the cache when it is removed while the voice still says it", async () => {
    const stephen = markerOf();
    const { link, progress, version } = await saying(stephen, markerOf());
    const [said] = progress.lines;
    const text = said?.text ?? "";
    const held = `voice-${unique()}`;
    await plan(platformElevenLabsKey, [{ release: held }]);

    // The voice is asked for the line, and holds its answer.
    const speaking = speak({ text, language: "en", link });
    await expect
      .poll(async () => await carrying(text), { timeout: 10_000 })
      .toHaveLength(1);
    await save(link, version, removing(progress, 0));
    await release(held);
    const spoken = await speaking;
    // Asked again: from the cache if it kept the line, else from the voice.
    await speak({ text, language: "en", link });
    const voiced = await carrying(text);

    expect({ spoken: spoken.status, voiced: voiced.length }).toStrictEqual({
      spoken: 200,
      voiced: 2,
    });
  });
});
