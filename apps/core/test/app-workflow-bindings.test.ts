import { v } from "@grasp-os/runtime/app";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { bindWorkflowToApp } from "../src/app-workflow-bindings.ts";
import { appOf, commitApp } from "./app-definitions.ts";
import { racingDb, release } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import {
  greetingOf,
  jobEventsContract,
  jobEventsDeclared,
  jobWaitingOf,
  jsonWorkflowAppsOf,
  requestsApp,
} from "./json-workflow-apps.ts";
import {
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";
import { publishOverRpc } from "./workflow-publishing.ts";

// Reading which workflow versions an App binds (`workflowResources.
// appBindings`), over the session's RPC as the domain page reads it, next
// to binding and removing one. A binding is the App's configuration, set by
// its builders, so it is read as it is set: by the App's builders, never
// by someone who only uses the App, nor by anyone it isn't shared with
// (who is told there is no such App), nor by Grasp staff, who never decide
// what a client's App runs.

const idp = mockIdp();

/** An App and a workflow with two published versions, both the builder's. */
const setUp = async () => {
  const builder = await signedInApi(idp, "builder");
  const { id: app } = await builder.api.apps.create({ name: "Ledger" });
  const flow = await builder.api.workflowResources.create(`bound-${unique()}`);
  await publishOverRpc(
    builder.api,
    flow.id,
    greetingOf(undefined, "Version 1")
  );
  await publishOverRpc(
    builder.api,
    flow.id,
    greetingOf(undefined, "Version 1.1")
  );
  return { builder, app, flow };
};

describe("an App's workflow bindings, as its builders read them", () => {
  it("lists what each alias binds now, by alias, without what was replaced or removed", async () => {
    const { builder, app, flow } = await setUp();
    const api = builder.api.workflowResources;
    await api.bindToApp(flow.id, { app, alias: "summary", version: 1 });
    // A rebind replaces the alias's binding.
    const summary = await api.bindToApp(flow.id, {
      app,
      alias: "summary",
      version: 2,
    });
    const archive = await api.bindToApp(flow.id, {
      app,
      alias: "archive",
      version: 1,
    });
    const removed = await api.bindToApp(flow.id, {
      app,
      alias: "draft",
      version: 1,
    });
    await api.unbindFromApp(removed.id);

    const listed = await api.appBindings(app);

    expect(
      listed.map(({ id, alias, workflowId, version, boundBy }) => ({
        id,
        alias,
        workflowId,
        version,
        boundBy,
      }))
    ).toStrictEqual([
      {
        id: archive.id,
        alias: "archive",
        workflowId: flow.id,
        version: 1,
        boundBy: builder.userId,
      },
      {
        id: summary.id,
        alias: "summary",
        workflowId: flow.id,
        version: 2,
        boundBy: builder.userId,
      },
    ]);
  });

  it("keeps an archived App's bindings readable for when it is restored", async () => {
    const { builder, app, flow } = await setUp();
    const bound = await builder.api.workflowResources.bindToApp(flow.id, {
      app,
      alias: "summary",
      version: 1,
    });
    await builder.api.apps.archive(app);

    const listed = await builder.api.workflowResources.appBindings(app);

    expect(listed.map(({ id }) => id)).toStrictEqual([bound.id]);
  });

  it("is read by its builders, and by nobody else, never Grasp staff", async () => {
    const { builder, app, flow } = await setUp();
    await builder.api.workflowResources.bindToApp(flow.id, {
      app,
      alias: "summary",
      version: 1,
    });
    const [sharedBuilder, user, stranger] = await Promise.all([
      signedInApi(idp, "builder"),
      signedInApi(idp, "user"),
      signedInApi(idp, "builder"),
    ]);
    await builder.api.apps.members.add(app, {
      type: "person",
      id: sharedBuilder.userId,
      role: "builder",
    });
    await builder.api.apps.members.add(app, {
      type: "person",
      id: user.userId,
      role: "user",
    });
    const { core } = await openRpc(
      await signedIn(idp, "grasp-staff", staffPerson())
    );
    const staff = core.authenticate();

    const outcomes = {
      sharedBuilder: await outcome(
        sharedBuilder.api.workflowResources.appBindings(app)
      ),
      // A draft is open to its builders only: to whoever only uses it,
      // it isn't there.
      user: await outcome(user.api.workflowResources.appBindings(app)),
      stranger: await outcome(stranger.api.workflowResources.appBindings(app)),
      staff: await outcome(staff.workflowResources.appBindings(app)),
      invalid: await outcome(builder.api.workflowResources.appBindings("")),
    };

    expect(outcomes).toStrictEqual({
      sharedBuilder: "ok",
      user: "app.not_found",
      stranger: "app.not_found",
      staff: "role.forbidden",
      invalid: "app.not_found",
    });
  });
});

describe("binding a workflow its App's current version declares", () => {
  it("refuses a version whose events, listen tasks or decisions aren't what that version declares, keeping the binding, and binds one that has them, or any version under an alias it doesn't declare or to an App with no current version", async () => {
    const [admin, builder] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInApi(idp, "builder"),
    ]);
    const events = await jobEventsContract(admin);
    const decision = `approval-${unique()}`;
    await admin.api.workflowResources.publishContract({
      key: decision,
      kind: "decision",
      input: JSON.stringify(v.object({ who: v.string() }).descriptor),
      response: JSON.stringify(v.object({ comment: v.string() }).descriptor),
    });
    const flow = await builder.api.workflowResources.create(
      `bound-${unique()}`
    );
    // Version 1 as the App declares it; 2 with another event, 3 with its
    // task renamed, 4 with a decision; 5 as 1, but for its greeting.
    const versions = [
      jobWaitingOf(events),
      jobWaitingOf(events, { more: ["laterEvents"] }),
      jobWaitingOf(events, { task: "awaitJob" }),
      jobWaitingOf(events, { decision }),
      jobWaitingOf(events, { label: "Version 5" }),
    ];
    for (const definition of versions) {
      // oxlint-disable-next-line no-await-in-loop -- each version on the last
      await publishOverRpc(builder.api, flow.id, definition);
    }
    const { id: app } = await builder.api.apps.create({ name: "Requests" });
    const api = builder.api.workflowResources;
    const bind = async (version: number, alias = "review", to = app) =>
      await outcome(api.bindToApp(flow.id, { app: to, alias, version }));
    const bound = async () => {
      const listed = await api.appBindings(app);
      return listed.map(({ alias, version }) => ({ alias, version }));
    };
    // No version current yet: what it declares is the one it makes current.
    const beforeCurrent = await bind(2);
    await bind(1);
    await release(builder, app, requestsApp("review", jobEventsDeclared));

    const refused = {
      events: await bind(2),
      listens: await bind(3),
      decisions: await bind(4),
    };
    const kept = await bound();
    const sameContract = await bind(5);
    const undeclaredAlias = await bind(2, "other");
    const { id: newApp } = await builder.api.apps.create({ name: "Fresh" });
    const noCurrentVersion = await bind(4, "review", newApp);

    expect({
      beforeCurrent,
      refused,
      kept,
      sameContract,
      undeclaredAlias,
      noCurrentVersion,
      after: await bound(),
    }).toStrictEqual({
      beforeCurrent: "ok",
      refused: {
        events: "workflow.app_binding_contract_changed",
        listens: "workflow.app_binding_contract_changed",
        decisions: "workflow.app_binding_contract_changed",
      },
      kept: [{ alias: "review", version: 1 }],
      sameContract: "ok",
      undeclaredAlias: "ok",
      noCurrentVersion: "ok",
      after: [
        { alias: "other", version: 2 },
        { alias: "review", version: 5 },
      ],
    });
  });

  it("refuses a binding checked against the current version once another version is made current before it lands, keeping the binding", async () => {
    const { signedIn: signedInPerson } = jsonWorkflowAppsOf(idp);
    const [admin, builder] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInPerson("builder"),
    ]);
    const events = await jobEventsContract(admin);
    const api = builder.api.workflowResources;
    const flow = await api.create(`bound-${unique()}`);
    // Two versions of the contract the App's current version declares.
    for (const label of ["Version 1", "Version 2"]) {
      // oxlint-disable-next-line no-await-in-loop -- each version on the last
      await publishOverRpc(
        builder.api,
        flow.id,
        jobWaitingOf(events, { label })
      );
    }
    const { id: app } = await builder.api.apps.create({ name: "Requests" });
    await api.bindToApp(flow.id, { app, alias: "review", version: 1 });
    const declaring = requestsApp("review", jobEventsDeclared);
    await release(builder, app, declaring);
    // Another version of the App, declaring the same of the workflow: made
    // current by a builder while the binding is on its way.
    const { version: another } = await commitApp(
      builder.api.apps.files,
      app,
      appOf(declaring.definition, {
        ...declaring.files,
        "src/routes/index.tsx": (
          declaring.files["src/routes/index.tsx"] ?? ""
        ).replace("Requests", "Open requests"),
      }),
      "Rename the page"
    );
    const racing = {
      ...env,
      DB: racingDb(async () => {
        await builder.api.versions.rollback({ kind: "app", id: app }, another);
      }, /insert into "app_workflow_bindings"/iu),
    };

    const raced = await outcome(
      bindWorkflowToApp(racing, builder.acting, flow.id, {
        app,
        alias: "review",
        version: 2,
      })
    );
    const listed = await api.appBindings(app);

    expect({
      raced,
      kept: listed.map(({ alias, version }) => ({ alias, version })),
      // Checked against the version current now, it binds.
      again: await outcome(
        api.bindToApp(flow.id, { app, alias: "review", version: 2 })
      ),
    }).toStrictEqual({
      raced: "workflow.binding_conflict",
      kept: [{ alias: "review", version: 1 }],
      again: "ok",
    });
  });
});
