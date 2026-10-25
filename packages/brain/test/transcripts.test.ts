import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { ensureCollection } from "../src/collections.ts";
import type { CollectionRow } from "../src/collections.ts";
import { writeVersion } from "../src/documents.ts";
import type { Writer } from "../src/documents.ts";
import { knowledgeErrors } from "../src/knowledge.ts";
import { preparePurge, purge } from "../src/purge.ts";
import { search } from "../src/search.ts";
import {
  listTranscripts,
  readTranscript,
  transcriptMaxTurns,
} from "../src/transcripts.ts";
import type { Transcript } from "../src/transcripts.ts";
import type { Caller } from "./host.ts";
import { newCollection, noCopies, testHost, writerOf } from "./host.ts";

// Transcripts on the Brain's documents (src/transcripts.ts), through the
// package's own calls, with a host of fake ports (host.ts). Written from
// the ways a transcript can leak:
// 1. To a reader the host's `authorize` doesn't give its document: another
//    collection, or another path of a collection read by path.
// 2. Past the text it came with: an edit that brings none keeps the old
//    turns.
// 3. Past an erasure: a personal purge leaves the collection's transcripts,
//    or a content purge leaves a term in a speaker, a turn or a chapter
//    title, also when the document's text never held it.
// 4. Into the audit log: an event carrying a speaker or a word.
// 5. Past its limits: a malformed or oversized transcript saved at all.

/** The code of what `promise` refused with, or "ok". */
const outcome = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return knowledgeErrors.codeOf(error) ?? String(error);
  }
};

/** A word no other test's text has. */
const word = () => `w${crypto.randomUUID().replaceAll("-", "")}`;

/** A meeting: two speakers with times, and a chapter over each. */
const meeting = (speaker: string, said: string): Transcript => ({
  turns: [
    { speaker, text: `Welcome, ${said} first.`, startMs: 0, endMs: 4000 },
    { speaker: "Grasp", text: "What takes longest?", startMs: 4000 },
    { speaker, text: "Copying invoices by hand.", startMs: 9000 },
  ],
  chapters: [
    { title: `Opening by ${speaker}`, firstTurn: 0, lastTurn: 1 },
    { title: "Invoices", firstTurn: 2, lastTurn: 2 },
  ],
});

/** Saves `text` with `transcript` (or none) as the next version at `path`. */
const save = async (
  brain: ReturnType<typeof testHost>["brain"],
  collection: CollectionRow,
  path: string,
  text: string,
  {
    ifVersion = 0,
    transcript,
    writer = writerOf("owner"),
  }: { ifVersion?: number; transcript?: unknown; writer?: Writer } = {}
) =>
  await writeVersion(brain, writer, {
    collection,
    path,
    text,
    ifVersion,
    message: null,
    restoredFrom: null,
    ...(transcript === undefined ? {} : { transcript }),
  });

/** Whether any transcript row the database holds, as stored, holds one of `needles`. */
const storedHolds = async (...needles: string[]): Promise<boolean> => {
  const { results } = await env.BRAIN.prepare(
    "SELECT document_id || ' ' || turns || ' ' || chapters AS row FROM transcripts"
  ).all<{ row: string }>();
  return results.some(({ row }) =>
    needles.some((needle) => row.includes(needle))
  );
};

/** The texts a reader gets of `documentId`'s transcript, if any. */
const readOf = async (
  brain: ReturnType<typeof testHost>["brain"],
  caller: Caller,
  documentId: string
) => {
  const found = await readTranscript(brain, caller, documentId);
  return found === undefined
    ? null
    : JSON.stringify([
        found.read.transcript.turns,
        found.read.transcript.chapters,
      ]);
};

/** How many transcript purges of `documentId` the audit outbox holds. */
const recordedPurges = async (documentId: string): Promise<number> => {
  const { results } = await env.BRAIN.prepare(
    "SELECT event FROM audit_outbox WHERE instr(event, 'knowledge.transcript.purged') > 0 AND instr(event, ?) > 0"
  )
    .bind(documentId)
    .all();
  return results.length;
};

/** The SQL a batched statement runs, as drizzle writes it; empty for one it can't say. */
const sqlOf = (statement: unknown): string => {
  const toSQL: unknown =
    typeof statement === "object" && statement !== null
      ? Reflect.get(statement, "toSQL")
      : undefined;
  if (typeof toSQL !== "function") {
    return "";
  }
  const query: unknown = Reflect.apply(toSQL, statement, []);
  const text: unknown =
    typeof query === "object" && query !== null
      ? Reflect.get(query, "sql")
      : undefined;
  return typeof text === "string" ? text : "";
};

describe("a document's transcript", () => {
  it("reaches only a reader the host's authorize gives its document, by collection and by path, listed by counts alone, and each read is recorded", async () => {
    const { brain, reads } = testHost();
    const open = await newCollection(brain, "Open");
    const closed = await newCollection(brain, "Closed");
    const byPath = await newCollection(brain, "By path");
    const name = word();
    const shared = await save(brain, open, "sync.md", "# Sync", {
      transcript: meeting(name, "the budget"),
    });
    const hidden = await save(brain, closed, "board.md", "# Board", {
      transcript: meeting(name, "the reorganisation"),
    });
    const allowed = await save(brain, byPath, "mine.md", "# Mine", {
      transcript: meeting(name, "my numbers"),
    });
    const notAllowed = await save(brain, byPath, "theirs.md", "# Theirs", {
      transcript: meeting(name, "their numbers"),
    });
    const reader: Caller = {
      userId: "reader",
      reads: [open.id, byPath.id],
      only: { [byPath.id]: ["mine.md"] },
    };

    const { transcripts } = await listTranscripts(brain, reader);
    const saved: ReadonlySet<string> = new Set([
      shared.id,
      hidden.id,
      allowed.id,
      notAllowed.id,
    ]);
    const ours = transcripts.filter(({ documentId }) => saved.has(documentId));
    const opened: Record<string, boolean> = {};
    for (const document of [shared, hidden, allowed, notAllowed]) {
      // oxlint-disable-next-line no-await-in-loop -- one read after another
      const found = await readTranscript(brain, reader, document.id);
      opened[document.path] = found !== undefined;
    }
    const read = reads.filter(({ caller }) => caller === "reader");

    expect({
      listed: ours
        .map(({ path, turns, chapters }) => ({ path, turns, chapters }))
        .toSorted((one, other) => (one.path < other.path ? -1 : 1)),
      opened,
      recorded: read.map(({ record }) => ({
        action: record.action,
        read: record.detail.read,
        ours: [...(record.documentIds ?? []), record.target?.id ?? ""]
          .filter((id) => saved.has(id))
          .toSorted(),
      })),
    }).toStrictEqual({
      // Counts, never turns: a listing loads none.
      listed: [
        { path: "mine.md", turns: 3, chapters: 2 },
        { path: "sync.md", turns: 3, chapters: 2 },
      ],
      opened: {
        "sync.md": true,
        "board.md": false,
        "mine.md": true,
        "theirs.md": false,
      },
      recorded: [
        {
          action: "knowledge.read",
          read: "transcripts",
          ours: [allowed.id, shared.id].toSorted(),
        },
        { action: "knowledge.read", read: "transcript", ours: [shared.id] },
        { action: "knowledge.read", read: "transcript", ours: [allowed.id] },
      ],
    });
  });

  it("is decided on every read: once the host's authorize no longer gives the collection, its turns and chapters are gone", async () => {
    const { brain } = testHost();
    const team = await newCollection(brain, "Team");
    const name = word();
    const call = await save(brain, team, "call.md", "# Call", {
      transcript: meeting(name, "the plan"),
    });
    const shown = async (reads: string[]) => {
      const found = await readTranscript(
        brain,
        { userId: "reader", reads },
        call.id
      );
      return found === undefined
        ? null
        : {
            turns: found.read.transcript.turns.length,
            chapters: found.read.transcript.chapters.map(({ title }) => title),
          };
    };
    const before = await shown([team.id]);
    // The same reader, once the host took the collection away.
    const after = await shown([]);

    expect({ before, after }).toStrictEqual({
      before: { turns: 3, chapters: [`Opening by ${name}`, "Invoices"] },
      after: null,
    });
  });

  it("goes with the next save that brings none, so an edit never keeps the turns of the text it replaced", async () => {
    const { brain, events } = testHost();
    const notes = await newCollection(brain, "Notes");
    const name = word();
    const caller: Caller = { userId: "reader", reads: [notes.id] };
    const first = await save(brain, notes, "call.md", `# Call\n${name}`, {
      transcript: meeting(name, "the call"),
    });
    const before = await readOf(brain, caller, first.id);
    await save(brain, notes, "call.md", "# Call\nRewritten by hand.", {
      ifVersion: 1,
    });

    expect({
      before: before?.includes(name),
      after: await readOf(brain, caller, first.id),
      stored: await storedHolds(first.id),
      removed: events
        .filter(
          ({ action, target }) =>
            action === "knowledge.transcript.removed" && target?.id === first.id
        )
        .map(({ detail }) => detail),
    }).toStrictEqual({
      before: true,
      after: null,
      stored: false,
      removed: [{ version: 2 }],
    });
  });

  it("is refused out of order or past its limits, and nothing of the save is kept", async () => {
    const { brain } = testHost();
    const notes = await newCollection(brain, "Notes");
    const turn = { speaker: "Anna", text: "Hello." };
    const refused = {
      chapterPastTheTurns: {
        turns: [turn],
        chapters: [{ title: "Later", firstTurn: 0, lastTurn: 3 }],
      },
      chaptersOverlapping: {
        turns: [turn, turn, turn],
        chapters: [
          { title: "One", firstTurn: 0, lastTurn: 1 },
          { title: "Two", firstTurn: 1, lastTurn: 2 },
        ],
      },
      endWithoutStart: { turns: [{ ...turn, endMs: 10 }], chapters: [] },
      endBeforeStart: {
        turns: [{ ...turn, startMs: 10, endMs: 5 }],
        chapters: [],
      },
      noTurns: { turns: [], chapters: [] },
      tooManyTurns: {
        turns: Array.from({ length: transcriptMaxTurns + 1 }, () => turn),
        chapters: [],
      },
      unknownField: { turns: [{ ...turn, person: "user-1" }], chapters: [] },
    };
    const outcomes: Record<string, string> = {};
    for (const [what, transcript] of Object.entries(refused)) {
      // oxlint-disable-next-line no-await-in-loop -- one save after another
      outcomes[what] = await outcome(
        save(brain, notes, `${what}.md`, `# ${what}`, { transcript })
      );
    }
    const { results } = await env.BRAIN.prepare(
      "SELECT count(*) AS n FROM documents WHERE collection_id = ?"
    )
      .bind(notes.id)
      .all<{ n: number }>();

    expect({ outcomes, documents: results[0]?.n }).toStrictEqual({
      outcomes: Object.fromEntries(
        Object.keys(refused).map((what) => [what, "knowledge.invalid"])
      ),
      documents: 0,
    });
  });

  it("is deleted with its collection by a personal purge", async () => {
    const { brain } = testHost();
    const leaver = `leaver-${word()}`;
    const personal = await ensureCollection(
      brain,
      {
        id: `personal-${leaver}`,
        name: "Personal",
        description: "",
        owner: leaver,
        access: "me",
        sensitive: false,
        source: "here",
        createdAt: new Date(),
      },
      { type: "person", userId: leaver }
    );
    const kept = await save(brain, personal, "one-to-one.md", "# 1:1", {
      transcript: meeting(leaver, "my review"),
      writer: writerOf(leaver),
    });
    const admin = writerOf("admin");
    const input = {
      type: "personal" as const,
      userId: leaver,
      reason: "offboarding" as const,
    };
    const { token } = await preparePurge(brain, admin, input, noCopies);
    await purge(brain, admin, input, token, noCopies);

    await expect(storedHolds(kept.id, leaver)).resolves.toBeFalsy();
  });

  it("loses a purged term from every speaker, turn and chapter title, and keeps the rest with the version the purge saves", async () => {
    const { brain } = testHost();
    const notes = await newCollection(brain, "Notes");
    const name = word();
    const caller: Caller = { userId: "reader", reads: [notes.id] };
    const call = await save(
      brain,
      notes,
      "call.md",
      `# Call\n${name}: Welcome, the budget first.`,
      { transcript: meeting(name, "the budget") }
    );
    const admin = writerOf("admin");
    const input = {
      type: "content" as const,
      documentIds: [call.id],
      terms: [name],
      reason: "erasure_request" as const,
    };
    const plan = await preparePurge(brain, admin, input, noCopies);
    const result = await purge(brain, admin, input, plan.token, noCopies);
    const found = await readTranscript(brain, caller, call.id);
    const read = found?.read;
    const { hits } = await search(brain, caller, name);

    expect({
      // The text once, and the transcript three times: two speakers and a
      // chapter title.
      occurrences: plan.occurrences,
      stillFound: result.stillFound,
      version: read?.version,
      speakers: read?.transcript.turns.map(({ speaker }) => speaker),
      chapters: read?.transcript.chapters.map(({ title }) => title),
      words: read?.transcript.turns.map(({ text }) => text),
      stored: await storedHolds(name),
      found: hits.length,
    }).toStrictEqual({
      occurrences: 4,
      stillFound: 0,
      version: 2,
      speakers: ["(removed)", "Grasp", "(removed)"],
      chapters: ["Opening by (removed)", "Invoices"],
      words: [
        "Welcome, the budget first.",
        "What takes longest?",
        "Copying invoices by hand.",
      ],
      stored: false,
      found: 0,
    });
  });

  it("loses a purged term the document's text never held, rewritten where it stands and recorded", async () => {
    const { brain, events } = testHost();
    const notes = await newCollection(brain, "Notes");
    const name = word();
    const caller: Caller = { userId: "reader", reads: [notes.id] };
    const call = await save(brain, notes, "call.md", "# Call\nNo names.", {
      transcript: meeting(name, "the budget"),
    });
    const admin = writerOf("admin");
    const input = {
      type: "content" as const,
      documentIds: [call.id],
      terms: [name],
      reason: "erasure_request" as const,
    };
    const plan = await preparePurge(brain, admin, input, noCopies);
    const result = await purge(brain, admin, input, plan.token, noCopies);
    const found = await readTranscript(brain, caller, call.id);
    const read = found?.read;
    const purged = events.find(({ action }) => action === "knowledge.purged");

    expect({
      plan: { documents: plan.documents, versions: plan.versions },
      result: { documents: result.documents, stillFound: result.stillFound },
      version: read?.version,
      holds: JSON.stringify(read?.transcript).includes(name),
      stored: await storedHolds(name),
      recorded: events
        .filter(({ action }) => action === "knowledge.transcript.purged")
        .map(({ target, detail }) => ({ target, detail })),
    }).toStrictEqual({
      plan: { documents: 1, versions: 0 },
      result: { documents: 1, stillFound: 0 },
      version: 1,
      holds: false,
      stored: false,
      recorded: [
        {
          target: { type: "document", id: call.id },
          detail: { purgeId: purged?.detail?.purgeId, version: 1 },
        },
      ],
    });
  });

  it("never brings back a term one purge took out when another purges the same transcript at once", async () => {
    const { brain } = testHost();
    const notes = await newCollection(brain, "Notes");
    const first = word();
    const second = word();
    const call = await save(brain, notes, "call.md", "# Call\nNo names.", {
      transcript: meeting(first, second),
    });
    const admin = writerOf("admin");
    const purgeOf = async (term: string) => {
      const input = {
        type: "content" as const,
        documentIds: [call.id],
        terms: [term],
        reason: "erasure_request" as const,
      };
      const plan = await preparePurge(brain, admin, input, noCopies);
      return await purge(brain, admin, input, plan.token, noCopies);
    };
    // Both read the transcript before either writes it; the first then
    // finishes before the second writes the copy it read.
    const batch = brain.db.batch.bind(brain.db);
    const bothRead = Promise.withResolvers<null>();
    let firstDone: Promise<unknown> = Promise.resolve(null);
    let writes = 0;
    const spy = vi
      .spyOn(brain.db, "batch")
      .mockImplementation(async (statements) => {
        const writesTranscript = statements.some((statement) =>
          sqlOf(statement).startsWith('update "transcripts"')
        );
        if (writesTranscript) {
          writes += 1;
          if (writes === 1) {
            await bothRead.promise;
          } else {
            bothRead.resolve(null);
            await firstDone;
          }
        }
        return await batch(statements);
      });
    let one: Awaited<ReturnType<typeof purgeOf>>;
    let two: Awaited<ReturnType<typeof purgeOf>>;
    try {
      const running = purgeOf(first);
      firstDone = running;
      [one, two] = await Promise.all([running, purgeOf(second)]);
    } finally {
      spy.mockRestore();
    }
    const afterRace = {
      first: await storedHolds(first),
      second: await storedHolds(second),
    };
    // The one that lost says so, and running it again finishes it.
    const again = await purgeOf(second);
    expect({
      writes,
      stillFound: [one.stillFound, two.stillFound],
      afterRace,
      recorded: await recordedPurges(call.id),
      again: again.stillFound,
      stored: await storedHolds(first, second),
    }).toStrictEqual({
      writes: 2,
      // The first took its term out, and it stays out.
      stillFound: [0, 1],
      afterRace: { first: false, second: true },
      // The second wrote nothing, and recorded nothing; run again, it does.
      recorded: 2,
      again: 0,
      stored: false,
    });
  });

  it("is recorded by counts and documents only: no event holds a speaker or a word", async () => {
    const { brain, events, reads } = testHost();
    const notes = await newCollection(brain, "Notes");
    const name = word();
    const said = word();
    const caller: Caller = { userId: "reader", reads: [notes.id] };
    const call = await save(brain, notes, "call.md", "# Call", {
      transcript: meeting(name, said),
    });
    await listTranscripts(brain, caller);
    await readTranscript(brain, caller, call.id);
    await save(brain, notes, "call.md", "# Call\nEdited.", { ifVersion: 1 });
    const saved = events.find(
      ({ action, target, detail }) =>
        action === "knowledge.document.saved" &&
        target?.id === call.id &&
        detail?.version === 1
    );
    const recorded = JSON.stringify([events, reads]);

    expect({
      saved: saved?.detail,
      holds: [name, said].filter((each) => recorded.includes(each)),
    }).toStrictEqual({
      saved: {
        collectionId: notes.id,
        version: 1,
        transcriptTurns: 3,
        transcriptChapters: 2,
      },
      holds: [],
    });
  });
});
