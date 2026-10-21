import type {
  CollectionInput,
  DocumentSummary,
  KnowledgeApi,
} from "@grasp-os/shared/knowledge";
import { knowledgeErrors } from "@grasp-os/shared/knowledge";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import { indexRunId } from "../src/knowledge/indexing.ts";
import { runEngine } from "../src/workflows/engine.ts";
import { runCron } from "./cron.ts";
import { mockIdp } from "./idp.ts";
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
 * Fails the next batch that publishes sections, as an outage would: the
 * save before it has committed. Returns what restores it.
 */
const failNextPublish = (): (() => void) => {
  const db = env.KNOWLEDGE;
  const realPrepare = db.prepare.bind(db);
  const realBatch = db.batch.bind(db);
  let publishing = false;
  let failed = false;
  const prepare = vi.spyOn(db, "prepare").mockImplementation((query) => {
    publishing ||= deletesSections.test(query);
    return realPrepare(query);
  });
  const batch = vi.spyOn(db, "batch").mockImplementation(async (statements) => {
    if (publishing && !failed) {
      failed = true;
      throw new Error("D1 DB is overloaded");
    }
    return await realBatch(statements);
  });
  return () => {
    prepare.mockRestore();
    batch.mockRestore();
  };
};

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
    const late = `${indexRunId(first.id, 1)}-late`;
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

  it("refuses a purge whose sections can't be published, so erasure never waits on indexing", async () => {
    const { api } = await knowledgeOf();
    const { id: collectionId } = await api.createCollection(shared());
    const name = `Bakker${unique()}`;
    const document = await api.saveDocument({
      collectionId,
      path: "policy.md",
      text: textOf(`${name} signs`),
      ifVersion: 0,
    });
    const input = {
      type: "content" as const,
      documentIds: [document.id],
      terms: [name],
      reason: "offboarding" as const,
    };
    const { token } = await api.preparePurge(input);
    const restore = failNextPublish();
    let refused: unknown;
    try {
      refused = await api.purge(input, token).then(
        () => "purged",
        () => "refused"
      );
    } finally {
      restore();
    }
    const again = await api.preparePurge(input);
    await api.purge(input, again.token);

    expect({
      refused,
      found: await foundVersions(api, name, collectionId),
    }).toStrictEqual({ refused: "refused", found: [] });
  });
});
