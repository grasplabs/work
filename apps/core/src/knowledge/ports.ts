import { brainErrors } from "@grasp-os/brain/contract";
import { drizzle } from "drizzle-orm/d1";

import { drainKnowledgeOutboxSoon } from "../audit-outbox.ts";
import { derivedHmacKey } from "../derived-keys.ts";
import { runEngine } from "../workflows/engine.ts";
import { noteProvenance, readerActor } from "./access.ts";
import type { Reader } from "./access.ts";
import { authorize } from "./app-entries.ts";
import type { Brain, BrainPorts } from "./brain.ts";
import { recallKey, requireRecall } from "./recall-grants.ts";
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
  ownerOf: (reader) => {
    if (reader.type !== "person") {
      throw brainErrors.create("brain.denied");
    }
    return reader.person.userId;
  },
  recall: {
    require: async (reader) => {
      await requireRecall(env, reader);
    },
    key: async (reader) => await recallKey(env, reader),
  },
  onWrite: async (write) => {
    await checkWrite(env, write);
  },
  blobs: env.BRAIN_OBJECTS,
  audit: {
    drain: () => {
      drainKnowledgeOutboxSoon(env);
    },
  },
  keys: {
    hmac: async (purpose, usages) => await derivedHmacKey(env, purpose, usages),
  },
  jobs: {
    start: async (id, { documentId, version }) => {
      await runEngine(env).createInternal({
        id,
        workflow: "indexing",
        input: { documentId, version },
      });
    },
    status: async (id) => {
      const found = await runEngine(env).status(id);
      return found && (endedStatuses.has(found.status) ? "ended" : "running");
    },
  },
  clock: () => new Date(),
});

/** The Brain for a request of core's, over `env`. */
export const brainOf = (env: Env): Brain<Reader> => ({
  db: drizzle(env.KNOWLEDGE),
  ports: portsOf(env),
});
