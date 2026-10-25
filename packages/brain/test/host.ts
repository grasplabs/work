import { env } from "cloudflare:workers";

import type { ReadRecord } from "../src/authorize.ts";
import { createBrain } from "../src/brain.ts";
import type {
  Brain,
  BrainPorts,
  IndexJob,
  LinkJob,
  SkillAuthority,
} from "../src/brain.ts";
import { ensureCollection } from "../src/collections.ts";
import type { CollectionRow } from "../src/collections.ts";
import type { Writer } from "../src/documents.ts";
import type { BrainEvent } from "../src/events.ts";
import { collectionIdSchema } from "../src/ids.ts";
import type { OnErase } from "../src/purge.ts";

// A host for the Brain, as small as one can be: callers are a person and
// the collections they may read, and every port records what it was
// told, so a test sees what the Brain asked of its host.

/** Who calls, as this host makes callers: opaque to the Brain. */
export interface Caller {
  userId: string;
  reads: readonly string[];
  /** The audiences the host counts them in now. */
  audiences?: readonly string[];
  /** Of those collections, only these paths (`Readable.only`). */
  only?: Readonly<Record<string, readonly string[]>>;
  /** The capabilities the host says they hold. */
  capabilities?: readonly string[];
}

/** A job the Brain asked its host to start. */
export interface StartedJob {
  id: string;
  job: IndexJob | LinkJob;
}

/**
 * The Brain over the test database, and what its ports were told. The
 * host's model gateway is `extract`: the only outside provider, which a
 * test stands in for (none by default: a call fails).
 */
export const testHost = (
  extract: (text: string) => Promise<unknown> = async () => {
    await Promise.resolve();
    throw new Error("No model in this test");
  }
): {
  brain: Brain<Caller>;
  reads: { caller: string; record: ReadRecord }[];
  events: BrainEvent[];
  started: StartedJob[];
} => {
  const reads: { caller: string; record: ReadRecord }[] = [];
  const events: BrainEvent[] = [];
  const started: StartedJob[] = [];
  const ports: BrainPorts<Caller> = {
    authorize: async (caller) =>
      await Promise.resolve({
        collections: caller.reads,
        ...(caller.only === undefined ? {} : { only: caller.only }),
      }),
    onRead: async (caller, record, ...sources) => {
      reads.push({ caller: caller.userId, record });
      return await Promise.resolve({
        collectionIds: [...new Set(sources.map(({ id }) => id))].map((id) =>
          collectionIdSchema.parse(id)
        ),
        sensitive: sources.some(({ sensitive }) => sensitive),
        restricted: false,
      });
    },
    onWrite: async () => {
      await Promise.resolve();
    },
    recall: {
      require: async () => {
        await Promise.resolve();
      },
      key: async (caller) => await Promise.resolve(caller.userId),
      isRefusal: () => false,
    },
    actorOf: (caller) => ({ type: "person", userId: caller.userId }),
    skills: {
      capabilities: async (caller) =>
        await Promise.resolve(caller.capabilities ?? []),
      // This host's vouching: a collection made with `source: "grasp"` is
      // shipped; one for everyone or admins is written by admins alone;
      // a team's or a person's is written by its members.
      authorityOf: async (skillCollections) =>
        await Promise.resolve(
          Object.fromEntries(
            skillCollections.flatMap(
              ({ id, access, source }): [string, SkillAuthority][] => {
                if (source === "grasp") {
                  return [[id, "shipped"]];
                }
                return access === "everyone" || access === "admins"
                  ? [[id, "admins"]]
                  : [];
              }
            )
          )
        ),
    },
    ownerOf: (caller) => caller.userId,
    mayPublish: async () => {
      await Promise.resolve();
    },
    mayRetire: async () => {
      await Promise.resolve();
    },
    memories: {
      // A caller's own records, read by them alone.
      audienceOf: async (caller) =>
        await Promise.resolve({
          audience: {
            owners: [caller.userId],
            teams: [],
            company: false,
            sessions: [],
          },
          people: [caller.userId],
        }),
      // What the caller reads, as the collections everyone reading may.
      readableBy: async (caller) => await Promise.resolve([...caller.reads]),
      keep: async (caller, _people, records) =>
        await Promise.resolve(
          records.map((record) => ({
            ...record,
            by: record.ownerId === caller.userId ? null : record.ownerId,
            cites: [],
          }))
        ),
    },
    audiences: async (caller) => await Promise.resolve(caller.audiences ?? []),
    blobs: env.BLOBS,
    audit: {
      eventOf: (entry) => {
        events.push(entry);
        const id = crypto.randomUUID();
        return { id, event: JSON.stringify({ ...entry, id }) };
      },
      drain: () => {
        // The outbox stays as it is: the tests read it.
      },
    },
    keys: {
      hmac: async (purpose, usages) =>
        await crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode(`test key for ${purpose}`),
          { name: "HMAC", hash: "SHA-256" },
          false,
          usages
        ),
    },
    extractEntities: extract,
    jobs: {
      start: async (id, job) => {
        await Promise.resolve();
        if (!started.some((known) => known.id === id)) {
          started.push({ id, job });
        }
      },
      // A job this host started has ended: the test ran it, or never will.
      status: async (id) => {
        await Promise.resolve();
        return started.some((known) => known.id === id) ? "ended" : undefined;
      },
    },
    clock: () => new Date(),
  };
  return { brain: createBrain(env.BRAIN, ports), reads, events, started };
};

/** A person writing as themselves. */
export const writerOf = (userId: string): Writer => ({
  actor: { type: "person", userId },
  userId,
});

/** A new collection, read by whoever the host's callers say: one for everyone unless `kind` says otherwise. */
export const newCollection = async (
  brain: Brain<Caller>,
  name: string,
  kind: "everyone" | "team" | "shipped" = "everyone"
): Promise<CollectionRow> =>
  await ensureCollection(
    brain,
    {
      id: crypto.randomUUID(),
      name,
      description: "",
      owner: "owner",
      access: kind === "team" ? "teams" : "everyone",
      sensitive: false,
      source: kind === "shipped" ? "grasp" : "here",
      createdAt: new Date(),
    },
    { type: "person", userId: "owner" }
  );

/** A host's copies of nothing: a purge reaches only the Brain's own. */
export const noCopies: OnErase = {
  count: async () => await Promise.resolve(0),
  rewrite: async () => {
    await Promise.resolve();
  },
  forgetActor: async () => {
    await Promise.resolve();
  },
  forgetDocuments: async () => {
    await Promise.resolve();
  },
  countFiles: async () => await Promise.resolve(0),
  forgetFiles: async () => {
    await Promise.resolve();
  },
  personalCollection: async (userId) =>
    await Promise.resolve(`personal-${userId}`),
  requireRewritable: async () => {
    await Promise.resolve();
  },
};
