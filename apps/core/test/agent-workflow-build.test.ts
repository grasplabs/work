import { appErrors } from "@grasp-os/shared/apps";
import { chatIdSchema } from "@grasp-os/shared/ids";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { roleErrors } from "@grasp-os/shared/roles";
import {
  workflowNamespace,
  workflowResourceErrors,
} from "@grasp-os/shared/workflow-resources";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  chatOf,
  codeResults,
  codeStep,
  pointAtGateway,
  says,
} from "./agent-chat.ts";
import { fakeGateway } from "./ai-gateway.ts";
import type { GatewayReply } from "./ai-gateway.ts";
import { release, requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { signedInApi, unique } from "./sign-in.ts";

// `env.workflowBuild` and `env.workflows`' independent runs in a chat's
// code: the chat's agent building an independent workflow for its person,
// and following its runs. These tests start from the ways it can fail: the
// agent builds without a permission of its own, or past what its person
// may do (a workflow they have no role in, an App they don't build, any
// workflow for someone who doesn't build); it asks for a permission for
// itself rather than the workflow; a chat that read restricted data writes
// it into a definition others read; a turn creates without end; what it
// changes isn't recorded as its own; and it follows runs it wasn't let to.

const idp = mockIdp();

const returned = (text: string | undefined): unknown =>
  z.unknown().parse(JSON.parse(text?.replace("Returned:\n", "") ?? "null"));

/** Code that makes each call in turn: what it returned, or its message. */
const tryEach = (calls: Record<string, string>, before = ""): string =>
  `export default async (self, env) => {
    ${before}
    const tried = async (call) => { try { return await call(); } catch (error) { return error.message; } };
    const results = {};
    ${Object.entries(calls)
      .map(
        ([name, call]) =>
          `results[${JSON.stringify(name)}] = await tried(async () => ${call});`
      )
      .join("\n    ")}
    return results;
  };`;

const objectSchema = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

/** A definition of workflow `name` that passes and ends with `status`. */
const definitionOf = (name: string, status = "done"): string =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace: workflowNamespace,
      name,
      version: "1.0.0",
      title: name,
      metadata: {
        grasp: { profile: "grasp-open-workflow/1", params: {}, bindings: {} },
      },
    },
    input: { schema: objectSchema({ who: { type: "string" } }) },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: [{ finish: { set: { status } } }],
  });

/**
 * A chat of `role`'s person (a builder unless another is given) answered
 * by `replies`, with an App the builder released, and `grant`: the
 * agent's permission to build.
 */
const setUp = async (
  replies: GatewayReply[],
  role: "builder" | "user" = "builder"
) => {
  const admin = await signedInApi(idp, "admin");
  const builder = await signedInApi(idp, "builder");
  const { id: app } = await builder.api.apps.create({ name: "Ledger" });
  await release(builder, app, { "AGENTS.md": "# Ledger\n" });
  const person = role === "builder" ? builder : await signedInApi(idp, role);
  const chat = await chatOf(person.userId, ...replies);
  const grant = async (): Promise<string> =>
    await requestGranted(idp, admin, {
      subject: chat.agent,
      object: { type: "collection", collectionId: "apps" },
      actions: ["read", "write"],
      binding: "APP_LIBRARY",
    });
  return { admin, builder, person, app, chat, grant };
};

const denied = permissionErrors.create("permission.denied", {
  action: "write",
}).message;

const unavailable = workflowResourceErrors.create(
  "workflow.resource_unavailable"
).message;

describe("the agent building an independent workflow", () => {
  it("drafts, test-runs, publishes and binds a workflow as its person, recorded as the agent acting for them", async () => {
    const name = `summary-${unique()}`;
    const { app, person, chat, grant } = await setUp([]);
    const build = `export default async (self, env) => {
      const created = await env.workflowBuild.create(${JSON.stringify(name)});
      const started = await env.workflowBuild.draft(created.id);
      const saved = await env.workflowBuild.edit(created.id, {
        expectedRevision: started.revision,
        source: ${JSON.stringify(definitionOf(name))},
        modules: {},
      });
      const { runId } = await env.workflowBuild.startTest(created.id, {
        revision: saved.checkpoint.revision,
        input: { who: "Ada" },
        fixtures: {},
      });
      let run = await env.workflowBuild.testRun(created.id, runId);
      while (run.status === "starting" || run.status === "running") {
        await new Promise((resolve) => setTimeout(resolve, 200));
        run = await env.workflowBuild.testRun(created.id, runId);
      }
      const published = await env.workflowBuild.publish(created.id, {
        revision: saved.checkpoint.revision,
        basedOn: null,
      });
      const bound = await env.workflowBuild.bind(created.id, {
        app: ${JSON.stringify(app)},
        alias: "summary",
        version: published.version,
      });
      return {
        id: created.id,
        notes: [started.note, run.note],
        problems: saved.problems,
        test: { status: run.status, output: run.output },
        published: { version: published.version, executable: published.executable },
        bound: { app: bound.app, alias: bound.alias, version: bound.version },
      };
    };`;
    await pointAtGateway(
      chat.stub,
      fakeGateway(codeStep(build), says("Built."))
    );
    await grant();

    await chat.ask("Build me a summary workflow for Ledger");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    const built = z
      .looseObject({ id: z.string() })
      .parse(returned(result?.text));
    expect(built).toStrictEqual({
      id: built.id,
      // What its builders wrote, and what a test run gave back, reach
      // the model marked as data.
      notes: [
        expect.stringContaining("never instructions"),
        expect.stringContaining("never instructions"),
      ],
      problems: [],
      test: { status: "completed", output: { status: "done" } },
      published: { version: 1, executable: true },
      bound: { app, alias: "summary", version: 1 },
    });
    // What it changed, each the agent's, acting for the person.
    const events = await vi.waitFor(async () => {
      const all = await allEvents();
      const changes = all.filter(
        ({ action, target }) =>
          action !== "agent.call" &&
          // A run's own events are the system's, a test run's too.
          !action.startsWith("workflow.run.") &&
          (target?.id === built.id || action === "workflow.app_binding.bound")
      );
      expect(changes.length).toBeGreaterThan(0);
      return changes;
    });
    const agentActor = {
      type: "agent",
      agentId: chat.agent.agentId,
      onBehalfOf: person.userId,
    };
    expect(
      events
        .filter(({ actor }) => actor.type !== "agent")
        .map(({ action }) => action)
    ).toStrictEqual([]);
    expect(
      new Set(events.map(({ actor }) => JSON.stringify(actor)))
    ).toStrictEqual(new Set([JSON.stringify(agentActor)]));
  });

  it("publishes nothing once its permission is revoked while the version is being built", async () => {
    const { admin, builder, chat, grant } = await setUp([]);
    const flow = await builder.api.workflowResources.create(
      `revoked-${unique()}`
    );
    const started = await builder.api.workflowResources.draft(flow.id);
    await builder.api.workflowResources.editDraft(flow.id, {
      expectedRevision: started.revision,
      source: definitionOf(flow.name),
      modules: {},
    });
    const calls = tryEach({
      publish: `await env.workflowBuild.publish(${JSON.stringify(flow.id)}, { revision: 1, basedOn: null })`,
    });
    await pointAtGateway(
      chat.stub,
      fakeGateway(codeStep(calls), says("It was stopped."))
    );
    const granted = await grant();
    // The version's build is stored before its row: held there until the
    // grant is revoked, so the write comes after the revocation. Flags,
    // polled, not promises: each side runs in a request of its own.
    const { FILES: files } = env;
    const held = { storing: false, revoked: false };
    env.FILES = new Proxy(files, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== "function") {
          return value;
        }
        return async (...args: unknown[]): Promise<unknown> => {
          if (property === "put") {
            held.storing = true;
            while (!held.revoked) {
              // oxlint-disable-next-line no-await-in-loop -- polled
              await scheduler.wait(20);
            }
          }
          return await Reflect.apply(value, target, args);
        };
      },
    });
    try {
      const asked = chat.ask("Publish it");
      await vi.waitFor(() => {
        expect(held.storing).toBeTruthy();
      });
      await admin.api.permissions.revoke(granted);
      held.revoked = true;
      await asked;
    } finally {
      held.revoked = true;
      env.FILES = files;
    }

    // The revocation closed the run: its write was refused, and nothing
    // was published.
    const [result] = await codeResults(chat.stub, chat.chat.id);
    const versions = await builder.api.workflowResources.versions(flow.id);
    expect({
      isError: result?.isError,
      revoked: result?.text.startsWith("Error (revoked):"),
      versions,
    }).toStrictEqual({ isError: true, revoked: true, versions: [] });
  });

  it("binds nothing once its permission is revoked while the binding is being read", async () => {
    const { admin, builder, app, chat, grant } = await setUp([]);
    const flow = await builder.api.workflowResources.create(
      `unbound-${unique()}`
    );
    const started = await builder.api.workflowResources.draft(flow.id);
    await builder.api.workflowResources.editDraft(flow.id, {
      expectedRevision: started.revision,
      source: definitionOf(flow.name),
      modules: {},
    });
    await builder.api.workflowResources.publishDraft(flow.id, {
      revision: 1,
      basedOn: null,
    });
    const calls = tryEach({
      bind: `await env.workflowBuild.bind(${JSON.stringify(flow.id)}, { app: ${JSON.stringify(app)}, alias: "summary", version: 1 })`,
    });
    await pointAtGateway(
      chat.stub,
      fakeGateway(codeStep(calls), says("It was stopped."))
    );
    const granted = await grant();
    // The last read before the binding is saved (the binding it would
    // replace) is held until the grant is revoked, so the save comes after
    // the revocation. Flags, polled, not promises: each side runs in a
    // request of its own.
    const { DB: database } = env;
    const held = { reading: false, revoked: false };
    const replacingRead = /from "app_workflow_bindings"/u;
    const holding = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get: (target, property) => {
          if (property === "bind") {
            return (...values: unknown[]): D1PreparedStatement =>
              holding(target.bind(...values));
          }
          const value: unknown = Reflect.get(target, property);
          if (typeof value !== "function") {
            return value;
          }
          return async (...args: unknown[]): Promise<unknown> => {
            held.reading = true;
            while (!held.revoked) {
              // oxlint-disable-next-line no-await-in-loop -- polled
              await scheduler.wait(20);
            }
            const answered: unknown = await Reflect.apply(value, target, args);
            return answered;
          };
        },
      });
    env.DB = new Proxy(database, {
      get: (target, property) => {
        if (property === "prepare") {
          return (query: string): D1PreparedStatement => {
            const statement = target.prepare(query);
            return query.startsWith("select") &&
              replacingRead.test(query) &&
              !held.revoked
              ? holding(statement)
              : statement;
          };
        }
        const value: unknown = Reflect.get(target, property);
        if (typeof value !== "function") {
          return value;
        }
        return (...args: unknown[]): unknown => {
          const answered: unknown = Reflect.apply(value, target, args);
          return answered;
        };
      },
    });
    try {
      const asked = chat.ask("Bind it");
      await vi.waitFor(() => {
        expect(held.reading).toBeTruthy();
      });
      await admin.api.permissions.revoke(granted);
      held.revoked = true;
      await asked;
    } finally {
      held.revoked = true;
      env.DB = database;
    }

    // The revocation closed the run: its save was refused, and nothing
    // was bound.
    const [result] = await codeResults(chat.stub, chat.chat.id);
    const bound = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM app_workflow_bindings WHERE workflow_resource_id = ?"
    )
      .bind(flow.id)
      .first<{ n: number }>();
    expect({
      isError: result?.isError,
      revoked: result?.text.startsWith("Error (revoked):"),
      bound: bound?.n,
    }).toStrictEqual({ isError: true, revoked: true, bound: 0 });
  });

  it("names what a rebind replaced in its record", async () => {
    const { builder, app } = await setUp([]);
    const flow = await builder.api.workflowResources.create(
      `rebound-${unique()}`
    );
    const started = await builder.api.workflowResources.draft(flow.id);
    await builder.api.workflowResources.editDraft(flow.id, {
      expectedRevision: started.revision,
      source: definitionOf(flow.name),
      modules: {},
    });
    await builder.api.workflowResources.publishDraft(flow.id, {
      revision: 1,
      basedOn: null,
    });
    await builder.api.workflowResources.editDraft(flow.id, {
      expectedRevision: 1,
      source: definitionOf(flow.name, "later").replace('"1.0.0"', '"1.1.0"'),
      modules: {},
    });
    await builder.api.workflowResources.publishDraft(flow.id, {
      revision: 2,
      basedOn: 1,
    });
    const first = await builder.api.workflowResources.bindToApp(flow.id, {
      app,
      alias: "summary",
      version: 1,
    });
    const second = await builder.api.workflowResources.bindToApp(flow.id, {
      app,
      alias: "summary",
      version: 2,
    });

    const bound = await vi.waitFor(async () => {
      const events = await allEvents();
      const found = events
        .filter(
          ({ action, detail }) =>
            action === "workflow.app_binding.bound" &&
            detail.workflowId === flow.id
        )
        .map(({ detail }) => detail);
      expect(found).toHaveLength(2);
      return found;
    });
    expect(bound).toStrictEqual([
      {
        binding: first.id,
        alias: "summary",
        workflowId: flow.id,
        version: 1,
        replacedBinding: null,
        replacedWorkflowId: null,
        replacedVersion: null,
      },
      {
        binding: second.id,
        alias: "summary",
        workflowId: flow.id,
        version: 2,
        replacedBinding: first.id,
        replacedWorkflowId: flow.id,
        replacedVersion: 1,
      },
    ]);
  });

  it("builds nothing without the agent's permission, nor for a person who doesn't build", async () => {
    const calls = tryEach({
      create: `(await env.workflowBuild.create("refused-${unique()}")).id`,
    });
    const unpermitted = await setUp([codeStep(calls), says("No.")]);
    await unpermitted.chat.ask("Build a workflow");
    const user = await setUp([codeStep(calls), says("No.")], "user");
    await user.grant();
    await user.chat.ask("Build a workflow");

    const [refused] = await codeResults(
      unpermitted.chat.stub,
      unpermitted.chat.chat.id
    );
    const [forUser] = await codeResults(user.chat.stub, user.chat.chat.id);
    expect({
      unpermitted: returned(refused?.text),
      user: returned(forUser?.text),
    }).toStrictEqual({
      unpermitted: { create: denied },
      user: { create: roleErrors.create("role.forbidden").message },
    });
  });

  it("does nothing to a workflow its person has no role in, nor binds to an App they don't build", async () => {
    const { builder, chat, grant } = await setUp([]);
    const other = await signedInApi(idp, "builder");
    const theirs = await other.api.workflowResources.create(
      `theirs-${unique()}`
    );
    const { id: theirApp } = await other.api.apps.create({ name: "Theirs" });
    const mine = await builder.api.workflowResources.create(`mine-${unique()}`);
    const started = await builder.api.workflowResources.draft(mine.id);
    await builder.api.workflowResources.editDraft(mine.id, {
      expectedRevision: started.revision,
      source: definitionOf(mine.name),
      modules: {},
    });
    await builder.api.workflowResources.publishDraft(mine.id, {
      revision: 1,
      basedOn: null,
    });
    const id = JSON.stringify(theirs.id);
    const calls = tryEach({
      draft: `await env.workflowBuild.draft(${id})`,
      edit: `await env.workflowBuild.edit(${id}, { expectedRevision: 0, source: "{}", modules: {} })`,
      startTest: `await env.workflowBuild.startTest(${id}, { revision: 1, input: {}, fixtures: {} })`,
      testRun: `await env.workflowBuild.testRun(${id}, "run-1")`,
      publish: `await env.workflowBuild.publish(${id}, { revision: 1, basedOn: null })`,
      bindTheirs: `await env.workflowBuild.bind(${id}, { app: ${JSON.stringify(theirApp)}, alias: "x", version: 1 })`,
      bindToTheirApp: `await env.workflowBuild.bind(${JSON.stringify(mine.id)}, { app: ${JSON.stringify(theirApp)}, alias: "x", version: 1 })`,
      requestTheirs: `await env.workflowBuild.requestPermission(${id}, { object: { type: "workflow", workflowId: ${JSON.stringify(mine.id)} }, actions: ["start"], binding: "CHILD" })`,
    });
    await pointAtGateway(chat.stub, fakeGateway(codeStep(calls), says("No.")));
    await grant();

    await chat.ask("Change their workflow");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    expect(returned(result?.text)).toStrictEqual({
      draft: unavailable,
      edit: unavailable,
      startTest: unavailable,
      testRun: unavailable,
      publish: unavailable,
      bindTheirs: appErrors.create("app.not_found").message,
      bindToTheirApp: appErrors.create("app.not_found").message,
      requestTheirs: unavailable,
    });
    // Nothing was bound, and nothing asked for.
    const bindings = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM app_workflow_bindings WHERE workflow_resource_id IN (?, ?)"
    )
      .bind(theirs.id, mine.id)
      .first<{ n: number }>();
    expect(bindings?.n).toBe(0);
  });

  it("asks for a permission for the workflow alone, whatever subject the code names, and it grants nothing", async () => {
    const { builder, chat, grant } = await setUp([]);
    const mine = await builder.api.workflowResources.create(`asks-${unique()}`);
    const child = await builder.api.workflowResources.create(
      `child-${unique()}`
    );
    const calls = tryEach({
      requested: `await env.workflowBuild.requestPermission(${JSON.stringify(mine.id)}, {
        subject: ${JSON.stringify(chat.agent)},
        object: { type: "workflow", workflowId: ${JSON.stringify(child.id)} },
        actions: ["start"],
        binding: "CHILD",
      })`,
    });
    await pointAtGateway(
      chat.stub,
      fakeGateway(codeStep(calls), says("Asked."))
    );
    await grant();

    await chat.ask("Ask for what the workflow needs");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    const { requested } = z
      .object({ requested: z.object({ id: z.string(), status: z.string() }) })
      .parse(returned(result?.text));
    const row = await env.DB.prepare(
      "SELECT subject_type, subject_id, status, requested_by FROM permissions WHERE id = ?"
    )
      .bind(requested.id)
      .first();
    expect({ status: requested.status, row }).toStrictEqual({
      status: "requested",
      row: {
        subject_type: "workflow",
        subject_id: mine.id,
        status: "requested",
        requested_by: builder.userId,
      },
    });
  });

  it("writes no workflow from a restricted chat", async () => {
    const calls = tryEach({
      create: `(await env.workflowBuild.create("restricted-${unique()}")).id`,
    });
    const { chat, grant } = await setUp([codeStep(calls), says("No.")]);
    await grant();
    await runInDurableObject(chat.stub, (instance) =>
      instance.restrictChat(chatIdSchema.parse(chat.chat.id))
    );

    await chat.ask("Build a workflow now");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    expect(returned(result?.text)).toStrictEqual({
      create: permissionErrors.create("permission.restricted").message,
    });
  });

  it("creates at most three Apps and workflows a question", async () => {
    const suffix = unique();
    const calls = tryEach({
      app: `(await env.build.create({ name: "One" })).name`,
      first: `(await env.workflowBuild.create("first-${suffix}")).name`,
      second: `(await env.workflowBuild.create("second-${suffix}")).name`,
      third: `await env.workflowBuild.create("third-${suffix}")`,
    });
    const { chat, grant } = await setUp([codeStep(calls), says("Enough.")]);
    await grant();

    await chat.ask("Make many");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    expect(returned(result?.text)).toStrictEqual({
      app: "One",
      first: `first-${suffix}`,
      second: `second-${suffix}`,
      third: workflowResourceErrors.create("workflow.creates_exhausted")
        .message,
    });
  });
});

describe("the agent following independent workflows", () => {
  it("lists and follows a workflow's runs only once it may read it, never what a run returned", async () => {
    const { admin, builder, chat } = await setUp([]);
    const flow = await builder.api.workflowResources.create(
      `followed-${unique()}`
    );
    const started = await builder.api.workflowResources.draft(flow.id);
    await builder.api.workflowResources.editDraft(flow.id, {
      expectedRevision: started.revision,
      source: definitionOf(flow.name),
      modules: {},
    });
    await builder.api.workflowResources.publishDraft(flow.id, {
      revision: 1,
      basedOn: null,
    });
    const { id: run } = await builder.api.workflowResources.start(flow.id, {
      version: 1,
      input: { who: "Ada" },
      key: `key-${unique()}`,
    });
    const id = JSON.stringify(flow.id);
    const calls = tryEach({
      independent: "(await env.workflows.independent()).map(({ id }) => id)",
      runs: `await env.workflows.independentRuns(${id})`,
    });
    await pointAtGateway(
      chat.stub,
      fakeGateway(
        codeStep(calls),
        says("Not yet."),
        codeStep(calls),
        says("There.")
      )
    );

    await chat.ask("How is my workflow doing?");
    await requestGranted(idp, admin, {
      subject: chat.agent,
      object: { type: "workflow", workflowId: flow.id },
      actions: ["read"],
      binding: "FOLLOWED",
    });
    await chat.ask("And now?");

    const [before, after] = await codeResults(chat.stub, chat.chat.id);
    const followed = z
      .object({
        independent: z.array(z.string()),
        runs: z.array(z.record(z.string(), z.unknown())),
      })
      .parse(returned(after?.text));
    expect({
      before: returned(before?.text),
      independent: followed.independent,
      runs: followed.runs.map((listed) => ({
        id: listed.id,
        keys: Object.keys(listed).toSorted(),
      })),
    }).toStrictEqual({
      before: {
        independent: [],
        runs: permissionErrors.create("permission.denied", { action: "read" })
          .message,
      },
      independent: [flow.id],
      runs: [
        {
          id: run,
          keys: [
            "createdAt",
            "endedAt",
            "id",
            "principal",
            "status",
            "version",
            "workflowId",
          ],
        },
      ],
    });
  });
});
