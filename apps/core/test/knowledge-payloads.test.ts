import { sha256Hex } from "@grasp-os/shared/encoding";
import { knowledgeErrors } from "@grasp-os/shared/knowledge";
import type { CollectionInput, KnowledgeApi } from "@grasp-os/shared/knowledge";
import { env } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vite-plus/test";

import { readableCollection } from "../src/knowledge/collections.ts";
import { writeVersion } from "../src/knowledge/documents.ts";
import { pendingGraceMs } from "../src/knowledge/payloads.ts";
import { personWriter } from "../src/knowledge/person-writes.ts";
import { brainOf } from "../src/knowledge/ports.ts";
import { allEvents } from "./audit-events.ts";
import { runCron } from "./cron.ts";
import { mockIdp } from "./idp.ts";
import { signedInApi, unique, whoami } from "./sign-in.ts";

// Each version's text is an immutable object in the Brain bucket, through
// the API people use: what the bucket holds, what a read checks, and what
// a crash, a lost answer, a race or a purge leaves behind.

const idp = mockIdp();

const knowledgeOf = async () => {
  const person = await signedInApi(idp, "admin");
  const api: KnowledgeApi = person.api.knowledge;
  return { ...person, api };
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

/** The text of a document's version (its current one by default). */
const readText = async (
  api: KnowledgeApi,
  documentId: string,
  version?: number
): Promise<string> => {
  const { version: read } = await api.getDocument(documentId, version);
  return read.text;
};

/** The IDs of a collection's documents. */
const documentIdsIn = async (
  api: KnowledgeApi,
  collectionId: string
): Promise<string[]> => {
  const { documents } = await api.listDocuments(collectionId);
  return documents.map(({ id }) => id);
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

/** The text of the object `key`, or undefined when there's none. */
const storedText = async (key: string): Promise<string | undefined> => {
  const object = await env.BRAIN_OBJECTS.get(key);
  return await object?.text();
};

/** Whether any object in the bucket holds `word`. */
const bucketHolds = async (word: string): Promise<boolean> => {
  const listed = await env.BRAIN_OBJECTS.list();
  const texts = await Promise.all(
    listed.objects.map(async ({ key }) => (await storedText(key)) ?? "")
  );
  return texts.some((text) => text.includes(word));
};

/** The code a promise was refused with. */
const codeOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return knowledgeErrors.codeOf(error);
  }
  throw new Error("Expected a refusal");
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

const insertsReleases = /^insert into "brain_payload_releases"/iu;

/**
 * Runs `before` once, just before the next batch that lets payloads go (a
 * purge's): another writer that gets in between. Returns what restores it.
 */
const beforeReleasingBatch = (before: () => Promise<void>): (() => void) => {
  const db = env.KNOWLEDGE;
  const realPrepare = db.prepare.bind(db);
  const realBatch = db.batch.bind(db);
  let releasing = false;
  let done = false;
  const prepare = vi.spyOn(db, "prepare").mockImplementation((query) => {
    releasing ||= insertsReleases.test(query);
    return realPrepare(query);
  });
  const batch = vi.spyOn(db, "batch").mockImplementation(async (statements) => {
    if (releasing && !done) {
      done = true;
      prepare.mockRestore();
      await before();
    }
    return await realBatch(statements);
  });
  return () => {
    prepare.mockRestore();
    batch.mockRestore();
  };
};

/** The cron trigger, once a staged payload's grace is over. */
const afterGrace = async (): Promise<void> => {
  await runCron({}, new Date(Date.now() + pendingGraceMs + 60_000));
};

const purgeTerm = async (
  api: KnowledgeApi,
  documentId: string,
  term: string
): Promise<void> => {
  const input = {
    type: "content" as const,
    documentIds: [documentId],
    terms: [term],
    reason: "offboarding" as const,
  };
  const { token } = await api.preparePurge(input);
  await api.purge(input, token);
};

describe("storing versions' texts", () => {
  it("keeps each version's exact text in R2, under its hash, and lists without reading any", async () => {
    const { api } = await knowledgeOf();
    const { id: collectionId } = await api.createCollection(shared());
    const v1 = textOf(`First${unique()}`);
    const v2 = textOf(`Second${unique()}`);
    const saved = await api.saveDocument({
      collectionId,
      path: "policy.md",
      text: v1,
      ifVersion: 0,
    });
    await api.saveDocument({
      collectionId,
      path: "policy.md",
      text: v2,
      ifVersion: 1,
    });

    const reads = vi.spyOn(env.BRAIN_OBJECTS, "get");
    let listingReads: number;
    try {
      await api.listDocuments(collectionId);
      await api.history(saved.id);
      listingReads = reads.mock.calls.length;
    } finally {
      reads.mockRestore();
    }
    const { versions } = await api.history(saved.id);
    const { version: earlier } = await api.getDocument(saved.id, 1);
    const { version: current } = await api.getDocument(saved.id);
    const [row] = await rowsOf(v1);

    expect({
      listingReads,
      history: versions.map(({ number, sha256 }) => ({ number, sha256 })),
      earlier: [earlier.text, earlier.sha256],
      current: [current.text, current.sha256],
      row: row?.state,
      stored: await storedText(row?.key ?? ""),
    }).toStrictEqual({
      listingReads: 0,
      history: [
        { number: 2, sha256: await sha256Hex(v2) },
        { number: 1, sha256: await sha256Hex(v1) },
      ],
      earlier: [v1, await sha256Hex(v1)],
      current: [v2, await sha256Hex(v2)],
      row: "committed",
      stored: v1,
    });
  });

  it("stores identical texts once, however many documents and versions hold them", async () => {
    const { api } = await knowledgeOf();
    const { id: collectionId } = await api.createCollection(shared());
    const text = textOf(`Same${unique()}`);
    const one = await api.saveDocument({
      collectionId,
      path: "one.md",
      text,
      ifVersion: 0,
    });
    await api.saveDocument({
      collectionId,
      path: "two.md",
      text,
      ifVersion: 0,
    });
    await api.restoreVersion({ documentId: one.id, version: 1, ifVersion: 1 });

    expect({
      rows: await statesOf(text),
      objects: await objectCount(text),
      restored: await readText(api, one.id),
    }).toStrictEqual({ rows: ["committed"], objects: 1, restored: text });
  });

  it("never shares a payload across collections, so a save can't tell what exists where its writer can't read", async () => {
    const { api } = await knowledgeOf();
    const first = await api.createCollection(shared());
    const second = await api.createCollection(shared());
    const text = textOf(`Elsewhere${unique()}`);
    for (const { id: collectionId } of [first, second]) {
      // oxlint-disable-next-line no-await-in-loop -- one collection at a time
      await api.saveDocument({
        collectionId,
        path: "same.md",
        text,
        ifVersion: 0,
      });
    }

    expect({
      rows: await statesOf(text),
      objects: await objectCount(text),
    }).toStrictEqual({ rows: ["committed", "committed"], objects: 2 });
  });

  it("uploads nothing for a save its last check refuses", async () => {
    const person = await knowledgeOf();
    const { id: collectionId } = await person.api.createCollection(shared());
    const text = textOf(`Refused${unique()}`);
    const identity = await whoami(person.session);
    const collection = await readableCollection(
      drizzle(env.KNOWLEDGE),
      sql`1 = 1`,
      collectionId
    );
    const outcome = await settled(
      writeVersion(brainOf(env), personWriter(identity), {
        collection,
        path: "refused.md",
        text,
        ifVersion: 0,
        message: null,
        restoredFrom: null,
        lastCheck: async () => {
          await Promise.reject(new Error("context restricted"));
        },
      })
    );

    expect({
      outcome,
      rows: await rowsOf(text),
      objects: await objectCount(text),
    }).toStrictEqual({ outcome: "refused", rows: [], objects: 0 });
  });

  it("refuses a version whose object is missing or isn't its text, and serves nothing of it", async () => {
    const { api } = await knowledgeOf();
    const { id: collectionId } = await api.createCollection(shared());
    const tampered = textOf(`Tampered${unique()}`);
    const missing = textOf(`Missing${unique()}`);
    const first = await api.saveDocument({
      collectionId,
      path: "tampered.md",
      text: tampered,
      ifVersion: 0,
    });
    const second = await api.saveDocument({
      collectionId,
      path: "missing.md",
      text: missing,
      ifVersion: 0,
    });
    const [tamperedRow] = await rowsOf(tampered);
    const [missingRow] = await rowsOf(missing);
    await env.BRAIN_OBJECTS.put(tamperedRow?.key ?? "", "# Policy\nSwapped.");
    await env.BRAIN_OBJECTS.delete(missingRow?.key ?? "");
    const { versions } = await api.history(first.id);

    expect({
      tampered: await codeOf(api.getDocument(first.id)),
      missing: await codeOf(api.getDocument(second.id)),
      restore: await codeOf(
        api.restoreVersion({ documentId: first.id, version: 1, ifVersion: 1 })
      ),
      history: versions.length,
    }).toStrictEqual({
      tampered: "knowledge.unavailable",
      missing: "knowledge.unavailable",
      restore: "knowledge.unavailable",
      history: 1,
    });
  });
});

describe("crashes and races", () => {
  it("saves nothing when the upload fails, and collects what it staged", async () => {
    const { api } = await knowledgeOf();
    const { id: collectionId } = await api.createCollection(shared());
    const text = textOf(`Upload${unique()}`);
    const down = vi
      .spyOn(env.BRAIN_OBJECTS, "put")
      .mockRejectedValue(new Error("R2 unavailable"));
    let outcome: string;
    try {
      outcome = await settled(
        api.saveDocument({
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
    const listed = await documentIdsIn(api, collectionId);
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
    const { api } = await knowledgeOf();
    const { id: collectionId } = await api.createCollection(shared());
    const kept = textOf(`Kept${unique()}`);
    const lost = textOf(`Lost${unique()}`);
    await api.saveDocument({
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
        api.saveDocument({
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
    await runCron();
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

  it("publishes a save whose answer was lost exactly once, and a retry finds it saved", async () => {
    const { api } = await knowledgeOf();
    const { id: collectionId } = await api.createCollection(shared());
    const text = textOf(`Lost answer${unique()}`);
    const restore = aroundVersionBatch({
      after: () => {
        throw new Error("Network connection lost");
      },
    });
    let outcome: string;
    try {
      outcome = await settled(
        api.saveDocument({
          collectionId,
          path: "policy.md",
          text,
          ifVersion: 0,
        })
      );
    } finally {
      restore();
    }
    const retry = await codeOf(
      api.saveDocument({ collectionId, path: "policy.md", text, ifVersion: 0 })
    );
    const [documentId = ""] = await documentIdsIn(api, collectionId);
    await afterGrace();

    expect({
      outcome,
      retry,
      read: await readText(api, documentId),
      rows: await statesOf(text),
      objects: await objectCount(text),
    }).toStrictEqual({
      outcome: "refused",
      retry: "knowledge.conflict",
      read: text,
      rows: ["committed"],
      objects: 1,
    });
  });

  it("commits one payload when two saves upload the same new text at once", async () => {
    const { api } = await knowledgeOf();
    const { id: collectionId } = await api.createCollection(shared());
    const text = textOf(`Race${unique()}`);
    // The other save uploads its own object, after this one staged, and
    // commits first.
    const restore = aroundVersionBatch({
      before: async () => {
        restore();
        await api.saveDocument({
          collectionId,
          path: "other.md",
          text,
          ifVersion: 0,
        });
      },
    });
    let version: number;
    try {
      const saved = await api.saveDocument({
        collectionId,
        path: "this.md",
        text,
        ifVersion: 0,
      });
      version = saved.currentVersion;
    } finally {
      restore();
    }
    const raced = await statesOf(text);
    await afterGrace();
    const ids = await documentIdsIn(api, collectionId);
    const reads = await Promise.all(
      ids.map(async (id) => await readText(api, id))
    );

    expect({
      version,
      raced: raced.toSorted(),
      reads,
      rows: await statesOf(text),
      objects: await objectCount(text),
    }).toStrictEqual({
      version: 1,
      raced: ["committed", "pending"],
      reads: [text, text],
      rows: ["committed"],
      objects: 1,
    });
  });

  it("stores the text again when its payload is collected between staging and the batch", async () => {
    const { api } = await knowledgeOf();
    const { id: collectionId } = await api.createCollection(shared());
    const text = textOf(`Collected${unique()}`);
    const first = await api.saveDocument({
      collectionId,
      path: "first.md",
      text,
      ifVersion: 0,
    });
    const [original] = await rowsOf(text);
    // A purge of the first document lets go of its payload meanwhile.
    const restore = aroundVersionBatch({
      before: async () => {
        await purgeTerm(api, first.id, "Policy");
      },
    });
    let documentId: string;
    try {
      const saved = await api.saveDocument({
        collectionId,
        path: "second.md",
        text,
        ifVersion: 0,
      });
      documentId = saved.id;
    } finally {
      restore();
    }
    const rows = await rowsOf(text);

    expect({
      read: await readText(api, documentId),
      rows: rows.map(({ key, state }) => ({
        original: key === original?.key,
        state,
      })),
    }).toStrictEqual({
      read: text,
      rows: [{ original: false, state: "committed" }],
    });
  });

  it("finishes collecting after a delete that failed part way", async () => {
    const { api } = await knowledgeOf();
    const { id: collectionId } = await api.createCollection(shared());
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
        api.saveDocument({
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
    await runCron();

    expect({
      stuck,
      after: [await rowsOf(text), await objectCount(text)],
    }).toStrictEqual({ stuck: [["collecting"], 1], after: [[], 0] });
  });
});

describe("purges", () => {
  it("leaves no object holding a purged term, once no version holds it", async () => {
    const { api } = await knowledgeOf();
    const { id: collectionId } = await api.createCollection(shared());
    const name = `Visser${unique()}`;
    const withName = textOf(`${name} signs`);
    const other = textOf(`Kept${unique()}`);
    const document = await api.saveDocument({
      collectionId,
      path: "policy.md",
      text: withName,
      ifVersion: 0,
    });
    await api.saveDocument({
      collectionId,
      path: "policy.md",
      text: other,
      ifVersion: 1,
    });
    // Another document holds the same text, until it's purged too.
    const copy = await api.saveDocument({
      collectionId,
      path: "copy.md",
      text: withName,
      ifVersion: 0,
    });
    await purgeTerm(api, document.id, name);
    const heldByCopy = await bucketHolds(name);
    await purgeTerm(api, copy.id, name);

    expect({
      heldByCopy,
      afterBoth: await bucketHolds(name),
      earlier: await readText(api, document.id, 1),
      other: await readText(api, document.id, 2),
    }).toStrictEqual({
      heldByCopy: true,
      afterBoth: false,
      earlier: textOf("(removed) signs"),
      other,
    });
  });

  it("fails a purge whose objects R2 won't delete, and a run again deletes them", async () => {
    const { api } = await knowledgeOf();
    const { id: collectionId } = await api.createCollection(shared());
    const name = `Jansen${unique()}`;
    const document = await api.saveDocument({
      collectionId,
      path: "policy.md",
      text: textOf(`${name} signs`),
      ifVersion: 0,
    });
    const down = vi
      .spyOn(env.BRAIN_OBJECTS, "delete")
      .mockRejectedValue(new Error("R2 unavailable"));
    let first: string;
    try {
      first = await settled(purgeTerm(api, document.id, name));
    } finally {
      down.mockRestore();
    }
    const heldAfterFailure = await bucketHolds(name);
    await purgeTerm(api, document.id, name);

    expect({
      first,
      heldAfterFailure,
      heldAfterAgain: await bucketHolds(name),
    }).toStrictEqual({
      first: "refused",
      heldAfterFailure: true,
      heldAfterAgain: false,
    });
  });

  it("replaces a version whose object is missing or altered by its tombstone, and audits it", async () => {
    const { api } = await knowledgeOf();
    const { id: collectionId } = await api.createCollection(shared());
    const name = `Smit${unique()}`;
    const document = await api.saveDocument({
      collectionId,
      path: "policy.md",
      text: textOf(`${name} one`),
      ifVersion: 0,
    });
    await api.saveDocument({
      collectionId,
      path: "policy.md",
      text: textOf(`${name} two`),
      ifVersion: 1,
    });
    await api.saveDocument({
      collectionId,
      path: "policy.md",
      text: textOf(`${name} three`),
      ifVersion: 2,
    });
    const [missing] = await rowsOf(textOf(`${name} one`));
    const [altered] = await rowsOf(textOf(`${name} two`));
    await env.BRAIN_OBJECTS.delete(missing?.key ?? "");
    await env.BRAIN_OBJECTS.put(altered?.key ?? "", textOf(`${name} swapped`));
    await purgeTerm(api, document.id, name);
    const events = await allEvents();

    expect({
      first: await readText(api, document.id, 1),
      second: await readText(api, document.id, 2),
      third: await readText(api, document.id, 3),
      held: await bucketHolds(name),
      replaced: events
        .filter(
          ({ action, target }) =>
            action === "knowledge.payload.replaced" &&
            target?.id === document.id
        )
        .map(({ detail }) => detail)
        .toSorted(
          (one, other) => Number(one?.version) - Number(other?.version)
        ),
    }).toStrictEqual({
      first: "(removed)",
      second: "(removed)",
      third: textOf("(removed) three"),
      held: false,
      replaced: [
        { version: 1, reason: "unreadable" },
        { version: 2, reason: "unreadable" },
      ],
    });
  });

  it("never reuses an object that's gone or altered, a purge's tombstone neither", async () => {
    const { api } = await knowledgeOf();
    const { id: collectionId } = await api.createCollection(shared());
    const text = textOf(`Reused${unique()}`);
    const first = await api.saveDocument({
      collectionId,
      path: "first.md",
      text,
      ifVersion: 0,
    });
    const [original] = await rowsOf(text);
    await env.BRAIN_OBJECTS.delete(original?.key ?? "");
    const second = await api.saveDocument({
      collectionId,
      path: "second.md",
      text,
      ifVersion: 0,
    });
    // Two documents whose objects go missing are purged one after the
    // other: the first's tombstone, altered meanwhile, isn't the second's.
    const one = `Bos${unique()}`;
    const two = `Kok${unique()}`;
    const purgedFirst = await api.saveDocument({
      collectionId,
      path: "purged-1.md",
      text: textOf(one),
      ifVersion: 0,
    });
    const purgedSecond = await api.saveDocument({
      collectionId,
      path: "purged-2.md",
      text: textOf(two),
      ifVersion: 0,
    });
    for (const word of [one, two]) {
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      const [row] = await rowsOf(textOf(word));
      // oxlint-disable-next-line no-await-in-loop -- one at a time
      await env.BRAIN_OBJECTS.delete(row?.key ?? "");
    }
    await purgeTerm(api, purgedFirst.id, one);
    const [tombstone] = await rowsOf("(removed)");
    await env.BRAIN_OBJECTS.put(tombstone?.key ?? "", "# Swapped");
    await purgeTerm(api, purgedSecond.id, two);

    expect({
      first: await codeOf(api.getDocument(first.id)),
      second: await readText(api, second.id),
      rows: await statesOf(text),
      purgedSecond: await readText(api, purgedSecond.id, 1),
    }).toStrictEqual({
      first: "knowledge.unavailable",
      second: text,
      rows: ["broken", "committed"],
      purgedSecond: "(removed)",
    });
  });

  it("stores a purge's rewritten text again when the payload it reused is collected before its batch", async () => {
    const { api } = await knowledgeOf();
    const { id: collectionId } = await api.createCollection(shared());
    const one = `Peters${unique()}`;
    const two = `Smits${unique()}`;
    const document = await api.saveDocument({
      collectionId,
      path: "policy.md",
      text: textOf(`${one} and ${two}`),
      ifVersion: 0,
    });
    await api.saveDocument({
      collectionId,
      path: "policy.md",
      text: textOf(`Kept${unique()}`),
      ifVersion: 1,
    });
    // Another document holds what version 1 becomes once `one` is purged,
    // so the purge reuses its payload; it is purged itself meanwhile.
    const other = await api.saveDocument({
      collectionId,
      path: "other.md",
      text: textOf(`(removed) and ${two}`),
      ifVersion: 0,
    });
    const restore = beforeReleasingBatch(async () => {
      await purgeTerm(api, other.id, two);
    });
    let outcome: string;
    try {
      outcome = await settled(purgeTerm(api, document.id, one));
    } finally {
      restore();
    }

    expect({
      outcome,
      first: await readText(api, document.id, 1),
    }).toStrictEqual({
      outcome: "fulfilled",
      first: textOf(`(removed) and ${two}`),
    });
  });
});
