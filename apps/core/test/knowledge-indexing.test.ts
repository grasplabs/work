import type {
  CollectionInput,
  DocumentSummary,
  KnowledgeApi,
} from "@grasp-os/shared/knowledge";
import { knowledgeErrors } from "@grasp-os/shared/knowledge";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { indexRunId, maxIndexReruns } from "../src/knowledge/indexing.ts";
import { runEngine } from "../src/workflows/engine.ts";
import { allEvents } from "./audit-events.ts";
import { runCron } from "./cron.ts";
import { mockIdp } from "./idp.ts";
import { newTeam } from "./knowledge.ts";
import { signedInApi, unique } from "./sign-in.ts";

// Search holds one generation of each document, published after the save
// that made it current: inline when it can, by the indexing workflow when
// it can't. Through the API people use, and the engine that runs it.

const idp = mockIdp();

const knowledgeOf = async (role: "admin" | "user" = "admin") => {
  const person = await signedInApi(idp, role);
  const api: KnowledgeApi = person.api.knowledge;
  return { ...person, api };
};

const shared = (): CollectionInput => ({
  name: `Handbook ${unique()}`,
  access: "everyone",
});

/** A document whose one section holds `word`. */
const textOf = (word: string): string => `# Policy\n${word} applies.`;

/** The code a promise was refused with. */
const codeOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return knowledgeErrors.codeOf(error);
  }
  throw new Error("Expected a refusal");
};

const deletesSections = /^delete from "sections"/iu;

/**
 * Watches the batches that publish sections: each one (`publishing`) is
 * failed while `fail` says so, as an outage would, or runs `before` first:
 * another writer that gets in between. Returns what restores the database.
 */
const watchPublishes = (hooks: {
  fail?: (nth: number) => boolean;
  before?: (nth: number) => Promise<void>;
}): (() => void) => {
  const db = env.KNOWLEDGE;
  const realPrepare = db.prepare.bind(db);
  const realBatch = db.batch.bind(db);
  let publishing = false;
  let seen = 0;
  const prepare = vi.spyOn(db, "prepare").mockImplementation((query) => {
    publishing ||= deletesSections.test(query);
    return realPrepare(query);
  });
  const batch = vi.spyOn(db, "batch").mockImplementation(async (statements) => {
    if (!publishing) {
      return await realBatch(statements);
    }
    publishing = false;
    seen += 1;
    const nth = seen;
    await hooks.before?.(nth);
    if (hooks.fail?.(nth) === true) {
      throw new Error("D1 DB is overloaded");
    }
    return await realBatch(statements);
  });
  return () => {
    prepare.mockRestore();
    batch.mockRestore();
  };
};

/** Fails the next batch that publishes sections: the save before it committed. */
const failNextPublish = (): (() => void) =>
  watchPublishes({ fail: (nth) => nth === 1 });

/** Runs `run` with the engine out of reach: no run can start. */
const withEngineDown = async <T>(run: () => Promise<T>): Promise<T> => {
  const real = env.WORKFLOW_RUNS;
  const down = new Proxy(real, {
    get: () => () => {
      throw new Error("engine unreachable");
    },
  });
  Object.assign(env, { WORKFLOW_RUNS: down });
  try {
    return await run();
  } finally {
    Object.assign(env, { WORKFLOW_RUNS: real });
  }
};

/** Runs `run` with every step's retry due at once. */
const withRetriesAtOnce = async <T>(run: () => Promise<T>): Promise<T> => {
  env.WORKFLOW_RETRY_DELAY_MS = "0";
  try {
    return await run();
  } finally {
    Reflect.deleteProperty(env, "WORKFLOW_RETRY_DELAY_MS");
  }
};

/** The document `documentId` as its collection lists it. */
const listed = async (
  api: KnowledgeApi,
  collectionId: string,
  documentId: string
): Promise<DocumentSummary | undefined> => {
  const { documents } = await api.listDocuments(collectionId);
  return documents.find(({ id }) => id === documentId);
};

/** Once `documentId` is indexed (or failed), as its collection lists it. */
const settledIndexing = async (
  api: KnowledgeApi,
  collectionId: string,
  documentId: string
): Promise<DocumentSummary | undefined> =>
  await vi.waitFor(
    async () => {
      const found = await listed(api, collectionId, documentId);
      if (found?.indexing !== "indexed" && found?.indexing !== "failed") {
        throw new Error(`Still ${found?.indexing}`);
      }
      return found;
    },
    { timeout: 20_000, interval: 100 }
  );

/** The versions of the sections a search for `word` finds, in `scope`. */
const foundVersions = async (
  api: KnowledgeApi,
  word: string,
  collectionId: string
): Promise<number[]> => {
  const { hits } = await api.search(word, { collectionId });
  return hits.map(({ version }) => version);
};

/** A content purge of `term` from `documentId`. */
const purgeOf = (documentId: string, term: string) => ({
  type: "content" as const,
  documentIds: [documentId],
  terms: [term],
  reason: "offboarding" as const,
});

/** The current text of `documentId`. */
const readTextOf = async (
  api: KnowledgeApi,
  documentId: string
): Promise<string> => {
  const { version } = await api.getDocument(documentId);
  return version.text;
};

const indexingOf = (document: DocumentSummary | undefined) => ({
  indexing: document?.indexing,
  indexedVersion: document?.indexedVersion,
});

describe("publishing search generations", () => {
  it("publishes a save's sections before it returns, and says so", async () => {
    const { api } = await knowledgeOf();
    const { id: collectionId } = await api.createCollection(shared());
    const word = `Inline${unique()}`;
    const saved = await api.saveDocument({
      collectionId,
      path: "policy.md",
      text: textOf(word),
      ifVersion: 0,
    });
    const { coverage } = await api.search(word, { collectionId });

    expect({
      saved: indexingOf(saved),
      found: await foundVersions(api, word, collectionId),
      coverage,
    }).toStrictEqual({
      saved: { indexing: "indexed", indexedVersion: 1 },
      found: [1],
      coverage: { pending: 0, failed: 0 },
    });
  });

  it("keeps serving the last whole generation while a save waits for indexing, then the workflow publishes it", async () => {
    const { api } = await knowledgeOf();
    const { id: collectionId } = await api.createCollection(shared());
    const old = `Old${unique()}`;
    const fresh = `Fresh${unique()}`;
    const first = await api.saveDocument({
      collectionId,
      path: "policy.md",
      text: textOf(old),
      ifVersion: 0,
    });
    const restore = failNextPublish();
    let saved: DocumentSummary;
    try {
      // The engine is out of reach too: nothing indexes it yet.
      saved = await withEngineDown(
        async () =>
          await api.saveDocument({
            collectionId,
            path: "policy.md",
            text: textOf(fresh),
            ifVersion: 1,
          })
      );
    } finally {
      restore();
    }
    const { coverage } = await api.search(old, { collectionId });
    const during = {
      old: await foundVersions(api, old, collectionId),
      fresh: await foundVersions(api, fresh, collectionId),
      coverage,
    };
    await runCron({}, new Date(Date.now() + 5 * 60_000));
    const indexed = await settledIndexing(api, collectionId, first.id);

    expect({
      saved: indexingOf(saved),
      current: saved.currentVersion,
      during,
      indexed: indexingOf(indexed),
      old: await foundVersions(api, old, collectionId),
      fresh: await foundVersions(api, fresh, collectionId),
    }).toStrictEqual({
      saved: { indexing: "queued", indexedVersion: 1 },
      current: 2,
      during: {
        old: [1],
        fresh: [],
        coverage: { pending: 1, failed: 0 },
      },
      indexed: { indexing: "indexed", indexedVersion: 2 },
      old: [],
      fresh: [2],
    });
  });

  it("never lets a late generation replace a newer one", async () => {
    const { api } = await knowledgeOf();
    const { id: collectionId } = await api.createCollection(shared());
    const old = `Late${unique()}`;
    const fresh = `Newer${unique()}`;
    const first = await api.saveDocument({
      collectionId,
      path: "policy.md",
      text: textOf(old),
      ifVersion: 0,
    });
    await api.saveDocument({
      collectionId,
      path: "policy.md",
      text: textOf(fresh),
      ifVersion: 1,
    });
    // Version 1's indexing, arriving after version 2 is published.
    const late = `${indexRunId(first.id, 1, 0)}-late`;
    await runEngine(env).createInternal({
      id: late,
      workflow: "indexing",
      input: { documentId: first.id, version: 1 },
    });
    await vi.waitFor(
      async () => {
        const run = await runEngine(env).status(late);
        if (run?.status !== "complete") {
          throw new Error(`Run is ${run?.status}`);
        }
      },
      { timeout: 20_000, interval: 100 }
    );

    expect({
      indexed: indexingOf(await listed(api, collectionId, first.id)),
      old: await foundVersions(api, old, collectionId),
      fresh: await foundVersions(api, fresh, collectionId),
    }).toStrictEqual({
      indexed: { indexing: "indexed", indexedVersion: 2 },
      old: [],
      fresh: [2],
    });
  });

  it("indexes a document with no sections as indexed, and empties what search held of it", async () => {
    const { api } = await knowledgeOf();
    const { id: collectionId } = await api.createCollection(shared());
    const word = `Emptied${unique()}`;
    const first = await api.saveDocument({
      collectionId,
      path: "policy.md",
      text: textOf(word),
      ifVersion: 0,
    });
    const emptied = await api.saveDocument({
      collectionId,
      path: "policy.md",
      text: "",
      ifVersion: first.currentVersion,
    });

    expect({
      emptied: indexingOf(emptied),
      found: await foundVersions(api, word, collectionId),
    }).toStrictEqual({
      emptied: { indexing: "indexed", indexedVersion: 2 },
      found: [],
    });
  });

  it("fails a document for good once its retries are spent, and declares it in search's coverage", async () => {
    const { api } = await knowledgeOf();
    const { id: collectionId } = await api.createCollection(shared());
    const old = `Kept${unique()}`;
    const broken = `Broken${unique()}`;
    const first = await api.saveDocument({
      collectionId,
      path: "policy.md",
      text: textOf(old),
      ifVersion: 0,
    });
    // The new version's payload can't be read: every attempt fails.
    const get = vi.spyOn(env.BRAIN_OBJECTS, "get").mockResolvedValue(null);
    const restore = failNextPublish();
    let failed: DocumentSummary | undefined;
    try {
      failed = await withRetriesAtOnce(async () => {
        await api.saveDocument({
          collectionId,
          path: "policy.md",
          text: textOf(broken),
          ifVersion: 1,
        });
        return await settledIndexing(api, collectionId, first.id);
      });
    } finally {
      restore();
      get.mockRestore();
    }
    const { coverage } = await api.search(old, { collectionId });

    expect({
      failed: indexingOf(failed),
      old: await foundVersions(api, old, collectionId),
      coverage,
    }).toStrictEqual({
      failed: { indexing: "failed", indexedVersion: 1 },
      old: [1],
      coverage: { pending: 0, failed: 1 },
    });
  });

  it("starts the indexing the cron trigger finds never started", async () => {
    const { api } = await knowledgeOf();
    const { id: collectionId } = await api.createCollection(shared());
    const word = `Repaired${unique()}`;
    const restore = failNextPublish();
    let saved: DocumentSummary;
    try {
      saved = await withEngineDown(
        async () =>
          await api.saveDocument({
            collectionId,
            path: "policy.md",
            text: textOf(word),
            ifVersion: 0,
          })
      );
    } finally {
      restore();
    }
    // Within a while of the save, its run may still be on its way.
    await runCron();
    const soon = indexingOf(await listed(api, collectionId, saved.id));
    await runCron({}, new Date(Date.now() + 5 * 60_000));
    const indexed = await settledIndexing(api, collectionId, saved.id);

    expect({
      saved: indexingOf(saved),
      soon,
      indexed: indexingOf(indexed),
      found: await foundVersions(api, word, collectionId),
    }).toStrictEqual({
      saved: { indexing: "queued", indexedVersion: null },
      soon: { indexing: "queued", indexedVersion: null },
      indexed: { indexing: "indexed", indexedVersion: 1 },
      found: [1],
    });
  });

  it("counts and finds only what the reader may read, however far indexing is behind", async () => {
    const { api: admin } = await knowledgeOf("admin");
    const { api: user } = await knowledgeOf("user");
    const word = `Private${unique()}`;
    const { id: collectionId } = await admin.createCollection({
      name: `Mine ${unique()}`,
      access: "me",
    });
    const { coverage: before } = await user.search(word);
    // Version 1 is indexed; version 2 waits.
    await admin.saveDocument({
      collectionId,
      path: "policy.md",
      text: textOf(word),
      ifVersion: 0,
    });
    const restore = failNextPublish();
    try {
      await withEngineDown(
        async () =>
          await admin.saveDocument({
            collectionId,
            path: "policy.md",
            text: textOf(`${word} again`),
            ifVersion: 1,
          })
      );
    } finally {
      restore();
    }
    const asUser = await user.search(word);
    const asAdmin = await admin.search(word, { collectionId });

    expect({
      user: asUser.hits.length,
      userCoverage: asUser.coverage,
      userScoped: await codeOf(user.search(word, { collectionId })),
      admin: asAdmin.hits.map(({ version }) => version),
      adminCoverage: asAdmin.coverage,
    }).toStrictEqual({
      user: 0,
      userCoverage: before,
      userScoped: "knowledge.not_found",
      admin: [1],
      adminCoverage: { pending: 1, failed: 0 },
    });
  });

  it("counts a sensitive collection's waiting documents only in a search of that collection", async () => {
    const admin = await knowledgeOf("admin");
    const teamId = await newTeam(admin, [admin]);
    const word = `Sensitive${unique()}`;
    const { id: collectionId } = await admin.api.createCollection({
      name: `Payroll ${unique()}`,
      access: "teams",
      teams: [teamId],
      sensitive: true,
    });
    const { coverage: before } = await admin.api.search(word);
    const restore = failNextPublish();
    try {
      await withEngineDown(
        async () =>
          await admin.api.saveDocument({
            collectionId,
            path: "salaries.md",
            text: textOf(word),
            ifVersion: 0,
          })
      );
    } finally {
      restore();
    }
    const unscoped = await admin.api.search(word);
    const scoped = await admin.api.search(word, { collectionId });

    expect({
      unscoped: unscoped.coverage,
      unscopedRestricted: unscoped.provenance.restricted,
      scoped: scoped.coverage,
      scopedSensitive: scoped.provenance.sensitive,
    }).toStrictEqual({
      unscoped: before,
      unscopedRestricted: false,
      scoped: { pending: 1, failed: 0 },
      scopedSensitive: true,
    });
  });

  it("refuses a purge whose sections can't be published as pending, and the index catches up even when its run fails too", async () => {
    const { api } = await knowledgeOf();
    const { id: collectionId } = await api.createCollection(shared());
    const name = `Bakker${unique()}`;
    const document = await api.saveDocument({
      collectionId,
      path: "policy.md",
      text: textOf(`${name} signs`),
      ifVersion: 0,
    });
    const { token } = await api.preparePurge(purgeOf(document.id, name));
    // Every publish fails: the purge's own, and each of its run's tries.
    const restore = watchPublishes({ fail: () => true });
    let refused: unknown;
    let failed: DocumentSummary | undefined;
    try {
      failed = await withRetriesAtOnce(async () => {
        refused = await codeOf(api.purge(purgeOf(document.id, name), token));
        return await settledIndexing(api, collectionId, document.id);
      });
    } finally {
      restore();
    }
    const whileFailed = await foundVersions(api, name, collectionId);
    // Nobody purges again: the cron trigger starts its run again.
    await runCron({}, new Date(Date.now() + 20 * 60_000));
    const indexed = await settledIndexing(api, collectionId, document.id);

    expect({
      refused,
      failed: failed?.indexing,
      whileFailed,
      indexed: indexingOf(indexed),
      after: await foundVersions(api, name, collectionId),
    }).toStrictEqual({
      refused: "knowledge.purge_index_pending",
      failed: "failed",
      whileFailed: [1],
      indexed: { indexing: "indexed", indexedVersion: 2 },
      after: [],
    });
  });

  it("publishes what a save made current during a purge, so no generation with the terms stays live", async () => {
    const { api } = await knowledgeOf();
    const { id: collectionId } = await api.createCollection(shared());
    const name = `Visser${unique()}`;
    const document = await api.saveDocument({
      collectionId,
      path: "policy.md",
      text: textOf(`${name} signs`),
      ifVersion: 0,
    });
    const clean = textOf(`Clean${unique()}`);
    const { token } = await api.preparePurge(purgeOf(document.id, name));
    // Just before the purge publishes, someone saves over it, and that
    // save's own publish fails, with no engine to index it.
    const restore = watchPublishes({
      before: async (nth) => {
        if (nth !== 1) {
          return;
        }
        await withEngineDown(
          async () =>
            await api.saveDocument({
              collectionId,
              path: "policy.md",
              text: clean,
              ifVersion: 2,
            })
        );
      },
      fail: (nth) => nth === 2,
    });
    let outcome: string;
    try {
      outcome = await api.purge(purgeOf(document.id, name), token).then(
        () => "purged",
        (error: unknown) => String(knowledgeErrors.codeOf(error))
      );
    } finally {
      restore();
    }

    expect({
      outcome,
      indexed: indexingOf(await listed(api, collectionId, document.id)),
      term: await foundVersions(api, name, collectionId),
      clean: await readTextOf(api, document.id),
    }).toStrictEqual({
      outcome: "purged",
      indexed: { indexing: "indexed", indexedVersion: 3 },
      term: [],
      clean,
    });
  });

  it("starts a fresh run at once when a purge is run again after its indexing failed", async () => {
    const { api } = await knowledgeOf();
    const { id: collectionId } = await api.createCollection(shared());
    const name = `Jong${unique()}`;
    const document = await api.saveDocument({
      collectionId,
      path: "policy.md",
      text: textOf(`${name} signs`),
      ifVersion: 0,
    });
    const first = await api.preparePurge(purgeOf(document.id, name));
    const down = watchPublishes({ fail: () => true });
    let failed: DocumentSummary | undefined;
    try {
      failed = await withRetriesAtOnce(async () => {
        await codeOf(api.purge(purgeOf(document.id, name), first.token));
        return await settledIndexing(api, collectionId, document.id);
      });
    } finally {
      down();
    }
    // Run again, and its own publish fails once more: no waiting on the
    // cron trigger's backoff for the next run.
    const again = await api.preparePurge(purgeOf(document.id, name));
    const once = failNextPublish();
    let refused: unknown;
    try {
      refused = await codeOf(
        api.purge(purgeOf(document.id, name), again.token)
      );
    } finally {
      once();
    }
    const indexed = await settledIndexing(api, collectionId, document.id);

    expect({
      failed: failed?.indexing,
      refused,
      indexed: indexed?.indexing,
      found: await foundVersions(api, name, collectionId),
    }).toStrictEqual({
      failed: "failed",
      refused: "knowledge.purge_index_pending",
      indexed: "indexed",
      found: [],
    });
  });

  it("keeps rerunning a document a purge waits on past the cap, and gives up on others, audited", async () => {
    const { api } = await knowledgeOf();
    const { id: collectionId } = await api.createCollection(shared());
    const name = `Mulder${unique()}`;
    const purged = await api.saveDocument({
      collectionId,
      path: "purged.md",
      text: textOf(`${name} signs`),
      ifVersion: 0,
    });
    const other = await api.saveDocument({
      collectionId,
      path: "other.md",
      text: textOf(`Plain${unique()}`),
      ifVersion: 0,
    });
    const { token } = await api.preparePurge(purgeOf(purged.id, name));
    const down = watchPublishes({ fail: () => true });
    try {
      await withRetriesAtOnce(async () => {
        await codeOf(api.purge(purgeOf(purged.id, name), token));
        await api.saveDocument({
          collectionId,
          path: "other.md",
          text: textOf(`Changed${unique()}`),
          ifVersion: 1,
        });
        await settledIndexing(api, collectionId, purged.id);
        await settledIndexing(api, collectionId, other.id);
      });
    } finally {
      down();
    }
    // Both have used up their reruns, a day ago.
    await env.KNOWLEDGE.prepare(
      "UPDATE documents SET index_run = ?, index_failed_at = ? WHERE id IN (?, ?)"
    )
      .bind(maxIndexReruns, Date.now(), purged.id, other.id)
      .run();
    await runCron({}, new Date(Date.now() + 25 * 60 * 60_000));
    const rerun = await settledIndexing(api, collectionId, purged.id);
    const left = await listed(api, collectionId, other.id);
    const events = await allEvents();
    const actions = (documentId: string) =>
      events
        .filter(({ target }) => target?.id === documentId)
        .map(({ action }) => action)
        .filter(
          (action) =>
            action.startsWith("knowledge.index") ||
            action.startsWith("knowledge.purge.")
        );

    expect({
      rerun: rerun?.indexing,
      other: left?.indexing,
      found: await foundVersions(api, name, collectionId),
      purgedEvents: actions(purged.id),
      otherEvents: actions(other.id),
    }).toStrictEqual({
      rerun: "indexed",
      other: "failed",
      found: [],
      purgedEvents: ["knowledge.purge.index_pending"],
      otherEvents: ["knowledge.index_exhausted"],
    });
  });
});
