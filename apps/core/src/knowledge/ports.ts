import { createBrain } from "@grasp-os/brain/brain";
import type { Brain, BrainPorts } from "@grasp-os/brain/brain";
import { brainErrors } from "@grasp-os/brain/contract";
import { permissionErrors } from "@grasp-os/shared/permissions";

import { brainEventOf, drainKnowledgeOutboxSoon } from "../audit-outbox.ts";
import { derivedHmacKey } from "../derived-keys.ts";
import { audiencesOf, noteProvenance, readerActor } from "./access.ts";
import type { Reader } from "./access.ts";
import { authorize } from "./app-entries.ts";
import {
  keepRecalledMemories,
  readableByEveryoneOf,
  recallMemoryAudience,
} from "./memory-audience.ts";
import { mayPublish, mayReplaceMatch, mayRetire } from "./memory-publish.ts";
import { recallKey, requireRecall } from "./recall-grants.ts";
import { rerankCandidates } from "./rerank.ts";
import { skillAuthorities, skillCapabilities } from "./skill-capabilities.ts";
import { checkWrite } from "./write-rules.ts";

// Core's side of the Brain's ports (brain.ts): what each port is in core.
// Core does no background work for today's Brain any more: no indexing
// or linking run starts, no lesson is worded and no entity extracted
// (nothing calls the last two). A version a save couldn't publish to
// search at once stays queued; a purge publishes what it needs itself.

/** What core says to a port of background work it no longer does. */
const noBackgroundWork = (): never => {
  throw new Error("Core does no background work for today's Brain");
};

/** Core's ports for the Brain, over `env`. */
export const portsOf = (env: Env): BrainPorts<Reader> => ({
  authorize: async (reader) => await authorize(env, reader),
  onRead: async (reader, record, ...sources) =>
    await noteProvenance(env, reader, record, ...sources),
  actorOf: readerActor,
  skills: {
    capabilities: async (reader) => await skillCapabilities(env, reader),
    authorityOf: async (skillCollections) =>
      await skillAuthorities(env, skillCollections),
  },
  audiences: async (reader) => await audiencesOf(env, reader),
  ownerOf: (reader) => {
    if (reader.type !== "person") {
      throw brainErrors.create("brain.denied");
    }
    return reader.person.userId;
  },
  mayPublish: async (reader, target, refs) => {
    await mayPublish(env, reader, target, refs);
  },
  mayRetire: async (reader, record) => {
    await mayRetire(reader, record);
  },
  mayReplaceMatch: async (reader, decision) => {
    await mayReplaceMatch(reader, decision);
  },
  wordLesson: noBackgroundWork,
  memories: {
    audienceOf: async (reader) => await recallMemoryAudience(env, reader),
    readableBy: async (_reader, people) =>
      await readableByEveryoneOf(env, people),
    keep: async (reader, people, records) =>
      await keepRecalledMemories(env, reader, people, records),
  },
  recall: {
    require: async (reader) => {
      await requireRecall(env, reader);
    },
    key: async (reader) => await recallKey(env, reader),
    isRefusal: (error) => permissionErrors.codeOf(error) !== undefined,
  },
  onWrite: checkWrite,
  blobs: env.BRAIN_OBJECTS,
  audit: {
    eventOf: brainEventOf,
    drain: () => {
      drainKnowledgeOutboxSoon(env);
    },
  },
  keys: {
    hmac: async (purpose, usages) => await derivedHmacKey(env, purpose, usages),
  },
  extractEntities: noBackgroundWork,
  rerank: async (reader, request) =>
    await rerankCandidates(env, reader, request),
  jobs: {
    start: async () => {
      // Nothing runs it.
    },
    status: async () => {
      // Nothing ran it.
    },
  },
  clock: () => new Date(),
});

/** The Brain for a request of core's, over `env`. */
export const brainOf = (env: Env): Brain<Reader> =>
  createBrain(env.KNOWLEDGE, portsOf(env));
