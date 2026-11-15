import { ensureCollection } from "@grasp-os/brain/collections";
import type { CollectionRow } from "@grasp-os/brain/collections";
import { collections } from "@grasp-os/brain/schema";
import { actorOf } from "@grasp-os/shared/audit";
import { collectionIdSchema } from "@grasp-os/shared/ids";
import type { CollectionId } from "@grasp-os/shared/ids";
import type { SkillCollections } from "@grasp-os/shared/knowledge";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";

import { brainOf } from "./ports.ts";

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
