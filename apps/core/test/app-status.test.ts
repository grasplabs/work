import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { addMember } from "../src/app-members.ts";
import { setArchived } from "../src/app-status.ts";
import { appKind } from "../src/apps.ts";
import { deleteStore } from "../src/data-stores.ts";
import { rollback } from "../src/publish.ts";
import {
  repairResourceStarts,
  stopRunsStartedBy,
} from "../src/workflows/resource-runs.ts";
import { publishApp, withFiles, writeApp } from "./app-definitions.ts";
import { publishDefined, racingDb } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import {
  called,
  endLiveResourceRuns,
  jsonWorkflowAppsOf,
  runFor,
  runOnce,
  pageOf,
  startCommand,
  startedOf,
} from "./json-workflow-apps.ts";
import type { Person as Signed } from "./json-workflow-apps.ts";
import { runMinuteTasks } from "./maintenance.ts";
import { notesFiles } from "./notes-client-app.ts";
import { runObject, sleeping, whileEngineRefuses } from "./runs.ts";
import { person as acting } from "./sealed-apps.ts";
import { firstVersion, outcome, signedInApi } from "./sign-in.ts";
import { testBinding } from "./test-env.ts";

// An App is open to the people it is shared with once a version of it
// is live, and to nobody once archived (app-status.ts). These tests
// start from the ways that can fail: someone who only uses an App reaching
// one that isn't live yet or an archived one by any way in, or learning
// one exists; a trigger or a run outliving the archive; an archive or a
// restore by someone who lost their role, or one nobody audited; and a
// stale restore landing on a newer archive. The runs are of an
// independent JSON workflow bound to the App, started from its page over
// core's function route. Already covered: a start refused for someone who
// may no longer use the App once it is decided (workflow-starts.test.ts,
// "acts only for someone who may use the App now, each with keys of their
// own").

const idp = mockIdp();

type Person = Awaited<ReturnType<typeof signedInApi>>;

/** The page every App here has. */
const pageFiles = withFiles(notesFiles, {
  "src/routes/index.tsx":
    'import { createFileRoute } from "@tanstack/react-router";\n\nexport const Route = createFileRoute("/")({ component: () => null });\n',
});

/**
 * A builder's App with a page in its draft, nothing of it published yet;
 * shared with `user` to use. `publish` makes its draft its live version.
 */
const unpublishedApp = async (
  builder: Person,
  user?: Person
): Promise<{ app: string; publish: () => Promise<number> }> => {
  const { id } = await builder.api.apps.create({ name: "Invoices" });
  const revision = await writeApp(builder.api, id, pageFiles);
  if (user !== undefined) {
    await builder.api.apps.members.add(id, {
      type: "person",
      id: user.userId,
      role: "user",
    });
  }
  return {
    app: id,
    publish: async () => {
      const { version } = await builder.api.drafts.publish(
        { kind: "app", id },
        revision
      );
      return version;
    },
  };
};

/** A builder's App with a page, its first version live; shared with `user`. */
const liveApp = async (builder: Person, user?: Person): Promise<string> => {
  const { app, publish } = await unpublishedApp(builder, user);
  await publish();
  return app;
};

/** An App's archive, as raw SQL: at `at`, or now. */
const archivedRaw = async (app: string, at = Date.now()): Promise<void> => {
  await env.DB.prepare("UPDATE apps SET archived_at = ? WHERE id = ?")
    .bind(at, app)
    .run();
};

/** An App's restore, as raw SQL. */
const restoredRaw = async (app: string): Promise<void> => {
  await env.DB.prepare("UPDATE apps SET archived_at = NULL WHERE id = ?")
    .bind(app)
    .run();
};

/** What `person` gets at each way into App `app`. */
const waysIn = async (person: Person, app: string) => {
  const listed = await person.api.apps.list();
  return {
    get: await outcome(person.api.apps.get(app)),
    contents: await outcome(person.api.apps.contents(app)),
    open: await outcome(person.api.pages.open(app)),
    version: await outcome(
      firstVersion(
        async (onVersion) => await person.api.pages.watchVersion(app, onVersion)
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
 * An App of a builder's, published, with an
 * independent workflow bound that holds an hour, and the App's grant to
 * start it.
 */
const holdingApp = async () => await boundApp({ hold: "1 hour" });

type Holding = Awaited<ReturnType<typeof holdingApp>>;

/** A run of the App's workflow `person` starts from its page. */
const startedFrom = async (
  { app, reference }: Holding,
  person: Signed
): Promise<string> =>
  startedOf(
    await called(
      person,
      app,
      await pageOf(person, app),
      startCommand(reference)
    )
  ).runId;

/** A run of the App's workflow, started from its page, asleep in its hold. */
const holdingRun = async (holding: Holding): Promise<string> => {
  const runId = await startedFrom(holding, holding.builder);
  await sleeping(runId, "hold:task");
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

describe("an App's archive", () => {
  afterEach(endLiveResourceRuns);

  it("opens an App to those who only use it once a version is live, and keeps one not live yet and an archived one from them, as an App that isn't there", async () => {
    const [builder, user] = await Promise.all([
      signedInApi(idp, "builder"),
      signedInApi(idp, "user"),
    ]);
    const { app, publish } = await unpublishedApp(builder, user);
    const missing = crypto.randomUUID();

    const notLive = await waysIn(user, app);
    const nothing = await waysIn(user, missing);
    await publish();
    const live = await waysIn(user, app);
    await builder.api.apps.archive(app);
    const archived = await waysIn(user, app);
    // Restored, it is open again at once: its version is still live.
    await builder.api.apps.restore(app);
    const restored = await waysIn(user, app);
    const open = {
      get: "ok",
      contents: "ok",
      open: "ok",
      version: "ok",
      listed: true,
    };

    expect({ notLive, nothing, live, archived, restored }).toStrictEqual({
      notLive: noSuchApp,
      nothing: noSuchApp,
      // Live, it opens for the people it is shared with, every way in.
      live: open,
      archived: noSuchApp,
      restored: open,
    });
  });

  it("stays as closed as its status had it once the release that archives by time carries it over", async () => {
    const [builder, user] = await Promise.all([
      signedInApi(idp, "builder"),
      signedInApi(idp, "user"),
    ]);
    const [archived, drafted, published] = await Promise.all([
      liveApp(builder, user),
      liveApp(builder, user),
      liveApp(builder, user),
    ]);
    // As the release before left them: whom each reached was its status.
    const changedAt = Date.parse("2026-10-01T09:00:00Z");
    const changedBy = JSON.stringify({ userId: builder.userId, staff: false });
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE apps SET archived_at = NULL, archived_by = NULL, status = 'published' WHERE id = ?"
      ).bind(published),
      ...[
        [archived, "archived"],
        [drafted, "draft"],
      ].map(([app, status]) =>
        env.DB.prepare(
          "UPDATE apps SET archived_at = NULL, archived_by = NULL, status = ?, status_changed_at = ?, status_changed_by = ? WHERE id = ?"
        ).bind(status, changedAt, changedBy, app)
      ),
    ]);
    const carried = z
      .array(z.object({ name: z.string(), queries: z.array(z.string()) }))
      .parse(testBinding("CORE_MIGRATIONS"))
      .find(({ name }) => name.includes("_shared_app_drafts"))
      ?.queries.filter((query) => query.includes("UPDATE `apps` SET"));
    if (carried === undefined || carried.length === 0) {
      throw new Error("shared_app_drafts carries no App over");
    }
    await env.DB.batch(carried.map((query) => env.DB.prepare(query)));

    const kept = await env.DB.prepare(
      "SELECT archived_at AS at, archived_by AS by FROM apps WHERE id = ?"
    )
      .bind(archived)
      .first();
    expect({
      archived: await outcome(user.api.apps.get(archived)),
      drafted: await outcome(user.api.apps.get(drafted)),
      published: await outcome(user.api.apps.get(published)),
      // Archived when, and by whom, its status said.
      kept,
      // A builder restores the draft, as any archived App.
      restorable: await outcome(builder.api.apps.restore(drafted)),
    }).toStrictEqual({
      archived: "app.not_found",
      drafted: "app.not_found",
      published: "ok",
      kept: { at: changedAt, by: changedBy },
      restorable: "ok",
    });
  });

  it("shows its builders an App before it is live, with nothing live to open, and lets nobody use an archived App, builders included", async () => {
    const builder = await signedInApi(idp, "builder");
    const { app } = await unpublishedApp(builder);

    const before = await waysIn(builder, app);
    await builder.api.apps.archive(app);
    const archived = await waysIn(builder, app);

    expect({ before, archived }).toStrictEqual({
      // Theirs to build, in its preview: nothing of it is live to open.
      before: {
        get: "ok",
        contents: "ok",
        open: "app.not_running",
        version: "ok",
        listed: true,
      },
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

  it("is archived and restored only by its builders, audited once per change", async () => {
    const [builder, other, user] = await Promise.all([
      signedInApi(idp, "builder"),
      signedInApi(idp, "builder"),
      signedInApi(idp, "user"),
    ]);
    const { app, publish } = await unpublishedApp(builder, user);
    await builder.api.apps.members.add(app, {
      type: "person",
      id: other.userId,
      role: "builder",
    });

    const byUserNotLive = await outcome(user.api.apps.archive(app));
    const version = await publish();
    const byUser = await outcome(user.api.apps.archive(app));
    // A builder no longer: their role is read for the call.
    await builder.api.apps.members.remove(app, {
      type: "person",
      id: other.userId,
    });
    const byFormer = await outcome(other.api.apps.archive(app));
    const archived = await builder.api.apps.archive(app);
    // Archiving an archived App changes and records nothing; so does
    // restoring a restored one.
    const again = await builder.api.apps.archive(app);
    const restored = await builder.api.apps.restore(app);
    const restoredAgain = await builder.api.apps.restore(app);
    const logged = await allEvents();
    const changes = logged
      .filter(
        ({ action, target }) =>
          target?.id === app &&
          ["app.archived", "app.restored"].includes(action)
      )
      .map(({ action, actor, detail }) => ({ action, actor, detail }));

    expect({
      byUserNotLive,
      byUser,
      byFormer,
      archived: [archived.archived, again.archived],
      restored: [restored.archived, restoredAgain.archived],
      currentVersion: restored.currentVersion,
      changes,
    }).toStrictEqual({
      // Not live yet, it isn't there for them at all.
      byUserNotLive: "app.not_found",
      byUser: "role.forbidden",
      // No role left at all in it: as for an App that isn't there.
      byFormer: "app.not_found",
      archived: [true, true],
      restored: [false, false],
      // Restored, its live version is live again.
      currentVersion: version,
      changes: [
        {
          action: "app.archived",
          actor: { type: "person", userId: builder.userId },
          detail: {},
        },
        {
          action: "app.restored",
          actor: { type: "person", userId: builder.userId },
          detail: {},
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
      "SELECT archived_at AS at FROM apps WHERE id = ?"
    )
      .bind(app)
      .first<{ at: number }>();
    // A run whose start committed after the archive's look at its runs:
    // started on the restored App, then archived without that look.
    await builder.api.apps.restore(app);
    const raced = await holdingRun(holding);
    // A cancel of that archive, late, leaves the run started since alone.
    const { asked: late } = await stopRunsStartedBy(
      env,
      { type: "person", userId: builder.userId },
      app,
      new Date(archivedAt?.at ?? 0),
      50
    );
    await archivedRaw(app);
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

  it("is never archived or restored by Grasp staff", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await liveApp(builder);
    const staff = { ...(await acting("admin")), staff: true };

    const archive = await outcome(setArchived(env, staff, app, true));
    await builder.api.apps.archive(app);
    const restore = await outcome(setArchived(env, staff, app, false));
    const { archived } = await builder.api.apps.get(app);

    expect({ archive, restore, archived }).toStrictEqual({
      archive: "role.forbidden",
      restore: "role.forbidden",
      archived: true,
    });
  });

  it("cancels only an archived App's runs, and finishes the archive's cancels before it is restored", async () => {
    const holding = await holdingApp();
    const { builder, app } = holding;
    const left = await holdingRun(holding);
    // Archived without its cancels yet: their pass hasn't come.
    // Archived, its start having overlapped the archive's write: created
    // after the archive's time, which no cutoff at that time reaches.
    await archivedRaw(app, Date.now() - 60_000);

    // While the engine refuses the stop it owes, the stop is kept on the
    // run, which ends itself on its object's next alarm: until it has, the
    // restore is refused and the App stays archived.
    const refused = await whileEngineRefuses(
      (method) => method === "terminate",
      async () => await outcome(builder.api.apps.restore(app))
    );
    const { archived: stillArchived } = await builder.api.apps.get(app);
    // Asked again: the restore goes through once the stop has ended the
    // run.
    const restored = await vi.waitFor(
      async () => await builder.api.apps.restore(app),
      { timeout: 30_000, interval: 200 }
    );
    const leftStatus = await statusOf(holding, left);
    await holdingRun(holding);
    // A sweep asked of the restored App, however late its cutoff, finds none.
    const { asked: swept } = await stopRunsStartedBy(
      env,
      { type: "person", userId: builder.userId },
      app,
      new Date(Date.now() + 60_000),
      50
    );

    expect({
      refused,
      stillArchived,
      restored: restored.archived,
      leftStatus,
      swept,
    }).toStrictEqual({
      refused: "app.stops_pending",
      stillArchived: true,
      restored: false,
      leftStatus: "cancelled",
      swept: 0,
    });
  });

  it("is read-only for its builders once archived: no version published, sharing, binding or commit, though access can be taken away", async () => {
    const builder = await signedInApi(idp, "builder");
    const user = await acting("user");
    const app = await liveApp(builder);
    const { version } = await publishApp(builder.api, app, {
      "notes.md": "Next",
    });
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
        builder.api.versions.rollback({ kind: "app", id: app }, version)
      ),
      share: await outcome(
        builder.api.apps.members.add(app, {
          type: "person",
          id: user.userId,
          role: "user",
        })
      ),
      bind: await outcome(
        builder.api.apps.define(app, {
          op: "bindWorkflow",
          alias: "followUp",
          workflow: crypto.randomUUID(),
        })
      ),
      commit: await outcome(
        publishApp(builder.api, app, { "notes.md": "Later" })
      ),
      store: await outcome(deleteStore(env, other, defaultStore?.store ?? "")),
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

  it("keeps what an archive raced unwritten: no version committed or published once it lands", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await liveApp(builder);
    const by = await builder.api.whoami();
    const { version } = await publishApp(builder.api, app, {
      "notes.md": "Next",
    });
    const archive = async (): Promise<void> => {
      await archivedRaw(app);
    };

    // Archived just before each write's batch lands, after its check.
    const committed = await outcome(
      publishDefined(
        { ...env, DB: racingDb(archive, /insert into "app_versions"/iu) },
        by,
        app,
        { "notes.md": "Raced" }
      )
    );
    const versions = await builder.api.versions.list({ kind: "app", id: app });
    await restoredRaw(app);
    // Back to version 1, over the draft the refused publish left.
    const { revision } = await builder.api.drafts.get({ kind: "app", id: app });
    const published = await outcome(
      rollback(
        {
          ...env,
          DB: racingDb(archive, /update "apps" set "current_version"/iu),
        },
        appKind,
        by,
        app,
        1,
        revision
      )
    );
    await restoredRaw(app);
    const after = await builder.api.apps.get(app);
    const versionsAfter = await builder.api.versions.list({
      kind: "app",
      id: app,
    });

    expect({
      committed,
      versions: versions.map(({ version: number }) => number),
      published,
      currentVersion: after.currentVersion,
      versionsAfter: versionsAfter.map(({ version: number }) => number),
    }).toStrictEqual({
      committed: "app.archived",
      versions: [version, 1],
      published: "app.archived",
      currentVersion: version,
      versionsAfter: [version, 1],
    });
  });

  it("refuses a restore once the App was archived again meanwhile", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await liveApp(builder);
    await builder.api.apps.archive(app);
    const by = await builder.api.whoami();
    // Restored, used and archived again by others just before this
    // restore's write lands: archived as it read it, but another archive.
    const cycled = async (): Promise<void> => {
      await env.DB.prepare(
        "UPDATE apps SET archived_at = archived_at + 5 WHERE id = ?"
      )
        .bind(app)
        .run();
    };

    const refused = await outcome(
      setArchived(
        { ...env, DB: racingDb(cycled, /update "apps" set "archived_at"/iu) },
        by,
        app,
        false
      )
    );
    const { archived } = await builder.api.apps.get(app);

    expect({ refused, archived }).toStrictEqual({
      refused: "app.conflict",
      archived: true,
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

  it("sends no start the engine never took once its person may no longer use the App", async () => {
    const holding = await holdingApp();
    const { builder, app } = holding;
    const { signedIn } = jsonWorkflowAppsOf(idp);
    const user = await signedIn("user");
    await builder.api.apps.members.add(app, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    // A user's start the engine never took, and a builder's: both still
    // starting.
    const [usersStart, buildersStart] = await whileEngineRefuses(
      () => true,
      async () => [
        await startedFrom(holding, user),
        await startedFrom(holding, builder),
      ]
    );
    // Shared with them then, not now: the user may no longer use it,
    // whatever their start's row says; its builder still may.
    await env.DB.prepare(
      "DELETE FROM app_members WHERE app_id = ? AND member_id = ?"
    )
      .bind(app, user.userId)
      .run();

    // Past when the repair first looks at them.
    await repairResourceStarts(env, new Date(Date.now() + 2 * 60_000));
    expect({
      user: await statusOf(holding, usersStart),
      userEngine: await runObject(usersStart).status(),
      // Sent again: the engine has it now.
      builderEngine: (await runObject(buildersStart).status()) !== undefined,
    }).toStrictEqual({
      user: "failed",
      userEngine: undefined,
      builderEngine: true,
    });
  });

  it("lets a start the engine took go on when the repair finds its App archived", async () => {
    const holding = await holdingApp();
    const { app } = holding;
    const runId = await holdingRun(holding);
    // Its confirmation was never recorded, and the App was archived since
    // without its cancels yet: the engine has the run, in flight, and
    // ending it is the archive's cancels' to do, not the repair's.
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE workflow_resource_runs SET status = 'starting' WHERE id = ?"
      ).bind(runId),
      env.DB.prepare("UPDATE apps SET archived_at = ? WHERE id = ?").bind(
        Date.now(),
        app
      ),
    ]);

    // Past when the repair first looks at it.
    await repairResourceStarts(env, new Date(Date.now() + 2 * 60_000));

    await expect(statusOf(holding, runId)).resolves.toBe("running");
  });

  it("keeps an archived App's page data and sharing as they are, an archive raced in included", async () => {
    const [builder, admin, user] = await Promise.all([
      signedInApi(idp, "builder"),
      signedInApi(idp, "admin"),
      signedInApi(idp, "user"),
    ]);
    const app = await liveApp(builder);
    const { generation } = await admin.api.dataPolicy.read(app);
    const by = await builder.api.whoami();
    const archive = async (): Promise<void> => {
      await archivedRaw(app);
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
      admin.api.dataPolicy.classify(app, "ordinary", generation)
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
