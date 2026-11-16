import { pendingGraceMs } from "@grasp-os/brain/payloads";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import { seed } from "./knowledge.ts";
import type { CollectionInput } from "./knowledge.ts";
import { runMinuteTasks } from "./maintenance.ts";
import { signedInApi, unique } from "./sign-in.ts";

// Each version's text is an immutable object in the Brain bucket: what a
// crash, a lost answer or a race leaves behind, and what the clock's
// cleanup (`knowledge.payloads`) collects.

const idp = mockIdp();

const knowledgeOf = async () => {
  const person = await signedInApi(idp, "admin");
  return { ...person, seeded: seed(person.api) };
};

const shared = (): CollectionInput => ({
  name: `Handbook ${unique()}`,
  access: "everyone",
});

/** A document's text, unique to the test. */
const textOf = (word: string): string => `# Policy\n${word} applies.`;

interface PayloadRow {
  key: string;
  sha256: string;
  state: string;
}

/** The payload rows of a text, by its hash. */
const rowsOf = async (text: string): Promise<PayloadRow[]> => {
  const { results } = await env.KNOWLEDGE.prepare(
    "SELECT key, sha256, state FROM brain_payloads WHERE sha256 = ? ORDER BY created_at"
  )
    .bind(await sha256Hex(text))
    .all<PayloadRow>();
  return results;
};

/** The states of a text's payload rows, oldest first. */
const statesOf = async (text: string): Promise<string[]> => {
  const rows = await rowsOf(text);
  return rows.map(({ state }) => state);
};

/** The IDs of a collection's documents. */
const documentIdsIn = async (collectionId: string): Promise<string[]> => {
  const { results } = await env.KNOWLEDGE.prepare(
    "SELECT id FROM documents WHERE collection_id = ?"
  )
    .bind(collectionId)
    .all<{ id: string }>();
  return results.map(({ id }) => id);
};

/** The keys of the objects stored for a text's hash. */
const objectsOf = async (text: string): Promise<string[]> => {
  const listed = await env.BRAIN_OBJECTS.list({
    prefix: `payloads/${await sha256Hex(text)}/`,
  });
  return listed.objects.map(({ key }) => key);
};

/** How many objects are stored for a text's hash. */
const objectCount = async (text: string): Promise<number> => {
  const keys = await objectsOf(text);
  return keys.length;
};

/** Whether a promise was fulfilled or refused, whatever with. */
const settled = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "fulfilled";
  } catch {
    return "refused";
  }
};

const insertsVersion = /^insert into "versions"/iu;

/**
 * Runs `before` once, just before the next batch that writes a version,
 * then sends that batch: another writer, or a sweep, that gets in between.
 * `after` runs once it's sent, and may throw in its place: the answer lost.
 */
const aroundVersionBatch = (hooks: {
  before?: () => Promise<void>;
  after?: () => void;
}): (() => void) => {
  const db = env.KNOWLEDGE;
  const realPrepare = db.prepare.bind(db);
  const realBatch = db.batch.bind(db);
  let writing = false;
  let done = false;
  const prepare = vi.spyOn(db, "prepare").mockImplementation((query) => {
    writing ||= insertsVersion.test(query);
    return realPrepare(query);
  });
  const batch = vi.spyOn(db, "batch").mockImplementation(async (statements) => {
    if (!writing || done) {
      return await realBatch(statements);
    }
    done = true;
    prepare.mockRestore();
    await hooks.before?.();
    const results = await realBatch(statements);
    hooks.after?.();
    return results;
  });
  return () => {
    prepare.mockRestore();
    batch.mockRestore();
  };
};

/** The clock, once a staged payload's grace is over. */
const afterGrace = async (): Promise<void> => {
  await runMinuteTasks({}, new Date(Date.now() + pendingGraceMs + 60_000));
};

describe("crashes and races", () => {
  it("saves nothing when the upload fails, and collects what it staged", async () => {
    const { seeded } = await knowledgeOf();
    const { id: collectionId } = await seeded.createCollection(shared());
    const text = textOf(`Upload${unique()}`);
    const down = vi
      .spyOn(env.BRAIN_OBJECTS, "put")
      .mockRejectedValue(new Error("R2 unavailable"));
    let outcome: string;
    try {
      outcome = await settled(
        seeded.saveDocument({
          collectionId,
          path: "policy.md",
          text,
          ifVersion: 0,
        })
      );
    } finally {
      down.mockRestore();
    }
    const staged = await statesOf(text);
    const listed = await documentIdsIn(collectionId);
    await afterGrace();

    expect({
      outcome,
      staged,
      listed,
      afterSweep: await rowsOf(text),
    }).toStrictEqual({
      outcome: "refused",
      staged: ["pending"],
      listed: [],
      afterSweep: [],
    });
  });

  it("collects an object uploaded by a save that crashed before its batch, and keeps a referenced one", async () => {
    const { seeded } = await knowledgeOf();
    const { id: collectionId } = await seeded.createCollection(shared());
    const kept = textOf(`Kept${unique()}`);
    const lost = textOf(`Lost${unique()}`);
    await seeded.saveDocument({
      collectionId,
      path: "kept.md",
      text: kept,
      ifVersion: 0,
    });
    const restore = aroundVersionBatch({
      before: async () => {
        await Promise.reject(new Error("isolate gone"));
      },
    });
    let outcome: string;
    try {
      outcome = await settled(
        seeded.saveDocument({
          collectionId,
          path: "lost.md",
          text: lost,
          ifVersion: 0,
        })
      );
    } finally {
      restore();
    }
    const beforeGrace = await objectCount(lost);
    // Within its grace, a staged payload's save may still be on its way.
    await runMinuteTasks();
    const withinGrace = await objectCount(lost);
    await afterGrace();

    expect({
      outcome,
      beforeGrace,
      withinGrace,
      lost: [await rowsOf(lost), await objectCount(lost)],
      kept: [await statesOf(kept), await objectCount(kept)],
    }).toStrictEqual({
      outcome: "refused",
      beforeGrace: 1,
      withinGrace: 1,
      lost: [[], 0],
      kept: [["committed"], 1],
    });
  });

  it("finishes collecting after a delete that failed part way", async () => {
    const { seeded } = await knowledgeOf();
    const { id: collectionId } = await seeded.createCollection(shared());
    const text = textOf(`Interrupted${unique()}`);
    // The object is stored, but the answer saying so is lost.
    const realPut = env.BRAIN_OBJECTS.put.bind(env.BRAIN_OBJECTS);
    const lostPut = vi
      .spyOn(env.BRAIN_OBJECTS, "put")
      .mockImplementationOnce(async (key, value, options) => {
        await realPut(key, value, options);
        throw new Error("Network connection lost");
      });
    const down = vi
      .spyOn(env.BRAIN_OBJECTS, "delete")
      .mockRejectedValue(new Error("R2 unavailable"));
    try {
      await settled(
        seeded.saveDocument({
          collectionId,
          path: "policy.md",
          text,
          ifVersion: 0,
        })
      );
      await afterGrace();
    } finally {
      down.mockRestore();
      lostPut.mockRestore();
    }
    const stuck = [await statesOf(text), await objectCount(text)];
    await runMinuteTasks();

    expect({
      stuck,
      after: [await rowsOf(text), await objectCount(text)],
    }).toStrictEqual({ stuck: [["collecting"], 1], after: [[], 0] });
  });
});
