import { addDays } from "@grasp-os/shared/admin/org-record";
import { sha256Hex } from "@grasp-os/shared/encoding";
import {
  erasedFact,
  interviewProgressSchema,
  nextFactId,
  removedLine,
} from "@grasp-os/shared/interview-links";
import type {
  InterviewFact,
  InterviewProgress,
} from "@grasp-os/shared/interview-links";
import { speechPath } from "@grasp-os/shared/voice";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { closesOn } from "../src/onboarding/rules.ts";
import { onboardingStore } from "../src/onboarding/store.ts";
import { platformElevenLabsKey } from "./connect-providers.ts";
import { mockIdp } from "./idp.ts";
import {
  accountOf,
  approve,
  codeOf,
  onLink,
  openedFor,
} from "./interview-link.ts";
import type { Device } from "./interview-link.ts";
import { d1ColumnsWith, onboardingTablesWith } from "./kept-where.ts";
import { carrying, plan, release } from "./platform-providers.ts";
import { auditedDuring, routed, signedInWithRole, unique } from "./sign-in.ts";
import { sayForAdmin, sayOnLink, stillKept } from "./spoken.ts";

// Someone removes a line of their own interview (GRA-1897): only they
// read what was said, so only they can say which words go, from their
// link, on the device it is open on. The ways it can fail, from the
// threat model on the issue:
//
// - The words left anywhere: the interview as kept, a mark, a file's name,
//   a table, core's database, or the speech cache: as the page says it, a
//   sentence at a time, and the read-back in a story's words.
// - The removal in the audit log, whose moment would tell the company's
//   admin whose interview it was.
// - A line marked removed that still holds words.
// - A device's older copy, or a save landing alongside, bringing it back.

const idp = mockIdp();

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
      text: `So ${stephen} is where it starts. Is that right?`,
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

/** Asks for a line to be said on `link`, as the page does. */
const speak = async ({
  link,
  ...body
}: Record<string, unknown> & { link: Device }): Promise<Response> =>
  await routed(speechPath, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      cookie: link.cookie,
    },
    body: JSON.stringify({ ...body, link: { secret: link.secret } }),
  });

/**
 * Their interview as the store keeps it: read as an interview, or as
 * stored when it no longer reads as one; null when none is kept.
 */
const keptOf = async (
  person: string
): Promise<{ progress: InterviewProgress } | { unreadable: string } | null> => {
  const [row] = await runInDurableObject(
    onboardingStore(env),
    (_instance, state) =>
      state.storage.sql
        .exec<{ progress: string }>(
          "SELECT progress FROM interviews WHERE person = ?",
          person
        )
        .toArray()
  );
  if (row === undefined) {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(row.progress);
  } catch {
    return { unreadable: row.progress };
  }
  const parsed = interviewProgressSchema.safeParse(json);
  return parsed.success
    ? { progress: parsed.data }
    : { unreadable: row.progress };
};

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

/** A day, in ms. */
const dayMs = 24 * 60 * 60 * 1000;

/** The statement `f1` as it is kept once erased: nothing of what it said. */
const erasedOf = { id: "f1", tag: "step", text: "", record: "", out: true };

/**
 * An interview where they said `theirs`, written down as f1 beside f2,
 * both approved; then the line removed and f1 taken out, not completed
 * yet, and the read-back's story said after.
 */
const takenOutFrom = async (
  theirs: string,
  { approved = true }: { approved?: boolean } = {}
) => {
  const { link, person, progress, version } = await saying(markerOf(), theirs);
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
  if (approved) {
    await approve(link, written.facts);
  }
  const out: InterviewProgress = {
    ...removing(written, 1),
    facts: [{ ...fact, out: true }, other],
  };
  const { version: v2 } = await save(link, v1, out);
  // The read-back as the page says it: a story in words of its own, not
  // the statement's; and a line said for an admin, elsewhere.
  const story = `So it starts with ${theirs}, as you said.`;
  const { session } = await signedInWithRole(idp, "admin");
  const elsewhere = `Welcome back, ${unique()}.`;
  // Both said, and kept: what each test then finds gone was there.
  expect([
    await sayOnLink(link, story),
    await sayForAdmin(session, elsewhere),
    await stillKept(story),
    await stillKept(elsewhere),
  ]).toStrictEqual([200, 200, true, true]);
  return { link, person, fact, other, story, elsewhere, out, version: v2 };
};

/** Where `theirs` is left, and the facts kept, after `taken`. */
const leftOf = async (
  theirs: string,
  taken: Awaited<ReturnType<typeof takenOutFrom>>
) => {
  const kept = await keptOf(taken.person);
  return {
    onboarding: await onboardingTablesWith(theirs),
    core: await d1ColumnsWith(env.DB, theirs),
    cached: await stillKept(taken.story),
    other: await stillKept(taken.elsewhere),
    facts: kept !== null && "progress" in kept ? kept.progress.facts : null,
  };
};

/** The store's alarm as set now; null for none. */
const alarmSet = async (): Promise<number | null> =>
  await runInDurableObject(
    onboardingStore(env),
    async (_instance, state) => await state.storage.getAlarm()
  );

/** Clears the store's alarm: every one set before has run. */
const noAlarm = async (): Promise<void> => {
  await runInDurableObject(onboardingStore(env), async (_instance, state) => {
    await state.storage.deleteAlarm();
  });
};

/** As the system sets things in the store. */
const system = { type: "system" } as const;

/** A plan whose interviews closed weeks ago: the close passed. */
const closedLongAgo = () => ({
  start: new Date(Date.now() - 40 * dayMs).toISOString().slice(0, 10),
  days: 14,
});

/** The facts `person` has approvals of, by id. */
const approvalsOf = async (person: string): Promise<string[]> =>
  await runInDurableObject(onboardingStore(env), (_instance, state) =>
    state.storage.sql
      .exec<{ fact: string }>(
        "SELECT DISTINCT fact FROM approvals WHERE person = ? ORDER BY fact",
        person
      )
      .toArray()
      .map(({ fact }) => fact)
  );

describe("removing a line of an interview", { timeout: 60_000 }, () => {
  it("takes its words, marks and file out of everything kept, Stephen's from the speech cache, and keeps the rest", async () => {
    const stephen = markerOf();
    const theirs = markerOf();
    const { link, person, progress, version } = await saying(stephen, theirs);
    // Stephen's line as the page says it: a sentence at a time.
    const pieces = [`So ${stephen} is where it starts.`, "Is that right?"];
    const statuses: number[] = [];
    for (const piece of pieces) {
      // oxlint-disable-next-line no-await-in-loop -- one sentence after another
      statuses.push(await sayOnLink(link, piece));
    }
    const { session } = await signedInWithRole(idp, "admin");
    const elsewhere = `And after that? ${unique()}`;
    statuses.push(await sayForAdmin(session, elsewhere));
    const before = {
      stephen: await onboardingTablesWith(stephen),
      theirs: await onboardingTablesWith(theirs),
      said: await Promise.all(pieces.map(stillKept)),
      statuses,
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
      cached: await Promise.all(pieces.map(stillKept)),
      elsewhere: await stillKept(elsewhere),
      lines: kept !== null && "progress" in kept ? kept.progress.lines : null,
      audited: events.map(({ action }) => action),
      noted: noted.filter((what) => what === "interview.line_removed"),
    }).toStrictEqual({
      saved: true,
      // The positive control: both were kept before, and both sentences said.
      before: {
        stephen: ["interviews"],
        theirs: ["interviews"],
        said: [true, true],
        statuses: [200, 200, 200],
      },
      onboarding: [],
      core: [],
      cached: [false, false],
      elsewhere: true,
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
      const keyMark = await accountOf(link);

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

  it("erases what was written down from a removed line once they take it out and the interview is completed, in its place", async () => {
    const theirs = markerOf();
    const taken = await takenOutFrom(theirs);
    const approvedBefore = await approvalsOf(taken.person);
    const putBack = await onboardingTablesWith(theirs);
    const voiced = await stillKept(taken.story);

    const { saved } = await save(taken.link, taken.version, {
      ...taken.out,
      person: "completed",
    });

    expect({
      putBack,
      voiced,
      approvedBefore,
      saved,
      ...(await leftOf(theirs, taken)),
      approved: await approvalsOf(taken.person),
    }).toStrictEqual({
      // Until it is completed, it can still be put back.
      putBack: ["interviews"],
      // The read-back's story was said, and kept, until it was completed.
      voiced: true,
      approvedBefore: ["f1", "f2"],
      saved: true,
      onboarding: [],
      core: [],
      cached: false,
      other: true,
      facts: [erasedOf, taken.other],
      approved: ["f2"],
    });
  });

  it("erases a statement the page sends erased as it completes, with its approvals and its voice", async () => {
    const theirs = markerOf();
    const taken = await takenOutFrom(theirs);

    // As the page completes: what was taken out erased in its own copy.
    const { saved } = await save(taken.link, taken.version, {
      ...taken.out,
      person: "completed",
      facts: [erasedFact(taken.fact), { ...taken.other, agreed: true }],
    });

    expect({
      saved,
      ...(await leftOf(theirs, taken)),
      approved: await approvalsOf(taken.person),
    }).toStrictEqual({
      saved: true,
      onboarding: [],
      core: [],
      cached: false,
      other: true,
      facts: [erasedOf, { ...taken.other, agreed: true }],
      approved: ["f2"],
    });
  });

  it("refuses the words back from the tab that completed it, reopened, or put back", async () => {
    const theirs = markerOf();
    const taken = await takenOutFrom(theirs);
    const { version } = await save(taken.link, taken.version, {
      ...taken.out,
      person: "completed",
    });

    // The tab still holds its own copy, with the words: it adds something.
    const reopened = await save(taken.link, version, {
      ...taken.out,
      person: "progress",
      wants: "answer",
      adding: true,
    });
    const putBack = await save(taken.link, reopened.version, {
      ...taken.out,
      person: "progress",
      facts: [taken.fact, taken.other],
    });

    expect({
      reopened: reopened.saved,
      putBack: putBack.saved,
      ...(await leftOf(theirs, taken)),
    }).toStrictEqual({
      reopened: false,
      putBack: false,
      onboarding: [],
      core: [],
      cached: false,
      other: true,
      facts: [erasedOf, taken.other],
    });
  });

  it("keeps saving a tab that took core's copy and adds a statement after one was erased", async () => {
    const taken = await takenOutFrom(markerOf());
    const { version } = await save(taken.link, taken.version, {
      ...taken.out,
      person: "completed",
    });
    const kept = await keptOf(taken.person);
    const copy = kept !== null && "progress" in kept ? kept.progress : null;
    // Numbered as the page numbers what it writes down.
    const added: InterviewFact = {
      id: nextFactId(copy?.facts ?? []),
      tag: "step",
      text: "Then it is booked.",
      record: "Then it is booked.",
    };

    const answer =
      copy === null
        ? null
        : await save(taken.link, version, {
            ...copy,
            person: "progress",
            wants: "answer",
            adding: true,
            facts: [...copy.facts, added],
          });
    const after = await keptOf(taken.person);

    expect({
      saved: answer?.saved,
      ids:
        after !== null && "progress" in after
          ? after.progress.facts.map(({ id }) => id)
          : null,
    }).toStrictEqual({ saved: true, ids: ["f1", "f2", "f3"] });
  });

  it("erases what was taken out of an interview nobody completed once the interviews closed", async () => {
    const theirs = markerOf();
    const taken = await takenOutFrom(theirs);
    const store = onboardingStore(env);
    const open = await store.eraseTakenOutAfterClose();
    const kept = await onboardingTablesWith(theirs);

    // Long past the close: the alarm's run then.
    const closed = await store.eraseTakenOutAfterClose(
      new Date(Date.now() + 60 * dayMs).toISOString()
    );
    // The device's copy, with the words, is older now.
    const older = await save(taken.link, taken.version, taken.out);

    expect({
      open,
      kept,
      closed,
      older: older.saved,
      ...(await leftOf(theirs, taken)),
      approved: await approvalsOf(taken.person),
    }).toStrictEqual({
      open: 0,
      kept: ["interviews"],
      closed: 1,
      older: false,
      onboarding: [],
      core: [],
      cached: false,
      other: true,
      facts: [erasedOf, taken.other],
      approved: ["f2"],
    });
  });

  it("erases at the close of an onboarding paused across it, by the alarm, and sets no alarm after", async () => {
    const theirs = markerOf();
    const taken = await takenOutFrom(theirs, { approved: false });
    const store = onboardingStore(env);
    const { plan: running } = await store.view();
    await noAlarm();
    await store.setPaused(true, system);
    // Paused with the close ahead: the alarm waits for the day after it.
    await expect
      .poll(alarmSet, { timeout: 10_000 })
      .toBe(
        running === null
          ? null
          : Date.parse(`${addDays(closesOn(running), 1)}T00:00:00.000Z`)
      );
    await noAlarm();

    // The interviews close while it is paused.
    await store.savePlan(closedLongAgo(), system);
    await expect.poll(alarmSet, { timeout: 10_000 }).not.toBeNull();
    const ran = await runDurableObjectAlarm(store);
    const left = await leftOf(theirs, taken);
    const after = await alarmSet();
    await store.setPaused(false, system);

    expect({ ran, ...left, after }).toStrictEqual({
      ran: true,
      onboarding: [],
      core: [],
      cached: false,
      other: true,
      facts: [erasedOf, taken.other],
      after: null,
    });
  });

  it("erases at the close of an onboarding resumed after it, by the alarm", async () => {
    const theirs = markerOf();
    const taken = await takenOutFrom(theirs, { approved: false });
    const store = onboardingStore(env);
    await store.setPaused(true, system);
    await store.savePlan(closedLongAgo(), system);
    await alarmSet();
    await noAlarm();

    await store.setPaused(false, system);
    await expect.poll(alarmSet, { timeout: 10_000 }).not.toBeNull();
    const ran = await runDurableObjectAlarm(store);

    expect({ ran, ...(await leftOf(theirs, taken)) }).toStrictEqual({
      ran: true,
      onboarding: [],
      core: [],
      cached: false,
      other: true,
      facts: [erasedOf, taken.other],
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
