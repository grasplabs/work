import { appIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

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
import { repairResourceStarts } from "../src/workflows/resource-runs.ts";
import { ordinaryData, racingDb } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import {
  called,
  endLiveResourceRuns,
  jsonWorkflowAppsOf,
  runFor,
  runOnce,
  screenOf,
  startCommand,
  startedOf,
} from "./json-workflow-apps.ts";
import type { Person as Signed } from "./json-workflow-apps.ts";
import { runMinuteTasks } from "./maintenance.ts";
import { notesFiles } from "./notes-client-app.ts";
import { runObject, sleeping, whileEngineRefuses } from "./runs.ts";
import { person as acting } from "./sealed-apps.ts";
import { firstVersion, outcome, signedInApi } from "./sign-in.ts";

// An App is a draft, published or archived (app-status.ts). These tests
// start from the ways that can fail: someone who only uses an App reaching
// a draft or an archived one by any way in, or learning a draft exists;
// a trigger or a run outliving the archive; a transition by someone who
// lost their role, or one nobody audited; and an App restored straight
// back to the people who use it. The runs are of an independent JSON
// workflow bound to the App, started from its screen over core's
// function route. Gone with App workflows: a schedule an App's own
// workflow declares, firing only while the App is published, and its own
// workflows' detail and parameters read, never set, once archived.
// Already covered: a start refused for someone who may no longer use the
// App once it is decided (workflow-starts.test.ts, "acts only for someone
// who may use the App now, each with keys of their own").

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

/**
 * A builder's App with a screen, its first version current, left a draft;
 * shared with `user` to use.
 */
const draftApp = async (builder: Person, user?: Person): Promise<string> => {
  const { id } = await builder.api.apps.create({ name: "Invoices" });
  const { version } = await builder.api.apps.files.commit(
    id,
    { ...notesFiles, "screens/desk.tsx": "export default () => null;\n" },
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

/** What `person` gets at each way into App `app`. */
const waysIn = async (person: Person, app: string) => {
  const listed = await person.api.apps.list();
  return {
    get: await outcome(person.api.apps.get(app)),
    contents: await outcome(person.api.apps.contents(app)),
    open: await outcome(person.api.screens.open(app, "desk")),
    version: await outcome(
      firstVersion(
        async (onVersion) =>
          await person.api.screens.watchVersion(app, onVersion)
      )
    ),
    listed: listed.some(({ id }) => id === app),
  };
};

/** Every way in, as for an App that doesn't exist. */
const noSuchApp = {
  get: "app.not_found",
  contents: "app.not_found",
  open: "app.not_found",
  version: "app.not_found",
  listed: false,
};

const { boundApp } = jsonWorkflowAppsOf(idp);

/**
 * An App of a builder's, published, its screen approved, with an
 * independent workflow bound that holds an hour, and the App's grant to
 * start it.
 */
const holdingApp = async () => await boundApp({ hold: "PT1H" });

type Holding = Awaited<ReturnType<typeof holdingApp>>;

/** A run of the App's workflow `person` starts from its screen. */
const startedFrom = async (
  { app, reference }: Holding,
  person: Signed
): Promise<string> =>
  startedOf(
    await called(
      person,
      app,
      await screenOf(person, app),
      startCommand(reference)
    )
  ).runId;

/** A run of the App's workflow, started from its screen, asleep in its hold. */
const holdingRun = async (holding: Holding): Promise<string> => {
  const runId = await startedFrom(holding, holding.builder);
  await sleeping(runId, "task:hold");
  return runId;
};

/** Run `runId`'s status, as the workflow's builder reads it. */
const statusOf = async ({ builder, workflow }: Holding, runId: string) => {
  const { status } = await runFor(builder, workflow, runId);
  return status;
};

/** Once run `runId` says `status`, as the workflow's builder reads it. */
const reached = async (
  { builder, workflow }: Holding,
  runId: string,
  status: string
): Promise<string> => {
  const run = await runOnce(
    builder,
    workflow,
    runId,
    (read) => read.status === status
  );
  return run.status;
};

describe("an App's status", () => {
  afterEach(endLiveResourceRuns);

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
        open: "ok",
        version: "ok",
        listed: true,
      },
      archived: noSuchApp,
    });
  });

  it("lets its builders use a draft, and nobody use an archived App, builders included", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await draftApp(builder);

    const draft = await outcome(builder.api.screens.open(app, "desk"));
    await builder.api.apps.archive(app);
    const archived = await waysIn(builder, app);

    expect({ draft, archived }).toStrictEqual({
      draft: "ok",
      // Still theirs to see and restore, never to use.
      archived: {
        get: "ok",
        contents: "ok",
        open: "app.archived",
        version: "app.archived",
        listed: true,
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

  it("cancels the runs an archive finds, and those it raced, each audited", async () => {
    const holding = await holdingApp();
    const { builder, app } = holding;
    const found = await holdingRun(holding);

    await builder.api.apps.archive(app);
    const foundStatus = await reached(holding, found, "cancelled");
    const archivedAt = await env.DB.prepare(
      "SELECT status_changed_at AS at FROM apps WHERE id = ?"
    )
      .bind(app)
      .first<{ at: number }>();
    // A run whose start committed after the archive's look at its runs:
    // started on the published App, then archived without that look.
    await builder.api.apps.restore(app);
    await builder.api.apps.publish(app);
    const raced = await holdingRun(holding);
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
    await runMinuteTasks({}, new Date());
    const racedStatus = await reached(holding, raced, "cancelled");
    const logged = await allEvents();
    const cancelled = logged
      .filter(
        ({ action, target }) =>
          action === "workflow.run.terminated" &&
          (target?.id === found || target?.id === raced)
      )
      .map(({ target, actor }) => ({ run: target?.id, actor }));

    expect({
      late,
      statuses: [foundStatus, racedStatus],
      cancelled,
    }).toStrictEqual({
      late: 0,
      statuses: ["cancelled", "cancelled"],
      cancelled: [
        { run: found, actor: { type: "person", userId: builder.userId } },
        { run: raced, actor: { type: "person", userId: builder.userId } },
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

  it("cancels only an archived App's runs, and finishes the archive's cancels before it is restored", async () => {
    const holding = await holdingApp();
    const { builder, app } = holding;
    const left = await holdingRun(holding);
    // Archived without its cancels yet: their pass hasn't come.
    // Archived, its start having overlapped the archive's write: created
    // after the archive's time, which no cutoff at that time reaches.
    await env.DB.prepare(
      "UPDATE apps SET status = 'archived', status_changed_at = ? WHERE id = ?"
    )
      .bind(Date.now() - 60_000, app)
      .run();

    // While a cancel it owes fails, the restore is refused, and the App
    // stays archived for the clock to ask again.
    const refused = await whileEngineRefuses(
      (method) => method === "terminate",
      async () => await outcome(builder.api.apps.restore(app))
    );
    const { status: stillArchived } = await builder.api.apps.get(app);
    // Asked again once the engine takes stops: the restore goes through
    // once the stop has ended the run (`app.stops_pending` until then).
    const restored = await vi.waitFor(
      async () => await builder.api.apps.restore(app),
      { timeout: 30_000, interval: 200 }
    );
    const leftStatus = await statusOf(holding, left);
    await builder.api.apps.publish(app);
    await holdingRun(holding);
    // A sweep asked of the restored App, however late its cutoff, finds none.
    const { asked: swept } = await cancelRunsOf(
      env,
      { userId: builder.userId, staff: false },
      app,
      new Date(Date.now() + 60_000)
    );

    expect({
      refused,
      stillArchived,
      restored: restored.status,
      leftStatus,
      swept,
    }).toStrictEqual({
      refused: "app.conflict",
      stillArchived: "archived",
      restored: "draft",
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

  it("sends no start for an App archived since: the archive cancels it, and the repair has nothing to send", async () => {
    const holding = await holdingApp();
    const { builder, app } = holding;
    // A start the engine never took: its run is still starting.
    const runId = await whileEngineRefuses(
      () => true,
      async () => await startedFrom(holding, builder)
    );
    const starting = await statusOf(holding, runId);
    await builder.api.apps.archive(app);

    // Past when the repair first looks at it.
    await repairResourceStarts(env, new Date(Date.now() + 2 * 60_000));
    const engine = await runObject(runId).status();
    expect({
      starting,
      repaired: await statusOf(holding, runId),
      engine,
    }).toStrictEqual({
      starting: "starting",
      repaired: "cancelled",
      engine: undefined,
    });
  });

  it("lets a start the engine took go on when the repair finds its App unpublished", async () => {
    const holding = await holdingApp();
    const { app } = holding;
    const runId = await holdingRun(holding);
    // Its confirmation was never recorded, and the App went back to a
    // draft since: the engine has the run, in flight.
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE workflow_resource_runs SET status = 'starting' WHERE id = ?"
      ).bind(runId),
      env.DB.prepare("UPDATE apps SET status = 'draft' WHERE id = ?").bind(app),
    ]);

    // Past when the repair first looks at it.
    await repairResourceStarts(env, new Date(Date.now() + 2 * 60_000));

    await expect(statusOf(holding, runId)).resolves.toBe("running");
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
