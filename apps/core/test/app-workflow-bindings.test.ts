import { v } from "@grasp-os/runtime/app";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { bindWorkflowToApp } from "../src/app-workflow-bindings.ts";
import { appKind } from "../src/apps.ts";
import { rollback } from "../src/publish.ts";
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
import { publishDefinition, publishOverRpc } from "./workflow-publishing.ts";

// Reading which workflows an App binds (`workflowResources.
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
    await api.bindToApp(flow.id, { app, alias: "summary" });
    // A rebind replaces the alias's binding.
    const summary = await api.bindToApp(flow.id, {
      app,
      alias: "summary",
    });
    const archive = await api.bindToApp(flow.id, {
      app,
      alias: "archive",
    });
    const removed = await api.bindToApp(flow.id, {
      app,
      alias: "draft",
    });
    await api.unbindFromApp(removed.id);

    const listed = await api.appBindings(app);

    expect(
      listed.map(({ id, alias, workflowId, boundBy }) => ({
        id,
        alias,
        workflowId,
        boundBy,
      }))
    ).toStrictEqual([
      {
        id: archive.id,
        alias: "archive",
        workflowId: flow.id,
        boundBy: builder.userId,
      },
      {
        id: summary.id,
        alias: "summary",
        workflowId: flow.id,
        boundBy: builder.userId,
      },
    ]);
  });

  it("keeps an archived App's bindings readable for when it is restored", async () => {
    const { builder, app, flow } = await setUp();
    const bound = await builder.api.workflowResources.bindToApp(flow.id, {
      app,
      alias: "summary",
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
  /** An admin, a builder, the events contract and an empty workflow of theirs. */
  const contractSetUp = async () => {
    const { signedIn: signedInPerson } = jsonWorkflowAppsOf(idp);
    const [admin, builder] = await Promise.all([
      signedInApi(idp, "admin"),
      signedInPerson("builder"),
    ]);
    const events = await jobEventsContract(admin);
    const api = builder.api.workflowResources;
    const flow = await api.create(`bound-${unique()}`);
    const { id: app } = await builder.api.apps.create({ name: "Requests" });
    const bind = async (alias = "review", to = app) =>
      await outcome(api.bindToApp(flow.id, { app: to, alias }));
    const bound = async () => {
      const listed = await api.appBindings(app);
      return listed.map(({ alias }) => alias);
    };
    const publish = async (definition: string) =>
      await outcome(publishOverRpc(builder.api, flow.id, definition));
    return { admin, builder, events, api, flow, app, bind, bound, publish };
  };

  it("refuses a workflow whose live version's events, listen tasks or decisions aren't what the App declares, and binds one whose live version has them, or under an alias it doesn't declare, or to an App with no current version", async () => {
    const { admin, builder, events, app, bind, bound, publish } =
      await contractSetUp();
    const decision = `approval-${unique()}`;
    await admin.api.workflowResources.publishContract({
      key: decision,
      kind: "decision",
      input: JSON.stringify(v.object({ who: v.string() }).descriptor),
      response: JSON.stringify(v.object({ comment: v.string() }).descriptor),
    });
    await release(builder, app, requestsApp("review", jobEventsDeclared));
    // Each live in turn: another event, its task renamed, a decision.
    const refused: Record<string, string> = {};
    for (const [name, definition] of [
      ["events", jobWaitingOf(events, { more: ["laterEvents"] })],
      ["listens", jobWaitingOf(events, { task: "awaitJob" })],
      ["decisions", jobWaitingOf(events, { decision })],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- each version on the last
      await publish(definition);
      // oxlint-disable-next-line no-await-in-loop -- bound as it is live
      refused[name] = await bind();
    }
    const unbound = await bound();
    // Version 4, as the App declares it, but for its greeting.
    await publish(jobWaitingOf(events, { label: "Version 4" }));
    const sameContract = await bind();
    const { id: newApp } = await builder.api.apps.create({ name: "Fresh" });

    expect({
      refused,
      unbound,
      sameContract,
      undeclaredAlias: await bind("other"),
      noCurrentVersion: await bind("review", newApp),
      after: await bound(),
    }).toStrictEqual({
      refused: {
        events: "workflow.app_binding_contract_changed",
        listens: "workflow.app_binding_contract_changed",
        decisions: "workflow.app_binding_contract_changed",
      },
      unbound: [],
      sameContract: "ok",
      undeclaredAlias: "ok",
      noCurrentVersion: "ok",
      after: ["other", "review"],
    });
  });

  it("checks a binding against the live version, whatever version was published since", async () => {
    const { builder, events, flow, app, bind, bound, publish } =
      await contractSetUp();
    await publish(jobWaitingOf(events));
    await release(builder, app, requestsApp("review", jobEventsDeclared));
    // Version 2 with another event, then rolled back from: it isn't live.
    await publish(jobWaitingOf(events, { more: ["laterEvents"] }));
    const whileLive = await bind();
    await builder.api.versions.rollback({ kind: "workflow", id: flow.id }, 1);

    expect({
      whileLive,
      rolledBack: await bind(),
      bound: await bound(),
    }).toStrictEqual({
      whileLive: "workflow.app_binding_contract_changed",
      rolledBack: "ok",
      bound: ["review"],
    });
  });

  it("takes an App's first version declaring what the live version has, and refuses a workflow version that changes what a bound App declares", async () => {
    const { builder, events, app, bind, publish } = await contractSetUp();
    await publish(jobWaitingOf(events, { more: ["laterEvents"] }));
    // An App with no current version declares nothing yet: bound to any.
    const boundFirst = await bind();
    const changed = await publish(jobWaitingOf(events));
    // Its first version declares what version 2, live now, has.
    const released = await outcome(
      release(builder, app, requestsApp("review", jobEventsDeclared))
    );

    expect({
      boundFirst,
      changed,
      released,
      // Bound and current: a version unlike what it declares never goes live.
      back: await publish(jobWaitingOf(events, { more: ["laterEvents"] })),
    }).toStrictEqual({
      boundFirst: "ok",
      changed: "ok",
      released: "ok",
      back: "workflow.app_binding_contract_changed",
    });
  });

  it("refuses whichever of an App's and its workflow's new version lands second over what the other checked", async () => {
    const { builder, events, api, flow, app, publish } = await contractSetUp();
    await publish(jobWaitingOf(events));
    const declaring = requestsApp("review", jobEventsDeclared);
    await release(builder, app, declaring);
    await api.bindToApp(flow.id, { app, alias: "review" });
    /** Another version of the App, declaring the same of the workflow. */
    const anotherApp = async (title: string) => {
      const { version } = await commitApp(
        builder.api.apps.files,
        app,
        appOf(declaring.definition, {
          ...declaring.files,
          "src/routes/index.tsx": (
            declaring.files["src/routes/index.tsx"] ?? ""
          ).replace("Requests", title),
        }),
        title
      );
      return version;
    };
    const second = await anotherApp("Open requests");
    // The workflow's version 2, of the same contract, goes live as the
    // App's version 2 is about to.
    const appRaced = await outcome(
      rollback(
        {
          ...env,
          DB: racingDb(async () => {
            await publishOverRpc(
              builder.api,
              flow.id,
              jobWaitingOf(events, { label: "Version 2" })
            );
          }, /^update "apps" set "current_version"/iu),
        },
        appKind,
        builder.acting,
        app,
        second
      )
    );
    const third = await anotherApp("All requests");
    // The App's version 3 goes live as the workflow's version 3 is about to.
    const workflowRaced = await outcome(
      publishDefinition(
        {
          ...env,
          DB: racingDb(async () => {
            await builder.api.versions.rollback(
              { kind: "app", id: app },
              third
            );
          }, /^update "workflow_resources" set "current_version"/iu),
        },
        builder.acting,
        flow.id,
        jobWaitingOf(events, { label: "Version 3" })
      )
    );
    const { currentVersion: appLive } = await builder.api.apps.get(app);
    const workflow = await api.get(flow.id);

    expect({
      appRaced,
      workflowRaced,
      appLive,
      workflowLive: workflow.currentVersion,
    }).toStrictEqual({
      appRaced: "draft.conflict",
      workflowRaced: "draft.conflict",
      appLive: third,
      workflowLive: 2,
    });
  });

  it("refuses a binding checked against the current version once another version is made current before it lands, keeping the binding", async () => {
    const { builder, events, api, flow, app } = await contractSetUp();
    // Two versions of the contract the App's current version declares.
    for (const label of ["Version 1", "Version 2"]) {
      // oxlint-disable-next-line no-await-in-loop -- each version on the last
      await publishOverRpc(
        builder.api,
        flow.id,
        jobWaitingOf(events, { label })
      );
    }
    await api.bindToApp(flow.id, { app, alias: "review" });
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
      })
    );
    const listed = await api.appBindings(app);

    expect({
      raced,
      kept: listed.map(({ alias }) => alias),
      // Checked against the version current now, it binds.
      again: await outcome(api.bindToApp(flow.id, { app, alias: "review" })),
    }).toStrictEqual({
      raced: "workflow.binding_conflict",
      kept: ["review"],
      again: "ok",
    });
  });
});
