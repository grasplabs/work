import { projectPageSize } from "@grasp-os/shared/projects";
import type { ProjectItemRef } from "@grasp-os/shared/projects";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { addMember } from "../src/app-members.ts";
import {
  addProjectMember,
  fileItem,
  removeProject,
  removeProjectMember,
  unfileItem,
} from "../src/projects.ts";
import {
  deleteWorkflowResource,
  shareWorkflowResource,
} from "../src/workflow-resources.ts";
import { racingDb, release } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { newTeam } from "./knowledge.ts";
import {
  auditedDuring,
  callAuth,
  letSessionRecheckPass,
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";

// Projects (GRA-1458), over the session RPC the Projects pages use. From
// the ways it can fail: filing an item in a project giving its people
// access; someone in a project seeing, or counting, what wasn't shared
// with them; access outliving taking someone out of a project, an item
// out of it, or the project itself; a project, or its name, showing to
// someone not in it; someone sharing with a project they don't build;
// Grasp staff deciding whom a client's data reaches. And today's chat
// projects, which this replaces, are gone.

const idp = mockIdp();

const personApi = async (role: Role) => await signedInApi(idp, role);

type Person = Awaited<ReturnType<typeof personApi>>;

/** An independent workflow `owner` creates. */
const workflowOf = async (owner: Person): Promise<string> => {
  const created = await owner.api.workflowResources.create(
    `project-${unique()}`
  );
  return created.id;
};

/** A published App `owner` creates, with one screen. */
const appOf = async (owner: Person): Promise<string> => {
  const { id } = await owner.api.apps.create({ name: `Desk ${unique()}` });
  await release(owner, id, {
    "schema.ts": `import { defineSchema } from "@grasp-os/sdk";

export default defineSchema({});
`,
    "app.ts": `import { app } from "@grasp-os/sdk";

import schema from "./schema.ts";

export default app({
  name: "Desk",
  schema,
  access: { tables: {} },
  operations: {},
  internalOperations: {},
  screens: [],
  uses: [],
});
`,
    "screens/desk.tsx": "export default () => <p>Desk</p>;\n",
  });
  return id;
};

/** A project `owner` makes. */
const projectOf = async (owner: Person): Promise<string> => {
  const made = await owner.api.projects.create({
    name: `Sell & get paid ${unique()}`,
    description: "Quotes to cash",
    icon: "coins",
  });
  return made.id;
};

/** Whether `who` opens workflow `id`. */
const seesWorkflow = async (who: Person, id: string) =>
  await outcome(who.api.workflowResources.get(id));

describe("projects", { timeout: 120_000 }, () => {
  it("files an App and a workflow without sharing either: the project's people neither open nor count them", async () => {
    const owner = await personApi("builder");
    const ada = await personApi("user");
    const project = await projectOf(owner);
    await owner.api.projects.addMember(project, {
      type: "person",
      id: ada.userId,
      role: "user",
    });
    const [workflow, app] = await Promise.all([
      workflowOf(owner),
      appOf(owner),
    ]);

    const events = await auditedDuring(async () => {
      await owner.api.projects.file(project, {
        item: { type: "workflow", id: workflow },
      });
      await owner.api.projects.file(project, {
        item: { type: "app", id: app },
      });
    });
    const asOwner = await owner.api.projects.get(project);
    const asAda = await ada.api.projects.get(project);
    const listed = await ada.api.projects.list();

    expect({
      ownerItems: asOwner.items
        .map(({ type, sharedAs }) => ({ type, sharedAs }))
        .toSorted((one, other) => one.type.localeCompare(other.type)),
      adaItems: asAda.items,
      adaCounts: listed.find(({ id }) => id === project)?.counts,
      adaWorkflow: await seesWorkflow(ada, workflow),
      adaApp: await outcome(ada.api.apps.get(app)),
      filed: events
        .filter(({ action }) => action === "project.item.filed")
        .map(({ target, detail }) => ({ target, shared: detail.shared })),
    }).toStrictEqual({
      ownerItems: [
        { type: "app", sharedAs: null },
        { type: "workflow", sharedAs: null },
      ],
      adaItems: [],
      adaCounts: { apps: 0, workflows: 0, connections: 0 },
      adaWorkflow: "workflow.resource_unavailable",
      adaApp: "app.not_found",
      filed: [
        { target: { type: "project", id: project }, shared: false },
        { target: { type: "project", id: project }, shared: false },
      ],
    });
  });

  it("shares through the project's row with everyone in it, as a person or through a team, and names the row only to them", async () => {
    const admin = await personApi("admin");
    const owner = await personApi("builder");
    const [ada, teammate, outsider] = await Promise.all([
      personApi("user"),
      personApi("user"),
      personApi("user"),
    ]);
    const team = await newTeam(admin, [teammate]);
    const project = await projectOf(owner);
    await owner.api.projects.addMember(project, {
      type: "person",
      id: ada.userId,
      role: "user",
    });
    await owner.api.projects.addMember(project, {
      type: "team",
      id: team,
      role: "user",
    });
    const [workflow, app] = await Promise.all([
      workflowOf(owner),
      appOf(owner),
    ]);
    await owner.api.projects.file(project, {
      item: { type: "workflow", id: workflow },
      share: true,
    });
    await owner.api.projects.file(project, {
      item: { type: "app", id: app },
      share: true,
    });
    // Shared with the outsider directly, who isn't in the project.
    await owner.api.workflowResources.share(workflow, {
      type: "person",
      id: outsider.userId,
      role: "user",
    });
    const { name } = await owner.api.projects.get(project);
    const projectRow = async (who: Person) => {
      const members = await who.api.workflowResources.members(workflow);
      return members
        .filter(({ type }) => type === "project")
        .map(({ id, projectName, role }) => ({ id, projectName, role }));
    };
    const appRow = async (who: Person) => {
      const members = await who.api.apps.members.list(app);
      return members
        .filter(({ type }) => type === "project")
        .map(({ id, name: named, role }) => ({ id, name: named, role }));
    };
    const adaPage = await ada.api.projects.get(project);
    const ownerPage = await owner.api.projects.get(project);

    expect({
      ada: await seesWorkflow(ada, workflow),
      teammate: await seesWorkflow(teammate, workflow),
      adaApp: await outcome(ada.api.apps.get(app)),
      teammateApp: await outcome(teammate.api.apps.get(app)),
      adaPage: adaPage.items
        .map(({ type, sharedAs, builds }) => ({ type, sharedAs, builds }))
        .toSorted((one, other) => one.type.localeCompare(other.type)),
      people: ownerPage.people,
      rowForAda: await projectRow(ada),
      rowForOutsider: await projectRow(outsider),
      appRowForTeammate: await appRow(teammate),
    }).toStrictEqual({
      ada: "ok",
      teammate: "ok",
      adaApp: "ok",
      teammateApp: "ok",
      adaPage: [
        { type: "app", sharedAs: "user", builds: false },
        { type: "workflow", sharedAs: "user", builds: false },
      ],
      // Its owner, Ada and the teammate.
      people: 3,
      rowForAda: [{ id: project, projectName: name, role: "user" }],
      rowForOutsider: [{ id: project, projectName: null, role: "user" }],
      appRowForTeammate: [{ id: project, name, role: "user" }],
    });
  });

  it("takes access away with the person, the item and the project, and keeps the items", async () => {
    const owner = await personApi("builder");
    const [ada, ben] = await Promise.all([
      personApi("user"),
      personApi("user"),
    ]);
    const project = await projectOf(owner);
    for (const person of [ada, ben]) {
      // oxlint-disable-next-line no-await-in-loop -- one member at a time
      await owner.api.projects.addMember(project, {
        type: "person",
        id: person.userId,
        role: "user",
      });
    }
    const [first, second, app] = await Promise.all([
      workflowOf(owner),
      workflowOf(owner),
      appOf(owner),
    ]);
    const items: ProjectItemRef[] = [
      { type: "workflow", id: first },
      { type: "workflow", id: second },
      { type: "app", id: app },
    ];
    for (const item of items) {
      // oxlint-disable-next-line no-await-in-loop -- one item at a time
      await owner.api.projects.file(project, { item, share: true });
    }
    const before = {
      ada: await seesWorkflow(ada, first),
      ben: await seesWorkflow(ben, first),
    };

    await owner.api.projects.removeMember(project, {
      type: "person",
      id: ada.userId,
    });
    const adaTakenOut = {
      ada: await seesWorkflow(ada, first),
      adaProject: await outcome(ada.api.projects.get(project)),
      ben: await seesWorkflow(ben, first),
    };

    await owner.api.projects.unfile(project, { type: "workflow", id: first });
    const firstShares = await owner.api.workflowResources.members(first);
    const firstTakenOut = {
      ben: await seesWorkflow(ben, first),
      benSecond: await seesWorkflow(ben, second),
      shares: firstShares.length,
    };

    await owner.api.projects.remove(project);
    const appShares = await owner.api.apps.members.list(app);
    const deleted = {
      benSecond: await seesWorkflow(ben, second),
      benApp: await outcome(ben.api.apps.get(app)),
      benProject: await outcome(ben.api.projects.get(project)),
      ownerSecond: await seesWorkflow(owner, second),
      ownerApp: await outcome(owner.api.apps.get(app)),
      appShares: appShares.length,
    };

    expect({ before, adaTakenOut, firstTakenOut, deleted }).toStrictEqual({
      before: { ada: "ok", ben: "ok" },
      adaTakenOut: {
        ada: "workflow.resource_unavailable",
        adaProject: "project.not_found",
        ben: "ok",
      },
      firstTakenOut: {
        ben: "workflow.resource_unavailable",
        benSecond: "ok",
        shares: 0,
      },
      deleted: {
        benSecond: "workflow.resource_unavailable",
        benApp: "app.not_found",
        benProject: "project.not_found",
        ownerSecond: "ok",
        ownerApp: "ok",
        appShares: 0,
      },
    });
  });

  it("is not there for anyone not in it, and only its builders change it or share with it", async () => {
    const owner = await personApi("builder");
    const [stranger, member] = await Promise.all([
      personApi("builder"),
      personApi("builder"),
    ]);
    const project = await projectOf(owner);
    await owner.api.projects.addMember(project, {
      type: "person",
      id: member.userId,
      role: "user",
    });
    const theirs = await workflowOf(member);
    const ownersOnly = await workflowOf(owner);
    const { core: staffCore } = await openRpc(
      await signedIn(idp, "grasp-staff", staffPerson())
    );
    const staff = staffCore.authenticate();
    const strangersList = await stranger.api.projects.list();
    const strangersOffer = await stranger.api.workflowResources.shareCandidates(
      await workflowOf(stranger)
    );

    expect({
      strangerList: strangersList.some(({ id }) => id === project),
      strangerGet: await outcome(stranger.api.projects.get(project)),
      strangerRename: await outcome(
        stranger.api.projects.update(project, { name: "Mine" })
      ),
      strangerDelete: await outcome(stranger.api.projects.remove(project)),
      // Sharing an item of their own with someone else's project.
      strangerShares: await outcome(
        stranger.api.workflowResources.share(await workflowOf(stranger), {
          type: "project",
          id: project,
          role: "user",
        })
      ),
      strangerCandidates: strangersOffer.projects.some(
        ({ id }) => id === project
      ),
      // In it as a user: sees it, changes nothing, shares nothing with it.
      memberGet: await outcome(member.api.projects.get(project)),
      memberFiles: await outcome(
        member.api.projects.file(project, {
          item: { type: "workflow", id: theirs },
        })
      ),
      memberShares: await outcome(
        member.api.workflowResources.share(theirs, {
          type: "project",
          id: project,
          role: "user",
        })
      ),
      memberAdds: await outcome(
        member.api.projects.addMember(project, {
          type: "person",
          id: stranger.userId,
          role: "user",
        })
      ),
      // Its builder files only what they open themselves.
      ownerFilesUnseen: await outcome(
        owner.api.projects.file(project, {
          item: { type: "workflow", id: theirs },
        })
      ),
      ownerAddsBuilder: await outcome(
        owner.api.projects.addMember(project, {
          type: "person",
          id: stranger.userId,
          role: "builder",
        })
      ),
      staffCreates: await outcome(staff.projects.create({ name: "Staff's" })),
      ownerFiles: await outcome(
        owner.api.projects.file(project, {
          item: { type: "workflow", id: ownersOnly },
        })
      ),
    }).toStrictEqual({
      strangerList: false,
      strangerGet: "project.not_found",
      strangerRename: "project.not_found",
      strangerDelete: "project.not_found",
      strangerShares: "project.not_found",
      strangerCandidates: false,
      memberGet: "ok",
      memberFiles: "role.forbidden",
      memberShares: "role.forbidden",
      memberAdds: "role.forbidden",
      ownerFilesUnseen: "workflow.resource_unavailable",
      // A builder of the organization, so a builder of the project is fine.
      ownerAddsBuilder: "ok",
      staffCreates: "role.forbidden",
      ownerFiles: "ok",
    });
  });

  it("is made and built only by whom the organization lets build, its owner included", async () => {
    const user = await personApi("user");
    const owner = await personApi("builder");
    const ada = await personApi("user");
    const project = await projectOf(owner);
    const workflow = await workflowOf(owner);
    await owner.api.projects.addMember(project, {
      type: "person",
      id: ada.userId,
      role: "user",
    });
    await owner.api.projects.file(project, {
      item: { type: "workflow", id: workflow },
      share: true,
    });

    const userMakes = await outcome(user.api.projects.create({ name: "Mine" }));
    // The owner is made a user of the organization: they no longer build
    // the project, nor decide who is in it.
    await env.DB.prepare(
      "UPDATE members SET role = 'user' WHERE user_id = ? AND organization_id = 'organization'"
    )
      .bind(owner.userId)
      .run();
    using _recheck = letSessionRecheckPass();
    const demoted = await owner.api.projects.get(project);
    const listed = await owner.api.projects.list();

    expect({
      userMakes,
      role: demoted.role,
      listedRole: listed.find(({ id }) => id === project)?.role,
      adds: await outcome(
        owner.api.projects.addMember(project, {
          type: "person",
          id: user.userId,
          role: "user",
        })
      ),
      takesOut: await outcome(
        owner.api.projects.removeMember(project, {
          type: "person",
          id: ada.userId,
        })
      ),
      deletes: await outcome(owner.api.projects.remove(project)),
      adaStillSees: await seesWorkflow(ada, workflow),
    }).toStrictEqual({
      userMakes: "role.forbidden",
      role: "user",
      listedRole: "user",
      adds: "role.forbidden",
      takesOut: "role.forbidden",
      deletes: "role.forbidden",
      adaStillSees: "ok",
    });
  });

  it("lists what is shared with it though never filed, so its builders see what being in it gives", async () => {
    const owner = await personApi("builder");
    const ada = await personApi("user");
    const project = await projectOf(owner);
    await owner.api.projects.addMember(project, {
      type: "person",
      id: ada.userId,
      role: "user",
    });
    const workflow = await workflowOf(owner);
    // Shared from the workflow's own Share dialog, never filed.
    await owner.api.workflowResources.share(workflow, {
      type: "project",
      id: project,
      role: "user",
    });
    const page = await owner.api.projects.get(project);
    const candidates = await owner.api.projects.itemCandidates(project);

    expect({
      items: page.items.map(({ id, sharedAs }) => ({ id, sharedAs })),
      workflows: page.counts.workflows,
      offeredAgain: candidates.some(({ id }) => id === workflow),
      adaSees: await seesWorkflow(ada, workflow),
    }).toStrictEqual({
      items: [{ id: workflow, sharedAs: "user" }],
      workflows: 1,
      offeredAgain: false,
      adaSees: "ok",
    });
  });

  it("takes away what a project gave someone once they leave the team in it", async () => {
    const admin = await personApi("admin");
    const owner = await personApi("builder");
    const teammate = await personApi("user");
    const team = await newTeam(admin, [teammate]);
    const project = await projectOf(owner);
    await owner.api.projects.addMember(project, {
      type: "team",
      id: team,
      role: "user",
    });
    const workflow = await workflowOf(owner);
    await owner.api.projects.file(project, {
      item: { type: "workflow", id: workflow },
      share: true,
    });
    const before = await seesWorkflow(teammate, workflow);

    await callAuth("/organization/remove-team-member", admin.session, {
      teamId: team,
      userId: teammate.userId,
    });
    using _recheck = letSessionRecheckPass();

    expect({
      before,
      after: await seesWorkflow(teammate, workflow),
      project: await outcome(teammate.api.projects.get(project)),
    }).toStrictEqual({
      before: "ok",
      after: "workflow.resource_unavailable",
      project: "project.not_found",
    });
  });

  it("takes items and people past what a project once held at most, however they are added", async () => {
    const owner = await personApi("builder");
    const ada = await personApi("user");
    const project = await projectOf(owner);
    const [filedOne, sharedOne] = await Promise.all([
      workflowOf(owner),
      workflowOf(owner),
    ]);
    // Seeded up to the old limits of 200 items and 100 people: the adds
    // below go past them.
    const now = Date.now();
    await env.DB.batch([
      ...Array.from({ length: 200 }, () =>
        env.DB.prepare(
          "INSERT INTO project_items (project_id, item_type, item_id, added_by, added_at) VALUES (?, 'workflow', ?, ?, ?)"
        ).bind(project, crypto.randomUUID(), owner.userId, now)
      ),
      // People of the organization, as the old limit counted them.
      ...Array.from({ length: 100 }, () => crypto.randomUUID()).flatMap(
        (person) => [
          env.DB.prepare(
            "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, 'Person', ?, 1, ?, ?)"
          ).bind(person, `${person}@acme.test`, now, now),
          env.DB.prepare(
            "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, 'organization', ?, 'user', ?)"
          ).bind(crypto.randomUUID(), person, now),
          env.DB.prepare(
            "INSERT INTO project_members (project_id, member_type, member_id, role, added_by, added_at) VALUES (?, 'person', ?, 'user', ?, ?)"
          ).bind(project, person, owner.userId, now),
        ]
      ),
    ]);

    expect({
      files: await outcome(
        owner.api.projects.file(project, {
          item: { type: "workflow", id: filedOne },
        })
      ),
      sharesFromItsDialog: await outcome(
        owner.api.workflowResources.share(sharedOne, {
          type: "project",
          id: project,
          role: "user",
        })
      ),
      adds: await outcome(
        owner.api.projects.addMember(project, {
          type: "person",
          id: ada.userId,
          role: "user",
        })
      ),
      shared: await seesWorkflow(ada, sharedOne),
    }).toStrictEqual({
      files: "ok",
      sharesFromItsDialog: "ok",
      adds: "ok",
      shared: "ok",
    });
  });

  it("answers that the project is gone when it is deleted while someone is added or something filed", async () => {
    const owner = await personApi("builder");
    const ada = await personApi("user");
    const by = await owner.api.whoami();
    const [forAdding, forFiling] = await Promise.all([
      projectOf(owner),
      projectOf(owner),
    ]);
    const workflow = await workflowOf(owner);
    // Each deleted right before the write's batch runs.
    const deletedFirst = (project: string, writes: RegExp) => ({
      ...env,
      DB: racingDb(async () => {
        await removeProject(env, by, project);
      }, writes),
    });

    expect({
      adding: await outcome(
        addProjectMember(
          deletedFirst(forAdding, /insert into "project_members"/u),
          by,
          forAdding,
          { type: "person", id: ada.userId, role: "user" }
        )
      ),
      filing: await outcome(
        fileItem(
          deletedFirst(forFiling, /insert into "project_items"/u),
          by,
          forFiling,
          { item: { type: "workflow", id: workflow } }
        )
      ),
    }).toStrictEqual({
      adding: "project.not_found",
      filing: "project.not_found",
    });
  });

  it("changes nothing for a builder taken out of the project while their call was under way", async () => {
    const owner = await personApi("builder");
    const [bob, ada] = await Promise.all([
      personApi("builder"),
      personApi("user"),
    ]);
    const project = await projectOf(owner);
    await owner.api.projects.addMember(project, {
      type: "person",
      id: bob.userId,
      role: "builder",
    });
    const workflow = await workflowOf(owner);
    await owner.api.projects.file(project, {
      item: { type: "workflow", id: workflow },
      share: true,
    });
    const [bobsWorkflow, bobsApp] = await Promise.all([
      workflowOf(bob),
      bob.api.apps.create({ name: `Desk ${unique()}` }),
    ]);
    const asBob = await bob.api.whoami();
    const toProject = { type: "project", id: project, role: "user" } as const;
    /** Core's env, Bob taken out of the project right before `writes` run. */
    const takenOutFirst = (writes: RegExp) => ({
      ...env,
      DB: racingDb(async () => {
        await removeProjectMember(env, await owner.api.whoami(), project, {
          type: "person",
          id: bob.userId,
        });
        await addProjectMember(env, await owner.api.whoami(), project, {
          type: "person",
          id: bob.userId,
          role: "user",
        });
      }, writes),
    });

    const addsHimself = await outcome(
      addProjectMember(
        takenOutFirst(/insert into "project_members"/u),
        asBob,
        project,
        { type: "person", id: ada.userId, role: "user" }
      )
    );
    await owner.api.projects.addMember(project, {
      type: "person",
      id: bob.userId,
      role: "builder",
    });
    const deletes = await outcome(
      removeProject(
        takenOutFirst(/update "projects" set "name"/u),
        asBob,
        project
      )
    );
    await owner.api.projects.addMember(project, {
      type: "person",
      id: bob.userId,
      role: "builder",
    });
    const unfiles = await outcome(
      unfileItem(
        takenOutFirst(/update "projects" set "name"/u),
        asBob,
        project,
        { type: "workflow", id: workflow }
      )
    );
    // From his own App's and workflow's Share dialogs, each checked again
    // in the share's own write.
    await owner.api.projects.addMember(project, {
      type: "person",
      id: bob.userId,
      role: "builder",
    });
    const sharesApp = await outcome(
      addMember(
        takenOutFirst(/insert into "app_members"/u),
        asBob,
        bobsApp.id,
        toProject
      )
    );
    await owner.api.projects.addMember(project, {
      type: "person",
      id: bob.userId,
      role: "builder",
    });
    const sharesWorkflow = await outcome(
      shareWorkflowResource(
        takenOutFirst(/insert into "workflow_resource_members"/u),
        asBob,
        bobsWorkflow,
        toProject
      )
    );
    const page = await owner.api.projects.get(project);
    const [appShares, workflowShares] = await Promise.all([
      bob.api.apps.members.list(bobsApp.id),
      bob.api.workflowResources.members(bobsWorkflow),
    ]);

    expect({
      addsHimself,
      deletes,
      unfiles,
      sharesApp,
      sharesWorkflow,
      sharedWithProject: [...appShares, ...workflowShares].filter(
        ({ type }) => type === "project"
      ).length,
      adaIn: page.members.some(({ id }) => id === ada.userId),
      bobsRole: page.members.find(({ id }) => id === bob.userId)?.role,
      stillShared: page.items.map(({ id, sharedAs }) => ({ id, sharedAs })),
    }).toStrictEqual({
      addsHimself: "role.forbidden",
      deletes: "role.forbidden",
      unfiles: "role.forbidden",
      sharesApp: "role.forbidden",
      sharesWorkflow: "role.forbidden",
      sharedWithProject: 0,
      adaIn: false,
      bobsRole: "user",
      stillShared: [{ id: workflow, sharedAs: "user" }],
    });
  });

  it("files nothing that is deleted while it is filed", async () => {
    const owner = await personApi("builder");
    const by = await owner.api.whoami();
    const project = await projectOf(owner);
    const workflow = await workflowOf(owner);

    const filing = await outcome(
      fileItem(
        {
          ...env,
          DB: racingDb(async () => {
            await deleteWorkflowResource(env, by, workflow);
          }, /insert into "project_items"/u),
        },
        by,
        project,
        { item: { type: "workflow", id: workflow } }
      )
    );
    const held = await env.DB.prepare(
      "SELECT count(*) AS count FROM project_items WHERE project_id = ?"
    )
      .bind(project)
      .first<{ count: number }>();

    expect({ filing, held: held?.count }).toStrictEqual({
      filing: "project.item_not_found",
      held: 0,
    });
  });

  it("records a project's deletion once, by whom, with how many items and people it held", async () => {
    const owner = await personApi("builder");
    const [ada, ben] = await Promise.all([
      personApi("user"),
      personApi("user"),
    ]);
    const project = await projectOf(owner);
    for (const person of [ada, ben]) {
      // oxlint-disable-next-line no-await-in-loop -- one member at a time
      await owner.api.projects.addMember(project, {
        type: "person",
        id: person.userId,
        role: "user",
      });
    }
    const [shared, filed, app] = await Promise.all([
      workflowOf(owner),
      workflowOf(owner),
      owner.api.apps.create({ name: `Desk ${unique()}` }),
    ]);
    await owner.api.projects.file(project, {
      item: { type: "workflow", id: shared },
      share: true,
    });
    await owner.api.projects.file(project, {
      item: { type: "workflow", id: filed },
    });
    await owner.api.projects.file(project, {
      item: { type: "app", id: app.id },
      share: true,
    });

    const events = await auditedDuring(async () => {
      await owner.api.projects.remove(project);
    });
    const sharesLeft = await owner.api.workflowResources.members(shared);

    expect({
      recorded: events.map(({ action, actor, target, detail }) => ({
        action,
        actor,
        target,
        detail,
      })),
      sharesLeft: sharesLeft.length,
    }).toStrictEqual({
      recorded: [
        {
          action: "project.deleted",
          actor: { type: "person", userId: owner.userId },
          target: { type: "project", id: project },
          detail: { items: 3, members: 2 },
        },
      ],
      sharesLeft: 0,
    });
  });

  it("lists a project bigger than one page in pages, and counts it whole", async () => {
    const owner = await personApi("builder");
    const project = await projectOf(owner);
    const workflows = await Promise.all(
      Array.from(
        { length: projectPageSize + 1 },
        async () => await workflowOf(owner)
      )
    );
    const people = Array.from({ length: projectPageSize + 1 }, () =>
      crypto.randomUUID()
    );
    // Filed and added one after another, so the pages' order is theirs.
    const now = Date.now();
    await env.DB.batch([
      ...workflows.map((id, index) =>
        env.DB.prepare(
          "INSERT INTO project_items (project_id, item_type, item_id, added_by, added_at) VALUES (?, 'workflow', ?, ?, ?)"
        ).bind(project, id, owner.userId, now + index)
      ),
      ...people.flatMap((person, index) => [
        env.DB.prepare(
          "INSERT INTO users (id, name, email, email_verified, created_at, updated_at) VALUES (?, 'Person', ?, 1, ?, ?)"
        ).bind(person, `${person}@acme.test`, now, now),
        env.DB.prepare(
          "INSERT INTO members (id, organization_id, user_id, role, created_at) VALUES (?, 'organization', ?, 'user', ?)"
        ).bind(crypto.randomUUID(), person, now),
        env.DB.prepare(
          "INSERT INTO project_members (project_id, member_type, member_id, role, added_by, added_at) VALUES (?, 'person', ?, 'user', ?, ?)"
        ).bind(project, person, owner.userId, now + index),
      ]),
    ]);

    const first = await owner.api.projects.get(project);
    const lastItem = first.items.at(-1);
    const lastMember = first.members.at(-1);
    if (lastItem === undefined || lastMember === undefined) {
      throw new Error("The first page holds nothing");
    }
    const nextItems = await owner.api.projects.items(project, {
      at: lastItem.addedAt,
      type: lastItem.type,
      id: lastItem.id,
    });
    const nextMembers = await owner.api.projects.members(project, {
      at: lastMember.addedAt,
      type: lastMember.type,
      id: lastMember.id,
    });
    const listed = await owner.api.projects.list();

    expect({
      items: [...first.items, ...nextItems.items].map(({ id }) => id),
      itemPages: [first.items.length, first.moreItems, nextItems.more],
      members: [...first.members, ...nextMembers.members].map(({ id }) => id),
      memberPages: [first.members.length, first.moreMembers, nextMembers.more],
      people: first.people,
      counted: first.counts.workflows,
      listedCount: listed.find(({ id }) => id === project)?.counts.workflows,
    }).toStrictEqual({
      items: workflows,
      itemPages: [projectPageSize, true, false],
      members: people,
      memberPages: [projectPageSize, true, false],
      people: projectPageSize + 2,
      counted: projectPageSize + 1,
      listedCount: projectPageSize + 1,
    });
  });
});
