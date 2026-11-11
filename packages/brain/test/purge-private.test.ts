import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import type { CollectionRow } from "../src/collections.ts";
import { writeVersion } from "../src/documents.ts";
import { preparePurge, purge } from "../src/purge.ts";
import type { OnErase } from "../src/purge.ts";
import { newCollection, noCopies, testHost, writerOf } from "./host.ts";

// A content purge never reaches a document in someone else's own
// collection (access `me`), also where checking it when prepared isn't
// enough: run with a token prepared while the document could be named, or
// begun and run again. No product path turns a collection private today,
// so these tests turn one private underneath, in the database, as the
// Brain would see a change made between two calls; the purge must then
// answer as it does for a document that doesn't exist, and change nothing.

/** What `promise` refused with: its code and details, or "ok". */
const refusalOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (typeof error !== "object" || error === null) {
      return error;
    }
    return {
      code: "code" in error ? error.code : undefined,
      details: "details" in error ? error.details : undefined,
    };
  }
};

/** Makes `collection` one only `owner` reads, as it stands in the database. */
const turnPrivate = async (collection: CollectionRow, owner: string) => {
  await env.BRAIN.prepare(
    "UPDATE collections SET access = 'me', owner = ? WHERE id = ?"
  )
    .bind(owner, collection.id)
    .run();
};

/** How many versions `documentId` has, and how many purges are recorded. */
const stateOf = async (documentId: string) => {
  const versions = await env.BRAIN.prepare(
    "SELECT count(*) AS n FROM versions WHERE document_id = ?"
  )
    .bind(documentId)
    .first<{ n: number }>();
  const purges = await env.BRAIN.prepare(
    "SELECT count(*) AS n FROM brain_purges"
  ).first<{ n: number }>();
  return { versions: versions?.n, purges: purges?.n };
};

/** A word no other test's text has. */
const word = () => `w${crypto.randomUUID().replaceAll("-", "")}`;

describe("a content purge of a document that turned private", () => {
  it("is refused when run, as for a document that doesn't exist, and changes nothing", async () => {
    const { brain } = testHost();
    const notes = await newCollection(brain, "Notes");
    const secret = word();
    const note = await writeVersion(brain, writerOf("owner"), {
      collection: notes,
      path: "note.md",
      text: `# Note\n${secret}`,
      ifVersion: 0,
      message: null,
      restoredFrom: null,
    });
    const admin = writerOf("admin");
    const input = {
      type: "content" as const,
      documentIds: [note.id],
      terms: [secret],
      reason: "erasure_request" as const,
    };
    const { token } = await preparePurge(brain, admin, input, noCopies);
    await turnPrivate(notes, "owner");
    const before = await stateOf(note.id);
    const missing = crypto.randomUUID();

    expect({
      run: await refusalOf(purge(brain, admin, input, token, noCopies)),
      after: await stateOf(note.id),
      missing: await refusalOf(
        preparePurge(
          brain,
          admin,
          { ...input, documentIds: [missing] },
          noCopies
        )
      ),
    }).toStrictEqual({
      run: { code: "knowledge.not_found", details: { documentIds: [note.id] } },
      after: before,
      missing: {
        code: "knowledge.not_found",
        details: { documentIds: [missing] },
      },
    });
  });

  it("is refused when its admin prepares it again unfinished, not left out as if it were gone", async () => {
    const { brain } = testHost();
    const notes = await newCollection(brain, "Notes");
    const secret = word();
    const note = await writeVersion(brain, writerOf("owner"), {
      collection: notes,
      path: "note.md",
      text: `# Note\n${secret}`,
      ifVersion: 0,
      message: null,
      restoredFrom: null,
    });
    const admin = writerOf("admin");
    const input = {
      type: "content" as const,
      documentIds: [note.id],
      terms: [secret],
      reason: "erasure_request" as const,
    };
    // Its host's copies fail once: the purge is begun and left unfinished.
    let failOnce = true;
    const failing: OnErase = {
      ...noCopies,
      rewrite: async () => {
        await Promise.resolve();
        if (failOnce) {
          failOnce = false;
          throw new Error("The host is unavailable");
        }
      },
    };
    const { token } = await preparePurge(brain, admin, input, failing);
    const left = await refusalOf(purge(brain, admin, input, token, failing));
    await turnPrivate(notes, "owner");

    expect({
      left: left === "ok" ? "ok" : "failed",
      again: await refusalOf(preparePurge(brain, admin, input, noCopies)),
    }).toStrictEqual({
      left: "failed",
      again: {
        code: "knowledge.not_found",
        details: { documentIds: [note.id] },
      },
    });
  });
});
