import { appIdSchema, workflowIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { activateVersion } from "../src/app-activation.ts";
import { addMember } from "../src/app-members.ts";
import { changeStatus } from "../src/app-status.ts";
import { bindWorkflowToApp } from "../src/app-workflow-bindings.ts";
import {
  commitFiles,
  draftOverLatest,
  proposeDraft,
  proposeVersion,
} from "../src/apps.ts";
import { shareStore } from "../src/data-stores.ts";
import { cancelRunsOf } from "../src/workflows/controls.ts";
import { repairStarts, startRun } from "../src/workflows/runs.ts";
import { ordinaryData, racingDb } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { runCron } from "./cron.ts";
import { mockIdp } from "./idp.ts";
import { endLiveRuns, finished, sleeping, whileEngineRefuses } from "./runs.ts";
import { person as acting } from "./sealed-apps.ts";
import { outcome, signedInApi } from "./sign-in.ts";
import { sampleApp, workflowFiles } from "./workflow-apps.ts";

// An App is a draft, published or archived (app-status.ts). These tests
// start from the ways that can fail: someone who only uses an App reaching
// a draft or an archived one by any way in, or learning a draft exists;
// a trigger or a run outliving the archive; a transition by someone who
// lost their role, or one nobody audited; and an App restored straight
// back to the people who use it.

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

/** A weekly schedule, Mondays at 8:00, as its workflow declares it. */
const weekly = {
  "workflows/weekly.ts": `import { schedule, workflow } from "@grasp-os/sdk/workflow";

export default workflow(
  "weekly",
  { params: { every: schedule({ label: "Runs", default: "0 8 * * 1" }) }, triggers: [{ type: "schedule", param: "every", timeZone: "Europe/Amsterdam" }] },
  async (step) => await step.do("report", { description: "Write the report" }, async () => "sent")
);
`,
  "workflows/weekly.workflow-tests.ts": `import { workflowTests } from "@grasp-os/sdk/testing";

import definition from "./weekly.ts";

export default workflowTests(definition, [{ name: "runs", mocks: { report: "sent" }, expect: { output: "sent" } }]);
`,
};

/** A workflow that sleeps a day: a run that stays unfinished. */
const nap = workflowFiles(
  "nap",
  `  await step.sleep("rest", { description: "Rest", duration: "1 day" });
  return null;`
);

/**
 * A builder's App with a screen, a scheduled workflow and a sleeping one,
 * its first version current, left a draft; shared with `user` to use.
 */
const draftApp = async (builder: Person, user?: Person): Promise<string> => {
  const { id } = await builder.api.apps.create({ name: "Invoices" });
  const { version } = await builder.api.apps.files.commit(
    id,
    {
      ...sampleApp(),
      ...weekly,
      ...nap,
      "screens/desk.tsx": "export default () => null;\n",
    },
    "First version"
  );
  await builder.api.apps.versions.setCurrent(id, version);
  await ordinaryData(id);
  if (user !== undefined) {
    await builder.api.apps.members.add(id, {
      type: "person",
      id: user.userId,
      role: "user",
    });
  }
  return id;
};

/** When the App's schedule next fires, as core has it. */
const nextRunOf = async (app: string): Promise<Date> => {
  const row = await env.DB.prepare(
    "SELECT next_run_at FROM workflow_triggers WHERE app_id = ?"
  )
    .bind(app)
    .first<{ next_run_at: number }>();
  if (!row) {
    throw new Error(`App ${app} has no schedule`);
  }
  return new Date(row.next_run_at);
};

/** What `person` gets at each way into App `app`. */
const waysIn = async (person: Person, app: string) => {
  const [listed, overview] = await Promise.all([
    person.api.apps.list(),
    person.api.workflows.overview(),
  ]);
  return {
    get: await outcome(person.api.apps.get(app)),
    contents: await outcome(person.api.apps.contents(app)),
    exports: await outcome(person.api.apps.exports(app)),
    open: await outcome(person.api.screens.open(app, "desk")),
    version: await outcome(person.api.screens.version(app)),
    start: await outcome(person.api.workflows.start(app, "nap")),
    runs: await outcome(person.api.workflows.list(app)),
    listed: listed.some(({ id }) => id === app),
    overview: overview.some((summary) => summary.app === app),
  };
};

/** Every way in, as for an App that doesn't exist. */
const noSuchApp = {
  get: "app.not_found",
  contents: "app.not_found",
  exports: "app.not_found",
  open: "app.not_found",
  version: "app.not_found",
  start: "app.not_found",
  runs: "app.not_found",
  listed: false,
  overview: false,
};

/**
 * A start core stopped in the middle of, never sent to the engine: a
 * trigger's (no person) or a person's, written ten minutes ago.
 */
const orphan = async (app: string, startedBy: string | null) => {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO workflow_runs (id, app_id, workflow_id, version, started_by, status, created_at, trigger_key, pending_start) VALUES (?, ?, 'nap', 1, ?, 'starting', ?, ?, '{}')"
  )
    .bind(
      id,
      app,
      startedBy,
      Date.now() - 600_000,
      startedBy === null ? `schedule:${id}` : null
    )
    .run();
  return id;
};

/** A run's status as its row has it. */
const statusOf = async (run: string) =>
  await env.DB.prepare("SELECT status FROM workflow_runs WHERE id = ?")
    .bind(run)
    .first("status");

describe("an App's status", () => {
  afterEach(endLiveRuns);

  it("opens a published App to those who only use it, and keeps a draft and an archived App from them, as an App that isn't there", async () => {
    const [builder, user] = await Promise.all([
      signedInApi(idp, "builder"),
      signedInApi(idp, "user"),
    ]);
    const app = await draftApp(builder, user);
    const missing = crypto.randomUUID();

    const draft = await waysIn(user, app);
    const nothing = await waysIn(user, missing);
    await builder.api.apps.publish(app);
    const { status } = await user.api.apps.get(app);
    const published = await waysIn(user, app);
    await builder.api.apps.archive(app);
    const archived = await waysIn(user, app);

    expect({
      draft,
      nothing,
      status,
      published,
      archived,
    }).toStrictEqual({
      draft: noSuchApp,
      nothing: noSuchApp,
      status: "published",
      // Published, it opens for the people it is shared with, every way in.
      published: {
        get: "ok",
        contents: "ok",
        exports: "ok",
        open: "ok",
        version: "ok",
        start: "ok",
        runs: "ok",
        listed: true,
        overview: true,
      },
      archived: noSuchApp,
    });
  });

  it("lets its builders use a draft, and nobody use an archived App, builders included", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await draftApp(builder);

    const draft = await outcome(builder.api.workflows.start(app, "nap"));
    await builder.api.apps.archive(app);
    const archived = await waysIn(builder, app);

    expect({ draft, archived }).toStrictEqual({
      draft: "ok",
      // Still theirs to see and restore, never to use.
      archived: {
        get: "ok",
        contents: "ok",
        exports: "ok",
        open: "app.archived",
        version: "app.archived",
        start: "app.archived",
        runs: "ok",
        listed: true,
        overview: true,
      },
    });
  });

  it("moves only for its builders, from where it is now, audited once per change", async () => {
    const [builder, other, user] = await Promise.all([
      signedInApi(idp, "builder"),
      signedInApi(idp, "builder"),
      signedInApi(idp, "user"),
    ]);
    const { id: empty } = await builder.api.apps.create({ name: "Empty" });
    const app = await draftApp(builder, user);
    await builder.api.apps.members.add(app, {
      type: "person",
      id: other.userId,
      role: "builder",
    });

    const noVersion = await outcome(builder.api.apps.publish(empty));
    const byUserOfDraft = await outcome(user.api.apps.publish(app));
    await other.api.apps.publish(app);
    // Publishing a published App changes and records nothing.
    await builder.api.apps.publish(app);
    const byUser = await outcome(user.api.apps.unpublish(app));
    // A builder no longer: their role is read for the call.
    await builder.api.apps.members.remove(app, {
      type: "person",
      id: other.userId,
    });
    const byFormer = await outcome(other.api.apps.archive(app));
    await builder.api.apps.archive(app);
    const publishArchived = await outcome(builder.api.apps.publish(app));
    const restored = await builder.api.apps.restore(app);
    const logged = await allEvents();
    const changes = logged
      .filter(
        ({ action, target }) =>
          target?.id === app &&
          [
            "app.published",
            "app.unpublished",
            "app.archived",
            "app.restored",
          ].includes(action)
      )
      .map(({ action, actor, detail }) => ({ action, actor, detail }));

    expect({
      noVersion,
      byUserOfDraft,
      byUser,
      byFormer,
      publishArchived,
      restored: restored.status,
      changes,
    }).toStrictEqual({
      noVersion: "app.no_version",
      byUserOfDraft: "app.not_found",
      byUser: "role.forbidden",
      // No role left at all in it: as for an App that isn't there.
      byFormer: "app.not_found",
      publishArchived: "app.archived",
      // A restored App is a draft: its users wait for it to be published.
      restored: "draft",
      changes: [
        {
          action: "app.published",
          actor: { type: "person", userId: other.userId },
          detail: { from: "draft", to: "published" },
        },
        {
          action: "app.archived",
          actor: { type: "person", userId: builder.userId },
          detail: { from: "published", to: "archived" },
        },
        {
          action: "app.restored",
          actor: { type: "person", userId: builder.userId },
          detail: { from: "archived", to: "draft" },
        },
      ],
    });
  });

  it("fires a schedule only while the App is published", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await draftApp(builder);
    const due = await nextRunOf(app);
    const runs = async (): Promise<number> => {
      const listed = await builder.api.workflows.list(app);
      return listed.filter(({ workflow }) => workflow === "weekly").length;
    };

    await runCron({}, due);
    const asDraft = await runs();
    const deliveredToDraft = await outcome(
      startRun(env, {
        app: appIdSchema.parse(app),
        workflow: workflowIdSchema.parse("weekly"),
        input: undefined,
        startedBy: null,
        actor: { type: "system" },
        trigger: {
          type: "schedule",
          key: `schedule:${crypto.randomUUID()}`,
          version: 1,
        },
      })
    );
    await builder.api.apps.publish(app);
    await runCron({}, due);
    const asPublished = await runs();
    const next = await nextRunOf(app);
    await builder.api.apps.archive(app);
    await runCron({}, next);
    const asArchived = await runs();
    // A trigger's delivery that raced past the schedule's query is refused
    // at the start too.
    const delivered = await outcome(
      startRun(env, {
        app: appIdSchema.parse(app),
        workflow: workflowIdSchema.parse("weekly"),
        input: undefined,
        startedBy: null,
        actor: { type: "system" },
        trigger: {
          type: "schedule",
          key: `schedule:${crypto.randomUUID()}`,
          version: 1,
        },
      })
    );

    expect({
      asDraft,
      deliveredToDraft,
      asPublished,
      asArchived,
      delivered,
    }).toStrictEqual({
      asDraft: 0,
      deliveredToDraft: "workflow.trigger_gone",
      asPublished: 1,
      asArchived: 1,
      delivered: "app.archived",
    });
  });

  it("cancels the runs an archive finds, and those it raced, each audited", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await draftApp(builder);
    await builder.api.apps.publish(app);
    const found = await builder.api.workflows.start(app, "nap");
    await sleeping(found.id, "rest");

    await builder.api.apps.archive(app);
    await finished(found.id);
    const archivedAt = await env.DB.prepare(
      "SELECT status_changed_at AS at FROM apps WHERE id = ?"
    )
      .bind(app)
      .first<{ at: number }>();
    // A run whose start committed after the archive's look at its runs:
    // started on the published App, then archived without that look.
    await builder.api.apps.restore(app);
    await builder.api.apps.publish(app);
    const raced = await builder.api.workflows.start(app, "nap");
    await sleeping(raced.id, "rest");
    // A cancel of that archive, late, leaves the run started since alone.
    const { asked: late } = await cancelRunsOf(
      env,
      { userId: builder.userId, staff: false },
      app,
      new Date(archivedAt?.at ?? 0)
    );
    await env.DB.prepare("UPDATE apps SET status = 'archived' WHERE id = ?")
      .bind(app)
      .run();
    await runCron({}, new Date());
    await finished(raced.id);
    const logged = await allEvents();
    const cancelled = logged
      .filter(
        ({ action, target }) =>
          action === "workflow.run.cancelled" &&
          (target?.id === found.id || target?.id === raced.id)
      )
      .map(({ target, actor }) => ({ run: target?.id, actor }));
    const statuses = await Promise.all(
      [found.id, raced.id].map(async (run) => {
        const { status } = await builder.api.workflows.status(run);
        return status;
      })
    );

    expect({ late, statuses, cancelled }).toStrictEqual({
      late: 0,
      statuses: ["cancelled", "cancelled"],
      cancelled: [
        { run: found.id, actor: { type: "person", userId: builder.userId } },
        { run: raced.id, actor: { type: "person", userId: builder.userId } },
      ],
    });
  });

  it("never moves for Grasp staff, whatever the transition", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await draftApp(builder);
    await builder.api.apps.publish(app);
    const staff = { ...(await acting("admin")), staff: true };

    const tried = {
      publish: await outcome(changeStatus(env, staff, app, "publish")),
      unpublish: await outcome(changeStatus(env, staff, app, "unpublish")),
      archive: await outcome(changeStatus(env, staff, app, "archive")),
      restore: await outcome(changeStatus(env, staff, app, "restore")),
    };
    const { status } = await builder.api.apps.get(app);

    expect({ tried, status }).toStrictEqual({
      tried: {
        publish: "role.forbidden",
        unpublish: "role.forbidden",
        archive: "role.forbidden",
        restore: "role.forbidden",
      },
      status: "published",
    });
  });

  it("starts no run for someone who may no longer use the App once its row is written", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await draftApp(builder);
    const user = await acting("user");
    await builder.api.apps.members.add(app, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    // As their start reads it once it is written: the App was published
    // when they asked, and is a draft again now.
    const refused = await outcome(
      startRun(env, {
        app: appIdSchema.parse(app),
        workflow: workflowIdSchema.parse("nap"),
        input: undefined,
        startedBy: user.userId,
        actor: { type: "person", userId: user.userId },
        starter: user,
      })
    );
    const runs = await builder.api.workflows.list(app);

    expect({
      refused,
      runs: runs.map(({ status }) => status),
    }).toStrictEqual({ refused: "app.not_found", runs: ["failed"] });
  });

  it("cancels only an archived App's runs, and finishes the archive's cancels before it is restored", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await draftApp(builder);
    await builder.api.apps.publish(app);
    const left = await builder.api.workflows.start(app, "nap");
    await sleeping(left.id, "rest");
    // Archived without its cancels yet: their pass hasn't come.
    // Archived, its start having overlapped the archive's write: created
    // after the archive's time, which no cutoff at that time reaches.
    await env.DB.prepare(
      "UPDATE apps SET status = 'archived', status_changed_at = ? WHERE id = ?"
    )
      .bind(Date.now() - 60_000, app)
      .run();

    // While a cancel it owes fails, the restore is refused, and the App
    // stays archived for the cron trigger to ask again.
    const refused = await whileEngineRefuses(
      (method) => method === "markCancelled",
      async () => await outcome(builder.api.apps.restore(app))
    );
    const { status: stillArchived } = await builder.api.apps.get(app);
    await builder.api.apps.restore(app);
    await finished(left.id);
    const { status: leftStatus } = await builder.api.workflows.status(left.id);
    await builder.api.apps.publish(app);
    const own = await builder.api.workflows.start(app, "nap");
    await sleeping(own.id, "rest");
    // A sweep asked of the restored App, however late its cutoff, finds none.
    const { asked: swept } = await cancelRunsOf(
      env,
      { userId: builder.userId, staff: false },
      app,
      new Date(Date.now() + 60_000)
    );

    expect({ refused, stillArchived, leftStatus, swept }).toStrictEqual({
      refused: "app.conflict",
      stillArchived: "archived",
      leftStatus: "cancelled",
      swept: 0,
    });
  });

  it("is read-only for its builders once archived: no version made current, sharing, binding or commit, though access can be taken away", async () => {
    const builder = await signedInApi(idp, "builder");
    const user = await acting("user");
    const app = await draftApp(builder);
    const { version } = await builder.api.apps.files.commit(
      app,
      { "notes.md": "Next" },
      "Next"
    );
    await builder.api.apps.archive(app);
    const defaultStore = await env.DB.prepare(
      "SELECT store_id AS store FROM app_default_stores WHERE app_id = ?"
    )
      .bind(app)
      .first<{ store: string }>();
    const other = await acting("builder");
    await env.DB.prepare(
      "INSERT INTO app_members (app_id, member_type, member_id, role, added_by, added_at) VALUES (?, 'person', ?, 'builder', ?, ?)"
    )
      .bind(app, other.userId, builder.userId, Date.now())
      .run();

    expect({
      current: await outcome(
        builder.api.apps.versions.setCurrent(app, version)
      ),
      share: await outcome(
        builder.api.apps.members.add(app, {
          type: "person",
          id: user.userId,
          role: "user",
        })
      ),
      bind: await outcome(
        bindWorkflowToApp(env, other, crypto.randomUUID(), {
          app,
          alias: "followUp",
          version: 1,
        })
      ),
      commit: await outcome(
        builder.api.apps.files.commit(app, { "notes.md": "Later" }, "Later")
      ),
      store: await outcome(
        shareStore(env, other, defaultStore?.store ?? "", {
          type: "person",
          id: user.userId,
        })
      ),
      // Read as ever, never changed.
      detail: await outcome(builder.api.workflows.get(app, "weekly")),
      params: await outcome(builder.api.workflows.params.list(app, "weekly")),
      param: await outcome(
        builder.api.workflows.params.set(app, "weekly", "every", "0 9 * * 1")
      ),
      // Taking access away is never blocked.
      unshare: await outcome(
        builder.api.apps.members.remove(app, {
          type: "person",
          id: other.userId,
        })
      ),
    }).toStrictEqual({
      current: "app.archived",
      share: "app.archived",
      bind: "app.archived",
      commit: "app.archived",
      store: "app.archived",
      detail: "ok",
      params: "ok",
      param: "app.archived",
      unshare: "ok",
    });
  });

  it("keeps what an archive raced unwritten: no version committed, proposed or made current once it lands", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await draftApp(builder);
    const by = await builder.api.whoami();
    const { version } = await builder.api.apps.files.commit(
      app,
      { "notes.md": "Next" },
      "Next"
    );
    const archive = async (): Promise<void> => {
      await env.DB.prepare("UPDATE apps SET status = 'archived' WHERE id = ?")
        .bind(app)
        .run();
    };
    const restore = async (): Promise<void> => {
      await env.DB.prepare("UPDATE apps SET status = 'draft' WHERE id = ?")
        .bind(app)
        .run();
    };

    // Archived just before each write's batch lands, after its check.
    const committed = await outcome(
      commitFiles(
        { ...env, DB: racingDb(archive, /insert into "app_versions"/iu) },
        by,
        app,
        { "notes.md": "Raced" },
        "Raced"
      )
    );
    const versions = await builder.api.apps.versions.list(app);
    await restore();
    const madeCurrent = await outcome(
      activateVersion(
        {
          ...env,
          DB: racingDb(archive, /update "apps" set "current_version"/iu),
        },
        by,
        app,
        version
      )
    );
    await restore();
    const draft = await draftOverLatest(env, appIdSchema.parse(app), {
      base: version,
      changes: { "notes.md": "Drafted" },
    });
    const drafted = await outcome(
      proposeDraft(
        { ...env, DB: racingDb(archive, /insert into "app_versions"/iu) },
        by,
        app,
        draft,
        "Drafted"
      )
    );
    await restore();
    const proposed = await outcome(
      proposeVersion(
        {
          ...env,
          DB: racingDb(archive, /update "apps" set "pending_version"/iu),
        },
        by,
        app,
        version
      )
    );
    await restore();
    const after = await builder.api.apps.get(app);
    const versionsAfter = await builder.api.apps.versions.list(app);

    expect({
      committed,
      versions: versions.map(({ version: number }) => number),
      madeCurrent,
      currentVersion: after.currentVersion,
      drafted,
      proposed,
      pendingVersion: after.pendingVersion,
      versionsAfter: versionsAfter.map(({ version: number }) => number),
    }).toStrictEqual({
      committed: "app.archived",
      versions: [version, 1],
      madeCurrent: "app.archived",
      currentVersion: 1,
      drafted: "app.archived",
      proposed: "app.archived",
      pendingVersion: null,
      versionsAfter: [version, 1],
    });
  });

  it("refuses a restore once the App went round to archived again meanwhile", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await draftApp(builder);
    await builder.api.apps.archive(app);
    const by = await builder.api.whoami();
    // Restored, used and archived again by others just before this
    // restore's write lands: archived as it read it, but another archive.
    const cycled = async (): Promise<void> => {
      await env.DB.prepare(
        "UPDATE apps SET status = 'archived', status_changed_at = status_changed_at + 5 WHERE id = ?"
      )
        .bind(app)
        .run();
    };

    const refused = await outcome(
      changeStatus(
        { ...env, DB: racingDb(cycled, /update "apps" set "status"/iu) },
        by,
        app,
        "restore"
      )
    );
    const { status } = await builder.api.apps.get(app);

    expect({ refused, status }).toStrictEqual({
      refused: "app.conflict",
      status: "archived",
    });
  });

  it("sends no start the repair finds for an App that may no longer run it", async () => {
    const builder = await signedInApi(idp, "builder");
    const draft = await draftApp(builder);
    const archived = await draftApp(builder);
    await builder.api.apps.archive(archived);
    const user = await signedInApi(idp, "user");
    const shared = await draftApp(builder, user);
    const trigger = await orphan(draft, null);
    const person = await orphan(archived, builder.userId);
    // A user's start on an App published then, a draft now: they may no
    // longer use it, whatever their start's row says.
    const usersStart = await orphan(shared, user.userId);

    await repairStarts(env, trigger);
    await repairStarts(env, person);
    await repairStarts(env, usersStart);
    expect({
      trigger: await statusOf(trigger),
      person: await statusOf(person),
      usersStart: await statusOf(usersStart),
    }).toStrictEqual({
      trigger: "failed",
      person: "failed",
      usersStart: "failed",
    });
  });

  it("lets a start the engine took go on when the repair finds its App unpublished", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await draftApp(builder);
    await builder.api.apps.publish(app);
    // A trigger's: the repair would refuse its start on a draft.
    const { id } = await startRun(env, {
      app: appIdSchema.parse(app),
      workflow: workflowIdSchema.parse("nap"),
      input: undefined,
      startedBy: null,
      actor: { type: "system" },
      trigger: {
        type: "schedule",
        key: `schedule:${crypto.randomUUID()}`,
        version: 1,
      },
    });
    await sleeping(id, "rest");
    // Its confirmation was never recorded, and the App went back to a
    // draft since: the engine has the run, in flight.
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE workflow_runs SET status = 'starting', pending_start = '{}', created_at = ? WHERE id = ?"
      ).bind(Date.now() - 600_000, id),
      env.DB.prepare("UPDATE apps SET status = 'draft' WHERE id = ?").bind(app),
    ]);

    await repairStarts(env, id);
    const pendingNow = await env.DB.prepare(
      "SELECT pending_start IS NOT NULL AS pending FROM workflow_runs WHERE id = ?"
    )
      .bind(id)
      .first("pending");

    // The engine's own notification may move it from starting to running
    // at any moment; what matters is that it goes on, confirmed.
    expect({
      goesOn: ["starting", "running"].includes(String(await statusOf(id))),
      pendingNow,
    }).toStrictEqual({
      goesOn: true,
      pendingNow: 0,
    });
  });

  it("keeps an archived App's screen data and sharing as they are, an archive raced in included", async () => {
    const [builder, admin, user] = await Promise.all([
      signedInApi(idp, "builder"),
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const app = await draftApp(builder);
    const { generation } = await admin.api.screenTrust.review(app);
    const by = await builder.api.whoami();
    const archive = async (): Promise<void> => {
      await env.DB.prepare("UPDATE apps SET status = 'archived' WHERE id = ?")
        .bind(app)
        .run();
    };

    // Archived just before the sharing's batch lands, after its check.
    const shared = await outcome(
      addMember(
        { ...env, DB: racingDb(archive, /insert into "app_members"/iu) },
        by,
        app,
        { type: "person", id: user.userId, role: "user" }
      )
    );
    const members = await builder.api.apps.members.list(app);
    const classified = await outcome(
      admin.api.screenTrust.classify(app, "sensitive", generation)
    );

    expect({
      shared,
      members: members.map(({ id }) => id),
      classified,
    }).toStrictEqual({
      shared: "app.archived",
      members: [],
      classified: "app.archived",
    });
  });
});
