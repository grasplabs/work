import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { release } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import {
  auditedDuring,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";
import { appWith, workflowFiles } from "./workflow-apps.ts";

// The team that owns a workflow (GRA-517): one of the organization's
// teams, whose work the workflow does, which the dashboard counts each
// team's workflows and what they handled by. What could go wrong: someone
// without the right sets it (a user of the App, a builder of another App,
// Grasp staff); it's set to a team that isn't the organization's, or to a
// workflow the App doesn't have; the change goes unrecorded; it's lost
// with a new version; a team that goes leaves its workflows pointing at
// nothing.

const idp = mockIdp();

/** Signing people in and building Apps can be slow on CI. */
const slow = { timeout: 60_000 };

const personApi = async (role: Role) => await signedInApi(idp, role);
type Person = Awaited<ReturnType<typeof personApi>>;

/** One of the organization's teams, named `name`: its ID. */
const team = async (name: string, organization = "organization") => {
  const id = `team-${unique()}`;
  if (organization !== "organization") {
    // Another organization in the same database, as a team's row may name.
    await env.DB.prepare(
      "INSERT INTO organizations (id, name, slug, created_at) VALUES (?, ?, ?, ?)"
    )
      .bind(organization, "Elsewhere", organization, Date.now())
      .run();
  }
  await env.DB.prepare(
    "INSERT INTO teams (id, name, organization_id, created_at) VALUES (?, ?, ?, ?)"
  )
    .bind(id, name, organization, Date.now())
    .run();
  return id;
};

/** The team of each of `app`'s workflows, as `person` lists them. */
const teamsFor = async (person: Person, app: string) => {
  const all = await person.api.workflows.overview();
  return all
    .filter((summary) => summary.app === app)
    .map(({ workflow, team: owning }) => [workflow, owning?.name ?? null]);
};

describe("the team that owns a workflow", slow, () => {
  it("is set by an admin or a builder of the App to one of the organization's teams, audited, and shown with the workflow", async () => {
    const [owner, user, outsider, admin] = await Promise.all([
      personApi("builder"),
      personApi("user"),
      personApi("builder"),
      personApi("admin"),
    ]);
    const { core } = await openRpc(
      await signedIn(idp, "grasp-staff", staffPerson())
    );
    const staff = core.authenticate();
    const app = await appWith(owner, {
      ...workflowFiles("chase", "  return 1;"),
      ...workflowFiles("remind", "  return 1;"),
    });
    await owner.api.apps.members.add(app, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    const [finance, sales, elsewhere] = await Promise.all([
      team("Finance"),
      team("Sales"),
      team("Elsewhere", `organization-${unique()}`),
    ]);

    const before = await teamsFor(user, app);
    const audited = await auditedDuring(async () => {
      await owner.api.workflows.setTeam(app, "chase", finance);
      await admin.api.workflows.setTeam(app, "chase", sales);
    });
    const summary = await owner.api.workflows.setTeam(app, "remind", finance);
    const refused = {
      user: await outcome(user.api.workflows.setTeam(app, "remind", sales)),
      outsider: await outcome(
        outsider.api.workflows.setTeam(app, "remind", sales)
      ),
      staff: await outcome(staff.workflows.setTeam(app, "remind", sales)),
      otherOrganization: await outcome(
        owner.api.workflows.setTeam(app, "remind", elsewhere)
      ),
      nobody: await outcome(
        owner.api.workflows.setTeam(app, "remind", `team-${unique()}`)
      ),
      unknownWorkflow: await outcome(
        owner.api.workflows.setTeam(app, "missing", sales)
      ),
    };
    const set = await teamsFor(user, app);
    // Taken off: the workflow has no team.
    await owner.api.workflows.setTeam(app, "chase", null);
    const takenOff = await teamsFor(owner, app);

    expect({
      before,
      summary: summary.team?.id,
      refused,
      set,
      takenOff,
      audited: audited
        .filter(({ action }) => action === "workflow.team.updated")
        .map(({ actor, detail }) => ({
          by: actor.type === "person" ? actor.userId : actor.type,
          ...detail,
        })),
    }).toStrictEqual({
      before: [
        ["chase", null],
        ["remind", null],
      ],
      summary: finance,
      refused: {
        user: "role.forbidden",
        outsider: "app.not_found",
        staff: "role.forbidden",
        otherOrganization: "workflow.team_invalid",
        nobody: "workflow.team_invalid",
        unknownWorkflow: "workflow.not_found",
      },
      set: [
        ["chase", "Sales"],
        ["remind", "Finance"],
      ],
      takenOff: [
        ["chase", null],
        ["remind", "Finance"],
      ],
      audited: [
        { by: owner.userId, workflow: "chase", team: finance, previous: null },
        { by: admin.userId, workflow: "chase", team: sales, previous: finance },
      ],
    });
  });

  it("holds across the App's versions, and goes with its team", async () => {
    const owner = await personApi("builder");
    const app = await appWith(owner, {
      ...workflowFiles("chase", "  return 1;"),
    });
    const finance = await team("Finance");
    await owner.api.workflows.setTeam(app, "chase", finance);
    // A new version of the same workflow keeps its team.
    await release(owner, app, workflowFiles("chase", "  return 2;"));
    const kept = await teamsFor(owner, app);
    await env.DB.prepare("DELETE FROM teams WHERE id = ?").bind(finance).run();
    expect({ kept, gone: await teamsFor(owner, app) }).toStrictEqual({
      kept: [["chase", "Finance"]],
      gone: [["chase", null]],
    });
  });
});
