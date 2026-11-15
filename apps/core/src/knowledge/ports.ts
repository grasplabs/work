import { createBrain } from "@grasp-os/brain/brain";
import type { Brain, BrainPorts } from "@grasp-os/brain/brain";
import { brainErrors } from "@grasp-os/brain/contract";

import { brainEventOf, drainKnowledgeOutboxSoon } from "../audit-outbox.ts";
import { derivedHmacKey } from "../derived-keys.ts";
import { readerActor } from "./access.ts";
import type { Reader } from "./access.ts";
import { checkWrite } from "./write-rules.ts";

// Core's side of the Brain's ports (brain.ts): what each port is in core.
// Core does no background work for today's Brain any more, and reads
// nothing of it (GRA-1938): every port only a read uses refuses, so no
// route reads Knowledge through core. What still runs on these ports
// until the cutover deletes Knowledge: a person's erasure (the personal
// purge), a deleted chat's captured outcomes (`eraseCaptured`) and the
// clock's cleanups of payloads and exports.

/** What core says to a port of background work it no longer does. */
const noBackgroundWork = (): never => {
  throw new Error("Core does no background work for today's Brain");
};

/** What core says to a port only a read of today's Brain uses. */
const noReads = (): never => {
  throw new Error("Core reads nothing of today's Brain");
};

/** Core's ports for the Brain, over `env`. */
export const portsOf = (env: Env): BrainPorts<Reader> => ({
  authorize: noReads,
  onRead: noReads,
  actorOf: readerActor,
  skills: { capabilities: noReads, authorityOf: noReads },
  audiences: noReads,
  ownerOf: (reader) => {
    if (reader.type !== "person") {
      throw brainErrors.create("brain.denied");
    }
    return reader.person.userId;
  },
  mayPublish: noReads,
  mayRetire: noReads,
  mayReplaceMatch: noReads,
  wordLesson: noBackgroundWork,
  memories: { audienceOf: noReads, readableBy: noReads, keep: noReads },
  recall: { require: noReads, key: noReads, isRefusal: noReads },
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
  rerank: noReads,
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
