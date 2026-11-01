import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { describe, expect, it } from "vite-plus/test";

import { mockIdp } from "./idp.ts";
import {
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  staffPerson,
  unique,
} from "./sign-in.ts";

// Reading which workflow versions an App binds (`workflowResources.
// appBindings`), over the session's RPC as the domain page reads it, next
// to binding and removing one. A binding is the App's configuration, set by
// its builders, so it is read as it is set: by the App's builders, never
// by someone who only uses the App, nor by anyone it isn't shared with
// (who is told there is no such App), nor by Grasp staff, who never decide
// what a client's App runs.

const idp = mockIdp();

const objectSchema = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

const definitionOf = (name: string, version: string): string =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace: workflowNamespace,
      name,
      version,
      title: name,
      metadata: {
        grasp: { profile: "grasp-open-workflow/1", params: {}, bindings: {} },
      },
    },
    input: { schema: objectSchema({ who: { type: "string" } }) },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: [{ finish: { set: { status: "done" } } }],
  });

/** An App and a workflow with two published versions, both the builder's. */
const setUp = async () => {
  const builder = await signedInApi(idp, "builder");
  const { id: app } = await builder.api.apps.create({ name: "Ledger" });
  const flow = await builder.api.workflowResources.create(`bound-${unique()}`);
  const started = await builder.api.workflowResources.draft(flow.id);
  await builder.api.workflowResources.editDraft(flow.id, {
    expectedRevision: started.revision,
    source: definitionOf(flow.name, "1.0.0"),
    modules: {},
  });
  await builder.api.workflowResources.publishDraft(flow.id, {
    revision: 1,
    basedOn: null,
  });
  await builder.api.workflowResources.editDraft(flow.id, {
    expectedRevision: 1,
    source: definitionOf(flow.name, "1.1.0"),
    modules: {},
  });
  await builder.api.workflowResources.publishDraft(flow.id, {
    revision: 2,
    basedOn: 1,
  });
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
