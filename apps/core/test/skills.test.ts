import type { PurgeInput } from "@grasp-os/shared/brain-documents";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import {
  clientSkillsCollectionId,
  graspSkills,
  graspSkillsCollectionId,
  syncGraspSkills,
} from "../src/brain/grasp-skills.ts";
import type { GraspSkill } from "../src/brain/grasp-skills.ts";
import { requestGranted } from "./apps.ts";
import { brainRacing, readCollection } from "./brain-collections.ts";
import { actingFor, envOf, brainIn, newChat } from "./contexts.ts";
import { mockIdp } from "./idp.ts";
import {
  auditedDuring,
  outcome,
  refusal,
  signedInApi,
  unique,
} from "./sign-in.ts";

// Skills: the Grasp skills, which ship with each release and its install
// syncs into their collection (builtins.test.ts tests when it runs), and
// the client's own. These tests
// start from the ways that can fail: a release's changed skill never
// reaches the collection, or reaches it twice when two syncs run at once,
// or a sync writes when nothing changed; someone, an admin too, changes a
// Grasp skill through a save, a restore or a purge, which the next sync
// would silently undo; a copy lands outside the client's skills, is made
// by someone who can't write them, overwrites a skill the client already
// has, or copies something that isn't a Grasp skill; and the catalog
// leaves out one of the two collections.
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
  const { documents } = await person.api.brain.listDocuments(
    graspSkillsCollectionId
  );
  return documents;
};

/** The Grasp skill at `path`, synced from this release first. */
const graspDocument = async (person: Person, path: string) => {
  await syncGraspSkills(env);
  const documents = await graspDocuments(person);
  const found = documents.find((document) => document.path === path);
  if (!found) {
    throw new Error(`There's no Grasp skill at ${path}`);
  }
  return found;
};

/** The current text of `documentId`, as `person` reads it. */
const textOf = async (person: Person, documentId: string): Promise<string> => {
  const { version } = await person.api.brain.getDocument(documentId);
  return version.text;
};

/** This release's skills, with `path`'s text changed: another release. */
const releaseChanging = (path: string, text: string): GraspSkill[] =>
  graspSkills.map((skill) => (skill.path === path ? { path, text } : skill));

const brainActions = <Event extends { action: string }>(
  events: Event[]
): Event[] => events.filter(({ action }) => action.startsWith("brain."));

describe("the Grasp skills", setUpTime, () => {
  it("are every skill folder of the release, and only those", () => {
    // Vite lists the folders at build time; the Worker imports each one.
    const folders = Object.keys(import.meta.glob("../skills/*/SKILL.md")).map(
      (file) => file.slice("../skills/".length)
    );
    expect(graspSkills.map(({ path }) => path).toSorted()).toStrictEqual(
      folders.toSorted()
    );
  });

  it("are this release's once synced, and a sync with nothing changed writes nothing", async () => {
    const admin = await personOf("admin");
    await syncGraspSkills(env);

    const documents = await graspDocuments(admin);
    expect(documents.map(({ path }) => path)).toStrictEqual(
      graspSkills.map(({ path }) => path).toSorted()
    );
    const texts = await Promise.all(
      documents.map(async ({ id }) => await textOf(admin, id))
    );
    expect(texts).toStrictEqual(
      documents.map(
        ({ path }) => graspSkills.find((skill) => skill.path === path)?.text
      )
    );
    // Each is a skill named after its folder, as the catalog lists it.
    expect(
      documents.map(({ path, type, title }) => [path, type, title])
    ).toStrictEqual(
      documents.map(({ path }) => [
        path,
        "skill",
        path.slice(0, -"/SKILL.md".length),
      ])
    );

    const events = await auditedDuring(async () => {
      await syncGraspSkills(env);
    });
    await expect(graspDocuments(admin)).resolves.toStrictEqual(documents);
    expect(brainActions(events)).toStrictEqual([]);
  });

  it("take a release's changed skill as its next version, written once when another sync gets there first", async () => {
    const admin = await personOf("admin");
    const [skill] = graspSkills;
    if (!skill) {
      throw new Error("This release ships no Grasp skills");
    }
    const changed = await graspDocument(admin, skill.path);
    const before = await graspDocuments(admin);
    const changedText = `${skill.text}\nOne more thing.\n`;
    const next = releaseChanging(skill.path, changedText);

    // The second sync reads the skill at the same version as the first,
    // and writes only once the first has written it.
    const events = await auditedDuring(async () => {
      await syncGraspSkills(
        {
          ...env,
          BRAIN_DB: brainRacing(async () => {
            await syncGraspSkills(env, next);
          }),
        },
        next
      );
    });

    const after = await graspDocuments(admin);
    expect(
      after.map(({ path, currentVersion }) => [path, currentVersion])
    ).toStrictEqual(
      before.map(({ path, currentVersion }) => [
        path,
        path === skill.path ? currentVersion + 1 : currentVersion,
      ])
    );
    const { version } = await admin.api.brain.getDocument(changed.id);
    expect([
      version.number,
      version.author,
      version.message,
      version.text,
    ]).toStrictEqual([
      changed.currentVersion + 1,
      "grasp",
      "From the release",
      changedText,
    ]);
    expect(
      brainActions(events).map(({ action, actor, target }) => ({
        action,
        actor,
        target,
      }))
    ).toStrictEqual([
      {
        action: "brain.document.saved",
        actor: { type: "system" },
        target: { type: "document", id: changed.id },
      },
    ]);

    // A rollback to this release puts its text back, as a version too.
    await syncGraspSkills(env);
    const rolledBack = await admin.api.brain.getDocument(changed.id);
    expect([rolledBack.version.number, rolledBack.version.text]).toStrictEqual([
      changed.currentVersion + 2,
      skill.text,
    ]);
  });

  it("can't be changed by anyone, an admin neither: not saved, restored or purged", async () => {
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
          admin.api.brain.saveDocument({
            collectionId: graspSkillsCollectionId,
            path: document.path,
            text: "---\nname: mine\ndescription: Mine now.\n---",
            ifVersion: document.currentVersion,
          })
        ),
        outcome(
          admin.api.brain.saveDocument({
            collectionId: graspSkillsCollectionId,
            path: "new/SKILL.md",
            text: "---\nname: new\ndescription: A new one.\n---",
            ifVersion: 0,
          })
        ),
        outcome(
          admin.api.brain.restoreVersion({
            documentId: document.id,
            version: 1,
            ifVersion: document.currentVersion,
          })
        ),
      ])
    ).resolves.toStrictEqual([
      "brain.read_only",
      "brain.read_only",
      "brain.read_only",
    ]);
    await expect(
      refusal(
        admin.api.brain.preparePurge({
          type: "content",
          documentIds: [document.id],
          terms: ["workflow"],
          reason: "other",
        })
      )
    ).resolves.toMatchObject({
      code: "brain.read_only",
      details: {
        issues: [
          `documentIds: document ${document.id} is a Grasp skill, which is read-only: it holds the release's text, and the next sync would put back anything changed`,
        ],
      },
    });
    await expect(graspDocuments(admin)).resolves.toStrictEqual(before);
  });
});

describe("copying a Grasp skill", setUpTime, () => {
  it("puts it in the client's skills, at the same path, where admins adapt and purge it", async () => {
    const admin = await personOf("admin");
    const document = await graspDocument(admin, "draw-a-workflow/SKILL.md");

    let copyId = "";
    const events = await auditedDuring(async () => {
      const copy = await admin.api.brain.copySkill({
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
      brainActions(events)
        .filter(({ action }) => action !== "brain.collection.created")
        .map(({ action, actor, target, detail }) => ({
          action,
          actor,
          target,
          detail,
        }))
    ).toStrictEqual([
      {
        action: "brain.document.saved",
        actor: { type: "person", userId: admin.userId },
        target: { type: "document", id: copyId },
        detail: { collectionId: clientSkillsCollectionId, version: 1 },
      },
      {
        action: "brain.skill.copied",
        actor: { type: "person", userId: admin.userId },
        target: { type: "document", id: document.id },
        detail: {
          version: document.currentVersion,
          collectionId: clientSkillsCollectionId,
        },
      },
    ]);

    const adapted = await admin.api.brain.saveDocument({
      collectionId: clientSkillsCollectionId,
      path: document.path,
      text: `${await textOf(admin, copyId)}\nAsk Anna de Vries first.\n`,
      ifVersion: 1,
    });
    expect(adapted.currentVersion).toBe(2);
    const input: PurgeInput = {
      type: "content",
      documentIds: [copyId],
      terms: ["Anna de Vries"],
      reason: "erasure_request",
    };
    const plan = await admin.api.brain.preparePurge(input);
    await admin.api.brain.purge(input, plan.token);
    await expect(textOf(admin, copyId)).resolves.toContain(
      "Ask (removed) first."
    );
  });

  it("is refused where the client's skills have the path already, for anyone but admins, and for what isn't a Grasp skill", async () => {
    const admin = await personOf("admin");
    const user = await personOf("user");
    const document = await graspDocument(admin, "run-a-baseline/SKILL.md");
    const copy = await admin.api.brain.copySkill({
      documentId: document.id,
    });

    await expect(
      refusal(admin.api.brain.copySkill({ documentId: document.id }))
    ).resolves.toMatchObject({
      code: "brain.conflict",
      details: { documentId: copy.id, latestVersion: 1 },
    });
    await expect(
      refusal(admin.api.brain.copySkill({ documentId: copy.id }))
    ).resolves.toMatchObject({
      code: "brain.document_invalid",
      details: { issues: ["documentId: not a Grasp skill"] },
    });
    await expect(
      Promise.all([
        outcome(user.api.brain.copySkill({ documentId: document.id })),
        outcome(admin.api.brain.copySkill({ documentId: crypto.randomUUID() })),
        outcome(admin.api.brain.copySkill({ documentId: "" })),
      ])
    ).resolves.toStrictEqual([
      "brain.forbidden",
      "brain.document_not_found",
      "brain.document_invalid",
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
    await expect(admin.api.brain.skillCollections()).resolves.toStrictEqual(
      both
    );
    const copy = await admin.api.brain.copySkill({
      documentId: document.id,
    });

    await expect(user.api.brain.skillCollections()).resolves.toStrictEqual(
      both
    );
    const catalog = await user.api.brain.catalog();
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
    await syncGraspSkills(env);
    await admin.api.brain.skillCollections();
    const name = `ours-${unique()}`;
    const ours = await admin.api.brain.saveDocument({
      collectionId: clientSkillsCollectionId,
      path: `${name}/SKILL.md`,
      text: `---\nname: ${name}\ndescription: How we do it here.\n---\n# Ours`,
      ifVersion: 0,
    });
    const grasp = await graspDocuments(admin);
    const graspIds = grasp.map(({ id }) => id);
    // The agent's Brain tools, which it has only once it may read a
    // collection.
    const toolsNow = async () =>
      brainIn(
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
