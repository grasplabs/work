import { appIdSchema, workflowIdSchema } from "@grasp-os/shared/ids";
import type { Role } from "@grasp-os/shared/roles";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { startRun } from "../src/workflows/runs.ts";
import { release } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { finished } from "./runs.ts";
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

// A workflow's owner: who answers for it, shown on its line and told when
// a run a trigger started fails. What could go wrong: someone without the
// right changes it (a user of the App, a builder of another App, Grasp
// staff), it's set to someone outside the organization, the change goes
// unrecorded, it's lost with a new version, or it changes whom a run acts
// for, which stays the App's owner for a trigger's run.

const idp = mockIdp();

/** Signing people in and building Apps can be slow on CI. */
const slow = { timeout: 60_000 };

const personApi = async (role: Role) => await signedInApi(idp, role);
type Person = Awaited<ReturnType<typeof personApi>>;

/** The owner and whether `person` may change it, of each of `app`'s workflows. */
const ownersFor = async (person: Person, app: string) => {
  const all = await person.api.workflows.overview();
  return all
    .filter((summary) => summary.app === app)
    .map(({ workflow, owner, changesOwner }) => ({
      workflow,
      owner: owner.userId,
      changesOwner,
    }));
};

/** A workflow that fails in its one step. */
const failing = (id: string) =>
  workflowFiles(
    id,
    `  await step.do("check", { description: "Check" }, async () => {
    throw new Error("Blocked");
  });`,
    { check: null }
  );

/** A workflow that returns whom the App's server sees it call for. */
const whoAmI = (id: string) =>
  workflowFiles(
    id,
    `  return await step.do("who", { description: "Book" }, async () => await env.APP.call("book", { invoice: "INV-1", total: 1 }, "key"));`,
    { who: "ledger" }
  );

/** Starts a run of `workflow` as a trigger does, and waits for it to end. */
const triggered = async (app: string, workflow: string): Promise<string> => {
  const run = await startRun(env, {
    app: appIdSchema.parse(app),
    workflow: workflowIdSchema.parse(workflow),
    input: undefined,
    startedBy: null,
    actor: { type: "system" },
  });
  await finished(run.id);
  return run.id;
};

describe("a workflow's owner", slow, () => {
  it("is the App's owner until an admin or a builder of the App sets another member, audited", async () => {
    const [owner, builder, user, outsider, admin, removed] = await Promise.all([
      personApi("builder"),
      personApi("builder"),
      personApi("user"),
      personApi("builder"),
      personApi("admin"),
      personApi("user"),
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
      id: builder.userId,
      role: "builder",
    });
    await owner.api.apps.members.add(app, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    await admin.api.members.remove(removed.userId);

    const before = {
      owner: await ownersFor(owner, app),
      user: await ownersFor(user, app),
    };
    const audited = await auditedDuring(
      async () =>
        await builder.api.workflows.setOwner(app, "chase", user.userId)
    );
    const refused = {
      user: await outcome(
        user.api.workflows.setOwner(app, "remind", user.userId)
      ),
      outsider: await outcome(
        outsider.api.workflows.setOwner(app, "remind", outsider.userId)
      ),
      staff: await outcome(
        staff.workflows.setOwner(app, "remind", owner.userId)
      ),
      // A member who can't open the App: they'd never see its notices.
      noAccess: await outcome(
        owner.api.workflows.setOwner(app, "remind", outsider.userId)
      ),
      removed: await outcome(
        owner.api.workflows.setOwner(app, "remind", removed.userId)
      ),
      nobody: await outcome(
        owner.api.workflows.setOwner(app, "remind", `user-${unique()}`)
      ),
      unknownWorkflow: await outcome(
        owner.api.workflows.setOwner(app, "missing", user.userId)
      ),
    };
    const byAdmin = await admin.api.workflows.setOwner(
      app,
      "remind",
      builder.userId
    );
    // Each change names the owner it replaced.
    const again = await auditedDuring(
      async () =>
        await owner.api.workflows.setOwner(app, "chase", builder.userId)
    );
    // A new version keeps who owns each workflow.
    await release(owner, app, workflowFiles("pay", "  return 1;"));
    const { summary } = await user.api.workflows.get(app, "chase");
    const asStaff = await staff.workflows.overview();

    expect({
      before,
      audited: [...audited, ...again].map(
        ({ action, actor, target, detail }) => ({
          action,
          actor,
          target,
          detail,
        })
      ),
      refused,
      byAdmin: {
        owner: byAdmin.owner,
        changesOwner: byAdmin.changesOwner,
      },
      after: await ownersFor(owner, app),
      asStaff: asStaff
        .filter((listed) => listed.app === app)
        .map(({ changesOwner }) => changesOwner),
      detail: { owner: summary.owner, changesOwner: summary.changesOwner },
    }).toStrictEqual({
      before: {
        owner: [
          { workflow: "chase", owner: owner.userId, changesOwner: true },
          { workflow: "remind", owner: owner.userId, changesOwner: true },
        ],
        user: [
          { workflow: "chase", owner: owner.userId, changesOwner: false },
          { workflow: "remind", owner: owner.userId, changesOwner: false },
        ],
      },
      audited: [
        {
          action: "workflow.owner.updated",
          actor: { type: "person", userId: builder.userId },
          target: { type: "app", id: app },
          detail: {
            workflow: "chase",
            owner: user.userId,
            previous: owner.userId,
          },
        },
        {
          action: "workflow.owner.updated",
          actor: { type: "person", userId: owner.userId },
          target: { type: "app", id: app },
          detail: {
            workflow: "chase",
            owner: builder.userId,
            previous: user.userId,
          },
        },
      ],
      refused: {
        user: "role.forbidden",
        outsider: "app.not_found",
        noAccess: "workflow.owner_invalid",
        staff: "role.forbidden",
        removed: "workflow.owner_invalid",
        nobody: "workflow.owner_invalid",
        unknownWorkflow: "workflow.not_found",
      },
      byAdmin: {
        owner: { userId: builder.userId, name: builder.person.name },
        changesOwner: true,
      },
      after: [
        { workflow: "chase", owner: builder.userId, changesOwner: true },
        { workflow: "pay", owner: owner.userId, changesOwner: true },
        { workflow: "remind", owner: builder.userId, changesOwner: true },
      ],
      asStaff: [false, false, false],
      detail: {
        owner: { userId: builder.userId, name: builder.person.name },
        changesOwner: false,
      },
    });
  });

  it("is told when a run a trigger started fails, while the run still acts for the App's owner", async () => {
    const [owner, answers] = await Promise.all([
      personApi("builder"),
      personApi("user"),
    ]);
    const app = await appWith(owner, {
      ...failing("careless"),
      ...whoAmI("booking"),
    });
    await owner.api.apps.members.add(app, {
      type: "person",
      id: answers.userId,
      role: "user",
    });
    await owner.api.workflows.setOwner(app, "careless", answers.userId);
    await owner.api.workflows.setOwner(app, "booking", answers.userId);

    const failed = await triggered(app, "careless");
    const booked = await triggered(app, "booking");
    // Once the owner can't open the App, its owner is told instead.
    await owner.api.apps.members.remove(app, {
      type: "person",
      id: answers.userId,
    });
    const unseen = await triggered(app, "careless");
    const { output } = await owner.api.workflows.status(booked);
    const events = await allEvents();
    const notified = events
      .filter(
        ({ action, target }) =>
          action === "workflow.run.notified" &&
          (target?.id === failed || target?.id === unseen)
      )
      .map(({ target, detail }) => [target?.id, detail.person]);
    const told = async (person: Person) => {
      const { notifications } = await person.api.notifications.list();
      return notifications
        .filter((notice) => notice.run === failed || notice.run === unseen)
        .map(({ run }) => run);
    };

    expect({
      notified,
      answers: await told(answers),
      owner: await told(owner),
      output,
    }).toStrictEqual({
      notified: [
        [failed, answers.userId],
        [unseen, owner.userId],
      ],
      answers: [],
      owner: [unseen],
      output: `ledger-INV-1-for-${owner.userId}`,
    });
  });
});
