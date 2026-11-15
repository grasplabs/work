import { allowedFor } from "@grasp-os/brain/authorize";
import { ensureCollection } from "@grasp-os/brain/collections";
import type { CollectionRow } from "@grasp-os/brain/collections";
import {
  readableDocument,
  versionText,
  writeVersion,
} from "@grasp-os/brain/documents";
import { collections } from "@grasp-os/brain/schema";
import { actorOf } from "@grasp-os/shared/audit";
import { collectionIdSchema } from "@grasp-os/shared/ids";
import type { CollectionId } from "@grasp-os/shared/ids";
import {
  copySkillInputSchema,
  documentTypeOf,
  knowledgeErrors,
} from "@grasp-os/shared/knowledge";
import type {
  DocumentSummary,
  SkillCollections,
} from "@grasp-os/shared/knowledge";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { outboxed } from "../audit-outbox.ts";
import { requireWritable } from "./collection-rules.ts";
import { personWriter } from "./person-writes.ts";
import { portsOf, brainOf } from "./ports.ts";

// Skills in two collections, both in every person's catalog, and in an
// agent's once it is granted read of each, as for any collection (agents
// start with access to nothing):
//
// - the Grasp skills, as releases synced them into their collection
//   (source `grasp`) until Grasp's skills moved to the Brain
//   (brain-skills.ts): nobody writes them, admins neither (documents.ts
//   `checkedText`), and a purge that names one is refused;
// - the client's skills: a collection for everyone that its admins write,
//   like any other, and where a Grasp skill is copied to be adapted.

/** The Grasp skills' collection, under this ID: no other has it. */
export const graspSkillsCollectionId: CollectionId =
  collectionIdSchema.parse("grasp-skills");

/** The client's skills collection, under this ID: no other has it. */
export const clientSkillsCollectionId: CollectionId =
  collectionIdSchema.parse("skills");

/** The client's skills collection, as the admin `ownerId` sets it up. */
const clientSkillsRow = (ownerId: string): CollectionRow => ({
  id: clientSkillsCollectionId,
  name: "Our skills",
  description:
    "The company's own skills: how we do things here. Admins write them, or copy a Grasp skill here to adapt it.",
  owner: ownerId,
  access: "everyone",
  sensitive: false,
  source: "here",
  createdAt: new Date(),
});

/**
 * The client's skills collection, created by `person` if they are an
 * admin and it doesn't exist yet (they own it then; every admin can
 * change it). `undefined` for anyone else while it doesn't exist.
 */
const clientSkills = async (
  env: Env,
  person: Identity
): Promise<CollectionRow | undefined> => {
  if (isAdmin(person.role)) {
    return await ensureCollection(
      brainOf(env),
      clientSkillsRow(person.userId),
      actorOf(person)
    );
  }
  return await drizzle(env.KNOWLEDGE)
    .select()
    .from(collections)
    .where(eq(collections.id, clientSkillsCollectionId))
    .get();
};

/** Whether a collection exists under `id`. */
const exists = async (env: Env, id: CollectionId): Promise<boolean> => {
  const found = await drizzle(env.KNOWLEDGE)
    .select({ id: collections.id })
    .from(collections)
    .where(eq(collections.id, id))
    .get();
  return found !== undefined;
};

/**
 * The Grasp skills and the client's skills collections, creating the
 * client's for an admin (`clientSkills`).
 */
export const skillCollections = async (
  env: Env,
  person: Identity
): Promise<SkillCollections> => {
  const client = await clientSkills(env, person);
  return {
    grasp: (await exists(env, graspSkillsCollectionId))
      ? graspSkillsCollectionId
      : null,
    client: client ? clientSkillsCollectionId : null,
  };
};

/**
 * Copies the Grasp skill `documentId`, at its current version, into the
 * client's skills at the same path, as `person`, through the save
 * pipeline: only by those who may change the client's skills (admins),
 * and `knowledge.conflict` when that path is taken there already.
 * `knowledge.invalid` for a document that isn't a Grasp skill;
 * `knowledge.not_found` for one `person` can't read. Recorded in the
 * audit log, with the version copied.
 */
export const copySkill = async (
  env: Env,
  person: Identity,
  input: unknown
): Promise<DocumentSummary> => {
  const { documentId } = knowledgeErrors.parse(
    "knowledge.invalid",
    copySkillInputSchema,
    input
  );
  const db = drizzle(env.KNOWLEDGE);
  const { document, collection } = await readableDocument(
    db,
    await allowedFor(portsOf(env), { type: "person", person }),
    documentId
  );
  if (
    collection.id !== graspSkillsCollectionId ||
    documentTypeOf(document.type) !== "skill"
  ) {
    throw knowledgeErrors.create("knowledge.invalid", {
      issues: ["documentId: not a Grasp skill"],
    });
  }
  const target = await clientSkills(env, person);
  if (!target) {
    throw knowledgeErrors.create("knowledge.forbidden");
  }
  requireWritable(env, person, target);
  // Versions never change once written (the Grasp skills are never
  // purged), so this is the text of the version the document was at when
  // read, whatever the sync wrote since.
  const copied = await versionText(
    brainOf(env),
    db,
    document.id,
    document.currentVersion
  );
  if (copied === undefined) {
    throw knowledgeErrors.create("knowledge.not_found");
  }
  return await writeVersion(brainOf(env), personWriter(person), {
    collection: target,
    path: document.path,
    text: copied,
    ifVersion: 0,
    message: `Copied from Grasp skills, version ${document.currentVersion}`,
    restoredFrom: null,
    also: [
      outboxed(db, {
        actor: actorOf(person),
        action: "knowledge.skill.copied",
        target: { type: "document", id: document.id },
        detail: { version: document.currentVersion, collectionId: target.id },
      }),
    ],
  });
};
