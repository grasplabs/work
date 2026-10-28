import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { brainErrors } from "../src/contract.ts";
import {
  backlinks,
  documentCitesMax,
  getDocument,
  history,
  listDocuments,
  writeVersion,
} from "../src/documents.ts";
import type { DocumentCite } from "../src/documents.ts";
import { knowledgeErrors } from "../src/knowledge.ts";
import { preparePurge, purge } from "../src/purge.ts";
import { d1BrainStore } from "../src/recall-store.ts";
import { recall } from "../src/recall.ts";
import { search } from "../src/search.ts";
import { read } from "../src/tools.ts";
import type { Caller } from "./host.ts";
import { newCollection, noCopies, testHost, writerOf } from "./host.ts";

// A document version written from what its writer read rests on it
// (`brain_document_cites`, GRA-1093): the derived copy never shows more
// than its sources' audience. Tried below, on every read path: a reader
// who may read the copy's collection but not a collection it cites; a
// cited document erased; a person's rewrite, which rests on nothing; a
// restore of the cited version, which rests on it again; a cited version
// purged, before or after the copy is saved; and too many cites.

/** The code of what `promise` refused with, or "ok". */
const outcome = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return (
      knowledgeErrors.codeOf(error) ??
      brainErrors.codeOf(error) ??
      String(error)
    );
  }
};

/** A word no other test's text has. */
const word = () => `w${crypto.randomUUID().replaceAll("-", "")}`;

describe("a document version resting on what its writer read", () => {
  it("shows the copy on no read path to a reader who may not read all it rests on, nor to anyone once what it cites is gone", async () => {
    const { brain } = testHost();
    const source = await newCollection(brain, "Plans");
    const notes = await newCollection(brain, "Notes");
    const writer = writerOf("agent");
    const term = word();
    const plan = await writeVersion(brain, writer, {
      collection: source,
      path: "plan.md",
      text: `# Plan\nThe route is secret.`,
      ifVersion: 0,
      message: null,
      restoredFrom: null,
    });
    // The copy, written from the plan, linking to another note.
    const copy = await writeVersion(brain, writer, {
      collection: notes,
      path: "copy.md",
      text: `# Copy ${term}\nThe route, as read. See [[target.md]].`,
      ifVersion: 0,
      message: null,
      restoredFrom: null,
      cites: [{ collectionId: source.id, documentId: plan.id }],
    });
    const target = await writeVersion(brain, writer, {
      collection: notes,
      path: "target.md",
      text: `# Target\nLinked to.`,
      ifVersion: 0,
      message: null,
      restoredFrom: null,
    });
    /** What `caller` sees of the copy, on each read path. */
    const seen = async (caller: Caller) => {
      const listed = await listDocuments(brain, caller, notes.id);
      const { hits } = await search(brain, caller, term);
      const pack = await recall(brain, caller, { query: term });
      const linked = await backlinks(brain, caller, target.id);
      return {
        listed: listed.documents.some(({ id }) => id === copy.id),
        get: await outcome(getDocument(brain, caller, copy.id)),
        read: await outcome(read(brain, caller, copy.id)),
        history: await outcome(history(brain, caller, copy.id)),
        search: hits.some(({ documentId }) => documentId === copy.id),
        recall: pack.items.some(({ sourceRefs }) =>
          sourceRefs.some(
            (ref) => ref.kind === "document" && ref.documentId === copy.id
          )
        ),
        backlinks: linked.backlinks.some(
          ({ documentId }) => documentId === copy.id
        ),
      };
    };
    const visible = {
      listed: true,
      get: "ok",
      read: "ok",
      history: "ok",
      search: true,
      recall: true,
      backlinks: true,
    };
    const hidden = {
      listed: false,
      get: "knowledge.not_found",
      read: "knowledge.not_found",
      history: "knowledge.not_found",
      search: false,
      recall: false,
      backlinks: false,
    };
    const both: Caller = { userId: "both", reads: [source.id, notes.id] };
    const notesOnly: Caller = { userId: "notes", reads: [notes.id] };

    const before = { both: await seen(both), notesOnly: await seen(notesOnly) };
    // The plan erased from the Brain, its collection still read.
    await env.BRAIN.prepare("DELETE FROM documents WHERE id = ?")
      .bind(plan.id)
      .run();
    const erased = await seen(both);

    expect({ before, erased }).toStrictEqual({
      before: { both: visible, notesOnly: hidden },
      erased: hidden,
    });
  });

  it("rests a person's rewrite on nothing, hides the cited version in history, and rests a restore of it on what it cited again", async () => {
    const { brain } = testHost();
    const source = await newCollection(brain, "Plans");
    const notes = await newCollection(brain, "Notes");
    const writer = writerOf("agent");
    const copy = await writeVersion(brain, writer, {
      collection: notes,
      path: "copy.md",
      text: `# Copy\nThe route, as read.`,
      ifVersion: 0,
      message: null,
      restoredFrom: null,
      cites: [{ collectionId: source.id }],
    });
    const notesOnly: Caller = { userId: "notes", reads: [notes.id] };
    const hiddenFirst = await outcome(getDocument(brain, notesOnly, copy.id));
    // Its person rewrites it: a save of their own cites nothing.
    await writeVersion(brain, writerOf("person"), {
      collection: notes,
      path: "copy.md",
      text: `# Copy\nIn my own words.`,
      ifVersion: 1,
      message: null,
      restoredFrom: null,
    });
    const rewritten = await outcome(getDocument(brain, notesOnly, copy.id));
    const versions = await history(brain, notesOnly, copy.id);
    const oldVersion = await outcome(getDocument(brain, notesOnly, copy.id, 1));
    // Restored to the version written from the plans: hidden again.
    await writeVersion(brain, writerOf("person"), {
      collection: notes,
      path: "copy.md",
      text: `# Copy\nThe route, as read.`,
      ifVersion: 2,
      message: null,
      restoredFrom: 1,
    });
    const restored = await outcome(getDocument(brain, notesOnly, copy.id));

    expect({
      hiddenFirst,
      rewritten,
      versions: versions.versions.map(({ number }) => number),
      oldVersion,
      restored,
    }).toStrictEqual({
      hiddenFirst: "knowledge.not_found",
      rewritten: "ok",
      // Only the person's own version: the copy's is theirs to see no more.
      versions: [2],
      oldVersion: "knowledge.not_found",
      restored: "knowledge.not_found",
    });
  });

  it("hides a copy once a version it cites is purged, and refuses a copy of a version purged since it was read", async () => {
    const { brain } = testHost();
    const source = await newCollection(brain, "Plans");
    const notes = await newCollection(brain, "Notes");
    const writer = writerOf("agent");
    const name = word();
    const plan = await writeVersion(brain, writer, {
      collection: source,
      path: "plan.md",
      text: `# Plan\nAsk ${name} for the route.`,
      ifVersion: 0,
      message: null,
      restoredFrom: null,
    });
    const both: Caller = { userId: "both", reads: [source.id, notes.id] };
    // Pinned as a chat or run that read it pins it (recall-store.ts).
    const [pin] = await d1BrainStore(brain).pinsOf(both, [
      { documentId: plan.id, collectionId: source.id, version: 1 },
    ]);
    if (pin === undefined) {
      throw new Error("The plan wasn't pinned");
    }
    const cite: DocumentCite = {
      collectionId: source.id,
      documentId: plan.id,
      version: pin.version,
      pin: pin.text,
    };
    /** A copy of the plan as read, saved at `path`. */
    const copied = async (path: string) =>
      await writeVersion(brain, writer, {
        collection: notes,
        path,
        text: `# Copy\nThe route, as read.`,
        ifVersion: 0,
        message: null,
        restoredFrom: null,
        cites: [cite],
      });
    const copy = await copied("copy.md");
    const before = await outcome(getDocument(brain, both, copy.id));
    const input = {
      type: "content",
      documentIds: [plan.id],
      terms: [name],
      reason: "erasure_request",
    };
    const { token } = await preparePurge(brain, writer, input, noCopies);
    await purge(brain, writer, input, token, noCopies);

    expect({
      before,
      // The plan still there, in its collection: only its text purged.
      plan: await outcome(getDocument(brain, both, plan.id)),
      afterPurge: await outcome(getDocument(brain, both, copy.id)),
      lateCopy: await outcome(copied("late.md")),
    }).toStrictEqual({
      before: "ok",
      plan: "ok",
      afterPurge: "knowledge.not_found",
      lateCopy: "brain.revoked",
    });
  });

  it("refuses a version resting on more than a version keeps", async () => {
    const { brain } = testHost();
    const notes = await newCollection(brain, "Notes");
    const cites: DocumentCite[] = Array.from(
      { length: documentCitesMax + 1 },
      () => ({ collectionId: crypto.randomUUID() })
    );

    await expect(
      outcome(
        writeVersion(brain, writerOf("agent"), {
          collection: notes,
          path: "copy.md",
          text: `# Copy\nToo much.`,
          ifVersion: 0,
          message: null,
          restoredFrom: null,
          cites,
        })
      )
    ).resolves.toBe("brain.budget_exceeded");
  });
});
