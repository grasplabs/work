import { ensureCollection } from "@grasp-os/brain/collections";
import { writeVersion } from "@grasp-os/brain/documents";
import { knowledgeErrors } from "@grasp-os/shared/knowledge";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import {
  clientSkillsCollectionId,
  graspSkillsCollectionId,
} from "../src/knowledge/grasp-skills.ts";
import { brainOf } from "../src/knowledge/ports.ts";
import { shippedSkills } from "../src/shipped-skills.ts";
import { requestGranted } from "./apps.ts";
import { actingFor, envOf, knowledgeIn, newChat } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import { readCollection } from "./knowledge.ts";
import {
  auditedDuring,
  outcome,
  refusal,
  signedInApi,
  unique,
} from "./sign-in.ts";

// Skills in Knowledge: the Grasp skills, as releases synced them into
// their collection before Grasp's skills moved to the Brain, and the
// client's own. These tests start from the ways that can fail: someone,
// an admin too, changes a Grasp skill through a save, a restore or a
// purge; a copy lands outside the client's skills, is made by someone who
// can't write them, overwrites a skill the client already has, or copies
// something that isn't a Grasp skill; and the catalog leaves out one of
// the two collections.
//
// The tests of a file share their storage, so each copy test copies a
// skill of its own.

const idp = mockIdp();

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

/** The current text of `documentId`, as `person` reads it. */
const textOf = async (person: Person, documentId: string): Promise<string> => {
  const { version } = await person.api.knowledge.getDocument(documentId);
  return version.text;
};

const knowledgeActions = <Event extends { action: string }>(
  events: Event[]
): Event[] => events.filter(({ action }) => action.startsWith("knowledge."));

describe("the Grasp skills", setUpTime, () => {
  it("can't be changed by anyone, an admin neither: not saved or restored", async () => {
    const admin = await personOf("admin");
    const [skill] = graspSkills;
    if (!skill) {
      throw new Error("This release ships no Grasp skills");
    }
    const document = await graspDocument(admin, skill.path);
    const before = await graspDocuments(admin);

    await expect(
      Promise.all([
        outcome(
          admin.api.knowledge.saveDocument({
            collectionId: graspSkillsCollectionId,
            path: document.path,
            text: "---\nname: mine\ndescription: Mine now.\n---",
            ifVersion: document.currentVersion,
          })
        ),
        outcome(
          admin.api.knowledge.saveDocument({
            collectionId: graspSkillsCollectionId,
            path: "new/SKILL.md",
            text: "---\nname: new\ndescription: A new one.\n---",
            ifVersion: 0,
          })
        ),
        outcome(
          admin.api.knowledge.restoreVersion({
            documentId: document.id,
            version: 1,
            ifVersion: document.currentVersion,
          })
        ),
      ])
    ).resolves.toStrictEqual([
      "knowledge.read_only",
      "knowledge.read_only",
      "knowledge.read_only",
    ]);
    await expect(graspDocuments(admin)).resolves.toStrictEqual(before);
  });
});

describe("copying a Grasp skill", setUpTime, () => {
  it("puts it in the client's skills, at the same path, where admins adapt it", async () => {
    const admin = await personOf("admin");
    const document = await graspDocument(admin, "draw-a-workflow/SKILL.md");

    let copyId = "";
    const events = await auditedDuring(async () => {
      const copy = await admin.api.knowledge.copySkill({
        documentId: document.id,
      });
      copyId = copy.id;
      expect(copy).toMatchObject({
        collectionId: clientSkillsCollectionId,
        path: document.path,
        type: "skill",
        title: document.title,
        currentVersion: 1,
      });
    });
    await expect(textOf(admin, copyId)).resolves.toBe(
      await textOf(admin, document.id)
    );
    expect(
      knowledgeActions(events)
        .filter(({ action }) => action !== "knowledge.collection.created")
        .map(({ action, actor, target, detail }) => ({
          action,
          actor,
          target,
          detail,
        }))
    ).toStrictEqual([
      {
        action: "knowledge.document.saved",
        actor: { type: "person", userId: admin.userId },
        target: { type: "document", id: copyId },
        detail: { collectionId: clientSkillsCollectionId, version: 1 },
      },
      {
        action: "knowledge.skill.copied",
        actor: { type: "person", userId: admin.userId },
        target: { type: "document", id: document.id },
        detail: {
          version: document.currentVersion,
          collectionId: clientSkillsCollectionId,
        },
      },
    ]);

    const adapted = await admin.api.knowledge.saveDocument({
      collectionId: clientSkillsCollectionId,
      path: document.path,
      text: `${await textOf(admin, copyId)}\nAsk Anna de Vries first.\n`,
      ifVersion: 1,
    });
    expect(adapted.currentVersion).toBe(2);
  });

  it("is refused where the client's skills have the path already, for anyone but admins, and for what isn't a Grasp skill", async () => {
    const admin = await personOf("admin");
    const user = await personOf("user");
    const document = await graspDocument(admin, "run-a-baseline/SKILL.md");
    const copy = await admin.api.knowledge.copySkill({
      documentId: document.id,
    });

    await expect(
      refusal(admin.api.knowledge.copySkill({ documentId: document.id }))
    ).resolves.toMatchObject({
      code: "knowledge.conflict",
      details: { documentId: copy.id, latestVersion: 1 },
    });
    await expect(
      refusal(admin.api.knowledge.copySkill({ documentId: copy.id }))
    ).resolves.toMatchObject({
      code: "knowledge.invalid",
      details: { issues: ["documentId: not a Grasp skill"] },
    });
    await expect(
      Promise.all([
        outcome(user.api.knowledge.copySkill({ documentId: document.id })),
        outcome(
          admin.api.knowledge.copySkill({ documentId: crypto.randomUUID() })
        ),
        outcome(admin.api.knowledge.copySkill({ documentId: "" })),
      ])
    ).resolves.toStrictEqual([
      "knowledge.forbidden",
      "knowledge.not_found",
      "knowledge.invalid",
    ]);
  });
});

describe("the skill catalog", setUpTime, () => {
  it("lists both collections, the Grasp skills and the client's, and the skills in each", async () => {
    const admin = await personOf("admin");
    const user = await personOf("user");
    const document = await graspDocument(admin, "write-board-page/SKILL.md");
    const both = {
      grasp: graspSkillsCollectionId,
      client: clientSkillsCollectionId,
    };
    await expect(admin.api.knowledge.skillCollections()).resolves.toStrictEqual(
      both
    );
    const copy = await admin.api.knowledge.copySkill({
      documentId: document.id,
    });

    await expect(user.api.knowledge.skillCollections()).resolves.toStrictEqual(
      both
    );
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
    await admin.api.knowledge.skillCollections();
    const name = `ours-${unique()}`;
    const ours = await admin.api.knowledge.saveDocument({
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
