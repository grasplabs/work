import type { Role } from "@grasp-os/shared/roles";
import { describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import { newTeam } from "./knowledge.ts";
import {
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";

// Sharing an independent workflow from its page (GRA-1304), over the
// session RPC its Share dialog uses: whom it may be shared with, sharing
// it, and unsharing it. From the ways it can fail: someone who may not
// share it learning who is in the organization, or that it exists; a
// share by someone who may not share; a share saying more of a person
// than their name; a person or team keeping access once unshared.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);

type Person = Awaited<ReturnType<typeof personApi>>;

/** A workflow `owner` creates. */
const workflowOf = async (owner: Person): Promise<string> => {
  const created = await owner.api.workflowResources.create(
    `shared-${unique()}`
  );
  return created.id;
};

/** Grasp staff, signed in, through the RPC. */
const staffApi = async () => {
  const { core } = await openRpc(
    await signedIn(idp, "grasp-staff", staffPerson())
  );
  return await core.authenticate();
};

describe("sharing an independent workflow", { timeout: 60_000 }, () => {
  it("offers whoever may share it the organization's people and teams, by name alone, and nobody else", async () => {
    const admin = await personApi("admin");
    // A builder, not an admin: the owner this is for.
    const owner = await personApi("builder");
    const [colleague, user, stranger] = await Promise.all([
      personApi("user"),
      personApi("user"),
      personApi("builder"),
    ]);
    const team = await newTeam(admin, [colleague]);
    const workflow = await workflowOf(owner);
    await owner.api.workflowResources.share(workflow, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    const staff = await staffApi();

    const offered = await owner.api.workflowResources.shareCandidates(workflow);
    const person = offered.people.find(({ id }) => id === colleague.userId);
    const offeredTeam = offered.teams.find(({ id }) => id === team);

    expect({
      // Its name and ID, and nothing more: no address, no role, no members.
      person: person === undefined ? null : Object.keys(person).toSorted(),
      team:
        offeredTeam === undefined ? null : Object.keys(offeredTeam).toSorted(),
      // Shared with as a user, who may not share it on.
      byUser: await outcome(
        user.api.workflowResources.shareCandidates(workflow)
      ),
      // Without a role in it: told it doesn't exist.
      byStranger: await outcome(
        stranger.api.workflowResources.shareCandidates(workflow)
      ),
      byStaff: await outcome(staff.workflowResources.shareCandidates(workflow)),
    }).toStrictEqual({
      person: ["id", "name"],
      team: ["id", "name"],
      byUser: "role.forbidden",
      byStranger: "workflow.resource_unavailable",
      byStaff: "role.forbidden",
    });
  });

  it("lets a builder who isn't an admin share it with a person and a team, who then see it, until it is unshared", async () => {
    const admin = await personApi("admin");
    const owner = await personApi("builder");
    const [ada, teammate, outsider] = await Promise.all([
      personApi("user"),
      personApi("user"),
      personApi("user"),
    ]);
    const team = await newTeam(admin, [teammate]);
    const workflow = await workflowOf(owner);
    const sees = async (who: Person) =>
      await outcome(who.api.workflowResources.get(workflow));

    const before = { ada: await sees(ada), teammate: await sees(teammate) };
    await owner.api.workflowResources.share(workflow, {
      type: "person",
      id: ada.userId,
      role: "user",
    });
    await owner.api.workflowResources.share(workflow, {
      type: "team",
      id: team,
      role: "user",
    });
    const listed = await ada.api.workflowResources.members(workflow);
    const shared = {
      ada: await sees(ada),
      teammate: await sees(teammate),
      outsider: await sees(outsider),
      members: listed.map(({ type, id, role }) => ({ type, id, role })),
      // A user of it shares it with nobody.
      shareOn: await outcome(
        ada.api.workflowResources.share(workflow, {
          type: "person",
          id: outsider.userId,
          role: "user",
        })
      ),
      // Nobody without a builder's organization role builds it.
      asBuilder: await outcome(
        owner.api.workflowResources.share(workflow, {
          type: "person",
          id: outsider.userId,
          role: "builder",
        })
      ),
    };
    await owner.api.workflowResources.unshare(workflow, {
      type: "person",
      id: ada.userId,
    });
    await owner.api.workflowResources.unshare(workflow, {
      type: "team",
      id: team,
    });

    expect({
      before,
      shared,
      after: { ada: await sees(ada), teammate: await sees(teammate) },
    }).toStrictEqual({
      before: {
        ada: "workflow.resource_unavailable",
        teammate: "workflow.resource_unavailable",
      },
      shared: {
        ada: "ok",
        teammate: "ok",
        outsider: "workflow.resource_unavailable",
        members: [
          { type: "person", id: ada.userId, role: "user" },
          { type: "team", id: team, role: "user" },
        ],
        shareOn: "role.forbidden",
        asBuilder: "workflow.resource_invalid",
      },
      after: {
        ada: "workflow.resource_unavailable",
        teammate: "workflow.resource_unavailable",
      },
    });
  });
});
