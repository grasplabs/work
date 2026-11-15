import type {
  CollectionInput,
  DocumentSummary,
  KnowledgeApi,
} from "@grasp-os/shared/knowledge";
import { knowledgeErrors } from "@grasp-os/shared/knowledge";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

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

/** The document `documentId` as its collection lists it. */
const listed = async (
  api: KnowledgeApi,
  collectionId: string,
  documentId: string
): Promise<DocumentSummary | undefined> => {
  const { documents } = await api.listDocuments(collectionId);
  return documents.find(({ id }) => id === documentId);
};

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
});
