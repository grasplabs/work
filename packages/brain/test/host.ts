import { env } from "cloudflare:workers";

import type { ReadRecord } from "../src/authorize.ts";
import { createBrain } from "../src/brain.ts";
import type { Brain, BrainPorts } from "../src/brain.ts";
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
}

/** The Brain over the test database, and what its ports were told. */
export const testHost = (): {
  brain: Brain<Caller>;
  reads: { caller: string; record: ReadRecord }[];
  events: BrainEvent[];
} => {
  const reads: { caller: string; record: ReadRecord }[] = [];
  const events: BrainEvent[] = [];
  const ports: BrainPorts<Caller> = {
    authorize: async (caller) =>
      await Promise.resolve({ collections: caller.reads }),
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
    jobs: {
      start: async () => {
        await Promise.resolve();
      },
      status: async () => {
        await Promise.resolve();
      },
    },
    clock: () => new Date(),
  };
  return { brain: createBrain(env.BRAIN, ports), reads, events };
};

/** A person writing as themselves. */
export const writerOf = (userId: string): Writer => ({
  actor: { type: "person", userId },
  userId,
});

/** A new collection, read by whoever the host's callers say. */
export const newCollection = async (
  brain: Brain<Caller>,
  name: string
): Promise<CollectionRow> =>
  await ensureCollection(
    brain,
    {
      id: crypto.randomUUID(),
      name,
      description: "",
      owner: "owner",
      access: "everyone",
      sensitive: false,
      source: "here",
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
