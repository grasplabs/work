import { allowedFor } from "@grasp-os/brain/authorize";
import { readableCollection } from "@grasp-os/brain/collections";
import {
  readableDocument,
  versionText,
  writeVersion,
} from "@grasp-os/brain/documents";
import type { Writer } from "@grasp-os/brain/documents";
import { actorOf } from "@grasp-os/shared/audit";
import {
  collectionErrors,
  restoreInputSchema,
  saveInputSchema,
} from "@grasp-os/shared/brain-documents";
import type { DocumentSummary } from "@grasp-os/shared/brain-documents";
import type { Identity } from "@grasp-os/shared/rpc";
import { drizzle } from "drizzle-orm/d1";

import { requireWritable } from "./collection-rules.ts";
import { portsOf, brainOf } from "./ports.ts";

// A person saving and restoring the Brain's documents themselves: core
// checks they may change the collection (collection-rules.ts), then
// The Brain writes the version, by them.

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
    collectionErrors.parse("brain.document_invalid", saveInputSchema, input);
  const db = drizzle(env.BRAIN_DB);
  const allowed = await allowedFor(portsOf(env), { type: "person", person });
  const collection = await readableCollection(
    db,
    allowed.collections,
    collectionId
  );
  requireWritable(env, person, collection);
  return await writeVersion(brainOf(env), personWriter(person), {
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
  const { documentId, version, ifVersion } = collectionErrors.parse(
    "brain.document_invalid",
    restoreInputSchema,
    input
  );
  const db = drizzle(env.BRAIN_DB);
  const { document, collection } = await readableDocument(
    db,
    await allowedFor(portsOf(env), { type: "person", person }),
    documentId
  );
  requireWritable(env, person, collection);
  const restored = await versionText(brainOf(env), db, document.id, version);
  if (restored === undefined) {
    throw collectionErrors.create("brain.document_not_found");
  }
  return await writeVersion(brainOf(env), personWriter(person), {
    collection,
    path: document.path,
    text: restored,
    ifVersion,
    message: null,
    restoredFrom: version,
  });
};
