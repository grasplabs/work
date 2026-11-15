import { ensureCollection } from "@grasp-os/brain/collections";
import { writeVersion } from "@grasp-os/brain/documents";
import { collectionIdSchema } from "@grasp-os/shared/ids";
import { knowledgeErrors } from "@grasp-os/shared/knowledge";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { brainOf } from "../src/knowledge/ports.ts";
import { shippedSkills } from "../src/shipped-skills.ts";
import { requestGranted } from "./apps.ts";
import { actingFor, envOf, knowledgeIn, newChat } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import { readCollection, seed } from "./knowledge.ts";
import { signedInApi, unique } from "./sign-in.ts";

// Skills in Knowledge, as a deployment holds them until the cutover
// removes it: the Grasp skills, as releases synced them before Grasp's
// skills moved to the Brain, and the client's own. Nothing writes either
// any more (GRA-1911). These tests start from the ways the reads can fail:
// the catalog leaves out one of the two collections, or lists one to an
// agent that wasn't granted it.

const idp = mockIdp();

/** The Grasp skills' collection, as releases synced it: under this ID alone. */
const graspSkillsCollectionId = collectionIdSchema.parse("grasp-skills");

/** The client's skills collection, as an admin's first visit made it. */
const clientSkillsCollectionId = collectionIdSchema.parse("skills");

/** Signing people in can be slow on CI. */
const setUpTime = { timeout: 60_000 };

const personOf = async (role: Role) => await signedInApi(idp, role);

type Person = Awaited<ReturnType<typeof personOf>>;

/** The Grasp skills' documents, in path order, as `person` lists them. */
const graspDocuments = async (person: Person) => {
  const { documents } = await person.api.knowledge.listDocuments(
    graspSkillsCollectionId
  );
  return documents;
};

/** The Grasp skills, each at `<name>/SKILL.md`. */
const graspSkills = shippedSkills.map(({ name, text }) => ({
  path: `${name}/SKILL.md`,
  text,
}));

/**
 * The client's skills collection as a deployment holds it: made by the
 * admin `ownerId` before nothing in core wrote Knowledge any more.
 */
const clientSkillsInKnowledge = async (ownerId: string): Promise<void> => {
  await ensureCollection(
    brainOf(env),
    {
      id: clientSkillsCollectionId,
      name: "Our skills",
      description: "The company's own skills: how we do things here.",
      owner: ownerId,
      access: "everyone",
      sensitive: false,
      source: "here",
      createdAt: new Date(),
    },
    { type: "person", userId: ownerId }
  );
};

/**
 * The Grasp skills' collection as releases synced it into Knowledge:
 * Grasp's own, each skill written by Grasp as a sync, once.
 */
const graspSkillsInKnowledge = async (): Promise<void> => {
  const actor = { type: "system" } as const;
  const collection = await ensureCollection(
    brainOf(env),
    {
      id: graspSkillsCollectionId,
      name: "Grasp skills",
      description: "How Grasp works: skills that ship with each release.",
      owner: "grasp",
      access: "everyone",
      sensitive: false,
      source: "grasp",
      createdAt: new Date(),
    },
    actor
  );
  for (const { path, text } of graspSkills) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- a few skills, one at a time
      await writeVersion(
        brainOf(env),
        { actor, userId: "grasp" },
        {
          collection,
          path,
          text,
          ifVersion: 0,
          message: "From the release",
          restoredFrom: null,
          sync: true,
        }
      );
    } catch (error) {
      // Written by an earlier test of the file.
      if (knowledgeErrors.codeOf(error) !== "knowledge.conflict") {
        throw error;
      }
    }
  }
};

/** The Grasp skill at `path`, its collection written first. */
const graspDocument = async (person: Person, path: string) => {
  await graspSkillsInKnowledge();
  const documents = await graspDocuments(person);
  const found = documents.find((document) => document.path === path);
  if (!found) {
    throw new Error(`There's no Grasp skill at ${path}`);
  }
  return found;
};

describe("the skill catalog", setUpTime, () => {
  it("lists both collections, the Grasp skills and the client's, and the skills in each, as a deployment holds them", async () => {
    const admin = await personOf("admin");
    const user = await personOf("user");
    const document = await graspDocument(admin, "write-board-page/SKILL.md");
    await clientSkillsInKnowledge(admin.userId);
    const shipped = await admin.api.knowledge.getDocument(document.id);
    // A copy in the client's skills, as an admin made one before nothing
    // in core wrote Knowledge any more.
    const copy = await seed(admin.api).saveDocument({
      collectionId: clientSkillsCollectionId,
      path: document.path,
      text: shipped.version.text,
      ifVersion: 0,
    });

    const catalog = await user.api.knowledge.catalog();
    const ids = new Set<string>([
      graspSkillsCollectionId,
      clientSkillsCollectionId,
    ]);
    expect(
      catalog.collections
        .filter(({ id }) => ids.has(id))
        .map(({ name }) => name)
    ).toStrictEqual(["Grasp skills", "Our skills"]);
    const listed = catalog.skills.map(({ documentId }) => documentId);
    const graspListed = await graspDocuments(user);
    expect(listed).toStrictEqual(
      expect.arrayContaining([...graspListed.map(({ id }) => id), copy.id])
    );
  });

  it("lists neither collection to an agent until it is granted each, like any collection", async () => {
    const admin = await personOf("admin");
    const agent = { type: "agent" as const, agentId: `agent-${unique()}` };
    await graspSkillsInKnowledge();
    await clientSkillsInKnowledge(admin.userId);
    const name = `ours-${unique()}`;
    const ours = await seed(admin.api).saveDocument({
      collectionId: clientSkillsCollectionId,
      path: `${name}/SKILL.md`,
      text: `---\nname: ${name}\ndescription: How we do it here.\n---\n# Ours`,
      ifVersion: 0,
    });
    const grasp = await graspDocuments(admin);
    const graspIds = grasp.map(({ id }) => id);
    // The agent's Knowledge tools, which it has only once it may read a
    // collection.
    const toolsNow = async () =>
      knowledgeIn(
        await envOf(actingFor(agent, admin.userId), await newChat(agent))
      );
    const ungranted = await toolsNow();

    await requestGranted(
      idp,
      admin,
      readCollection(agent, graspSkillsCollectionId, "GRASP_SKILLS")
    );
    await requestGranted(
      idp,
      admin,
      readCollection(agent, clientSkillsCollectionId, "SKILLS")
    );

    const granted = await toolsNow();
    const catalog = await granted?.catalog();
    expect(ungranted).toBeUndefined();
    expect(catalog?.skills.map(({ documentId }) => documentId)).toStrictEqual(
      expect.arrayContaining([...graspIds, ours.id])
    );
  });
});
