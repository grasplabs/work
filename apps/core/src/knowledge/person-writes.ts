import { actorOf } from "@grasp-os/shared/audit";
import {
  knowledgeErrors,
  restoreInputSchema,
  saveInputSchema,
} from "@grasp-os/shared/knowledge";
import type { DocumentSummary } from "@grasp-os/shared/knowledge";
import type { Identity } from "@grasp-os/shared/rpc";
import { drizzle } from "drizzle-orm/d1";

import { allowedFor } from "./authorize.ts";
import { requireWritable } from "./collection-rules.ts";
import { readableCollection } from "./collections.ts";
import { readableDocument, versionText, writeVersion } from "./documents.ts";
import type { Writer } from "./documents.ts";
import { portsOf } from "./ports.ts";

// A person saving and restoring Knowledge's documents themselves: core
// checks they may change the collection (collection-rules.ts), then
// Knowledge writes the version, by them.

/** A person, saving a version themselves. */
export const personWriter = (person: Identity): Writer => ({
  actor: actorOf(person),
  userId: person.userId,
});

/** Saves a new version of a document, or its first. */
export const saveDocument = async (
  env: Env,
  person: Identity,
  input: unknown
): Promise<DocumentSummary> => {
  const { collectionId, path, text, ifVersion, message } =
    knowledgeErrors.parse("knowledge.invalid", saveInputSchema, input);
  const db = drizzle(env.KNOWLEDGE);
  const allowed = await allowedFor(portsOf(env), { type: "person", person });
  const collection = await readableCollection(
    db,
    allowed.collections,
    collectionId
  );
  requireWritable(env, person, collection);
  return await writeVersion(env, personWriter(person), {
    collection,
    path,
    text,
    ifVersion,
    message: message === undefined || message === "" ? null : message,
    restoredFrom: null,
  });
};

/** Saves an earlier version's text as the next version. */
export const restoreVersion = async (
  env: Env,
  person: Identity,
  input: unknown
): Promise<DocumentSummary> => {
  const { documentId, version, ifVersion } = knowledgeErrors.parse(
    "knowledge.invalid",
    restoreInputSchema,
    input
  );
  const db = drizzle(env.KNOWLEDGE);
  const { document, collection } = await readableDocument(
    db,
    await allowedFor(portsOf(env), { type: "person", person }),
    documentId
  );
  requireWritable(env, person, collection);
  const restored = await versionText(env, db, document.id, version);
  if (restored === undefined) {
    throw knowledgeErrors.create("knowledge.not_found");
  }
  return await writeVersion(env, personWriter(person), {
    collection,
    path: document.path,
    text: restored,
    ifVersion,
    message: null,
    restoredFrom: version,
  });
};
