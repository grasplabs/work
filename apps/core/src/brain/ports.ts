import { createBrain } from "@grasp-os/brain/brain";
import type { Brain, BrainPorts } from "@grasp-os/brain/brain";
import { brainErrors } from "@grasp-os/brain/contract";
import { permissionErrors } from "@grasp-os/shared/permissions";

import { brainEventOf, drainBrainOutboxSoon } from "../audit-outbox.ts";
import { derivedHmacKey } from "../derived-keys.ts";
import { runEngine } from "../workflows/engine.ts";
import { audiencesOf, noteProvenance, readerActor } from "./access.ts";
import type { Reader } from "./access.ts";
import { authorize } from "./app-entries.ts";
import { extractEntities } from "./entities.ts";
import { wordLesson } from "./lesson-wording.ts";
import {
  keepRecalledMemories,
  readableByEveryoneOf,
  recallMemoryAudience,
} from "./memory-audience.ts";
import { mayPublish, mayRetire } from "./memory-publish.ts";
import { recallKey, requireRecall } from "./recall-grants.ts";
import { skillAuthorities, skillCapabilities } from "./skill-capabilities.ts";
import { checkWrite } from "./write-rules.ts";

// Core's side of the Brain's ports (brain.ts): what each port is in core.

/** Where the engine has a run that has ended. */
const endedStatuses: ReadonlySet<string> = new Set([
  "complete",
  "errored",
  "terminated",
]);

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
  wordLesson: async (facts) => await wordLesson(env, facts),
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
  onWrite: async (write) => {
    await checkWrite(env, write);
  },
  blobs: env.BRAIN_OBJECTS,
  audit: {
    eventOf: brainEventOf,
    drain: () => {
      drainBrainOutboxSoon(env);
    },
  },
  keys: {
    hmac: async (purpose, usages) => await derivedHmacKey(env, purpose, usages),
  },
  extractEntities: async (text) => await extractEntities(env, text),
  jobs: {
    start: async (id, job) => {
      await runEngine(env).createInternal(
        "source" in job
          ? {
              id,
              workflow: "linking",
              input: { source: job.source, version: job.version },
            }
          : {
              id,
              workflow: "indexing",
              input: { documentId: job.documentId, version: job.version },
            }
      );
    },
    status: async (id) => {
      const found = await runEngine(env).status(id);
      return found && (endedStatuses.has(found.status) ? "ended" : "running");
    },
  },
  clock: () => new Date(),
});

/** The Brain for a request of core's, over `env`. */
export const brainOf = (env: Env): Brain<Reader> =>
  createBrain(env.BRAIN_DB, portsOf(env));
