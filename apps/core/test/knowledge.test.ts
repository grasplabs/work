import type { CollectionInput, KnowledgeApi } from "@grasp-os/shared/knowledge";
import type { Role } from "@grasp-os/shared/roles";
import { describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import { newTeam, seed } from "./knowledge.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";

// Knowledge through the API people use, until the cutover removes it:
// nobody reads what they may not. Nothing writes it any more (GRA-1911):
// what these read is planted through the package (`seed`).

const idp = mockIdp();

/** A signed-in person's Knowledge API, on a connection of their own. */
const knowledgeOf = async (role: Role) => {
  const person = await signedInApi(idp, role);
  const api: KnowledgeApi = person.api.knowledge;
  return { ...person, api };
};

const personal = (): CollectionInput => ({
  name: `Notes ${unique()}`,
  access: "me",
});

const leaveV1 = [
  "---",
  "title: Leave policy",
  "description: Read when someone asks about leave.",
  "tags: [hr]",
  "review: 2027-03-01",
  "---",
  "# Leave",
  "Everyone gets leave. See [[handbook/expenses|expenses]].",
  "## Parental leave",
  "Sixteen weeks.",
].join("\n");

describe("collections", () => {
  it("that are personal are invisible to everyone but their owner", async () => {
    const owner = await knowledgeOf("user");
    const admin = await knowledgeOf("admin");
    const { id: collectionId } = await seed(owner).createCollection(personal());
    const { id } = await seed(owner).saveDocument({
      collectionId,
      path: "diary.md",
      text: "# Private",
      ifVersion: 0,
    });

    const attempts = await Promise.all([
      outcome(admin.api.listDocuments(collectionId)),
      outcome(admin.api.getDocument(id)),
      outcome(admin.api.getDocument(id, 1)),
      outcome(admin.api.history(id)),
      outcome(admin.api.backlinks(id)),
    ]);
    const listed = await admin.api.listCollections();
    expect({
      attempts,
      listed: listed.some((collection) => collection.id === collectionId),
    }).toStrictEqual({
      attempts: attempts.map(() => "knowledge.not_found"),
      listed: false,
    });
  });

  it("for teams are read by their members only", async () => {
    const admin = await knowledgeOf("admin");
    const member = await knowledgeOf("user");
    const outsider = await knowledgeOf("user");
    const teamId = await newTeam(admin, [member]);

    const collection = await seed(admin).createCollection({
      name: "Finance",
      access: "teams",
      teams: [teamId],
      sensitive: true,
    });
    const saved = await seed(member).saveDocument({
      collectionId: collection.id,
      path: "budget.md",
      text: "# Budget",
      ifVersion: 0,
    });

    const sees = async (api: KnowledgeApi) => {
      const listed = await api.listCollections();
      return listed.some(({ id }) => id === collection.id);
    };
    expect({
      // Its owner isn't in the team, and still sees it.
      ownerSees: await sees(admin.api),
      memberSees: await sees(member.api),
      outsiderSees: await sees(outsider.api),
      outsiderReads: await outcome(outsider.api.getDocument(saved.id)),
    }).toStrictEqual({
      ownerSees: true,
      memberSees: true,
      outsiderSees: false,
      outsiderReads: "knowledge.not_found",
    });
  });

  it("for everyone are read by all", async () => {
    const admin = await knowledgeOf("admin");
    const otherAdmin = await knowledgeOf("admin");
    const person = await knowledgeOf("user");
    const { id: collectionId } = await seed(admin).createCollection({
      name: "Handbook",
      description: "How we work.",
      access: "everyone",
    });
    const { id } = await seed(admin).saveDocument({
      collectionId,
      path: "leave.md",
      text: leaveV1,
      ifVersion: 0,
    });
    const read = await person.api.getDocument(id);
    const readByAdmin = await otherAdmin.api.getDocument(id);
    expect({
      read: read.title,
      otherAdmin: readByAdmin.title,
    }).toStrictEqual({
      read: "Leave policy",
      otherAdmin: "Leave policy",
    });
  });
});
