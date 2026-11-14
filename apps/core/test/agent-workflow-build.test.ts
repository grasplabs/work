import { checkExpression } from "@grasp-os/runtime/check";
import { chatIdSchema } from "@grasp-os/shared/ids";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import {
  brainActions,
  filesActions,
  stepListPaths,
  workflowSchemaUrl,
} from "@grasp-os/workflow-schema/format";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { chatWork } from "../src/drafts.ts";
import {
  chatOf,
  codeResults,
  codeStep,
  readApiStep,
  says,
} from "./agent-chat.ts";
import { release, requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { fakeProvider } from "./model-provider.ts";
import type { ProviderReply } from "./model-provider.ts";
import { signedInApi, unique } from "./sign-in.ts";
import { publishOverRpc } from "./workflow-publishing.ts";

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

/**
 * An action a call form of the declaration names, as it lists each: its
 * name (a dotted path, `skills.select`), then (past a line break, as the
 * JSON body escapes it) its request.
 */
const declaredAction = /`(?<action>[a-z]+(?:\.[a-z]+)*)`(?:\\n +\*)? +\(/gu;

/** A call form of the declaration, `{ <kind>, action, args }`, at a line's start. */
const callForm = /\\n +\* +`\{ [a-z]+, (?:action|function),/gu;

/**
 * The actions the declaration's call form `{ <kind>, action, args }`
 * names: those of its clause, up to the next call form.
 */
const declaredActionsOf = (declared: string, kind: string): string[] => {
  const start = declared.indexOf(`\`{ ${kind}, action, args }\``);
  const [next] = declared.slice(start).matchAll(callForm);
  const clause = declared.slice(start, start + (next?.index ?? 0));
  return [...clause.matchAll(declaredAction)].map(
    (match) => match.groups?.action ?? ""
  );
};

/** An example `{ "$expr": "…" }` in a request's body, as JSON escapes it. */
const exampleExpression = /\\"\$expr\\": \\"(?<source>[^"\\]*)\\"/gu;

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

const objectSchema = (fields: Record<string, unknown>) => ({
  kind: "object",
  fields,
});

/** A definition that passes and ends with `status`. */
const definitionOf = (status = "done"): string =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    args: objectSchema({ who: { kind: "string" } }),
    returns: objectSchema({ status: { kind: "string" } }),
    result: { status },
    steps: [],
  });

/**
 * A chat of `role`'s person (a builder unless another is given) answered
 * by `replies`, with an App the builder released, and `grant`: the
 * agent's permission to build.
 */
const setUp = async (
  replies: ProviderReply[],
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
      actions: ["read"],
      binding: "APP_LIBRARY",
    });
  return { admin, builder, person, app, chat, grant };
};

const unavailable = workflowResourceErrors.create(
  "workflow.resource_unavailable"
).message;

describe("the agent building an independent workflow", () => {
  it("drafts and test-runs a workflow as its person, recorded as the agent acting for them and as its chat's work, and never publishes it", async () => {
    const name = `summary-${unique()}`;
    const { person, chat, grant } = await setUp([]);
    // Made as Build it makes one, and published once by the person: the
    // agent creates and publishes none.
    const made = await person.api.workflowResources.create(name);
    await publishOverRpc(person.api, made.id, definitionOf("first"));
    const before = await allEvents();
    const earlier = new Set(before.map(({ id }) => id));
    const build = `export default async (self, env) => {
      const created = { id: ${JSON.stringify(made.id)} };
      const started = await env.workflowBuild.draft(created.id);
      const saved = await env.workflowBuild.write(
        created.id,
        ${JSON.stringify(definitionOf())},
        { revision: started.revision },
      );
      const { runId } = await env.workflowBuild.startTest(created.id, {
        revision: saved.revision,
        args: { who: "Ada" },
        fixtures: {},
      });
      let run = await env.workflowBuild.testRun(created.id, runId);
      while (run.status === "starting" || run.status === "running") {
        await new Promise((resolve) => setTimeout(resolve, 200));
        run = await env.workflowBuild.testRun(created.id, runId);
      }
      return {
        id: created.id,
        notes: [started.note, run.note],
        problems: saved.problems,
        test: { status: run.status, result: run.result },
      };
    };`;
    await fakeProvider(codeStep(build), says("Built."));
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
      test: { status: "completed", result: { status: "done" } },
    });
    // Its edit is the chat's work, waiting in the draft for the person to
    // publish: the workflow's live version is still the person's.
    const worked = await chatWork(env, chat.chat.id);
    const draft = await person.api.drafts.get({
      kind: "workflow",
      id: made.id,
    });
    const versions = await person.api.versions.list({
      kind: "workflow",
      id: made.id,
    });
    expect({
      worked: worked.map(({ kind, id }) => ({ kind, id })),
      changed: draft.changed,
      versions: versions.length,
    }).toStrictEqual({
      worked: [{ kind: "workflow", id: made.id }],
      changed: ["workflow.json"],
      versions: 1,
    });
    // What it changed, each the agent's, acting for the person.
    const events = await vi.waitFor(async () => {
      const all = await allEvents();
      const changes = all.filter(
        ({ id, action, target }) =>
          !earlier.has(id) &&
          action !== "agent.call" &&
          // Made by the person, as Build it makes it.
          action !== "workflow.created" &&
          // A run's own events are the system's, a test run's too.
          !action.startsWith("workflow.run.") &&
          target?.id === built.id
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

  it("drafts a model step from the catalog it reads, one step at a time as the canvas does, which publishes as a catalog binding, not code", async () => {
    const name = `expenses-${unique()}`;
    const { admin, person, chat, grant } = await setUp([]);
    const made = await person.api.workflowResources.create(name);
    const judge = `judge-${unique()}`;
    await admin.api.workflowResources.publishContract({
      key: judge,
      kind: "model",
    });
    const definition = JSON.stringify({
      $schema: workflowSchemaUrl,
      args: objectSchema({ claim: { kind: "string" } }),
      returns: objectSchema({ summary: { kind: "string" } }),
      result: { summary: { $expr: "assess.summary" } },
      permissions: { ai: { contract: judge } },
      steps: [
        {
          id: "assess",
          type: "generate",
          instructions: "Summarise the expense claim.",
          input: { claim: { $expr: "args.claim" } },
          returns: objectSchema({ summary: { kind: "string" } }),
        },
      ],
    });
    const build = `export default async (self, env) => {
      const catalog = await env.workflowBuild.catalog();
      const created = { id: ${JSON.stringify(made.id)} };
      const started = await env.workflowBuild.draft(created.id);
      const saved = await env.workflowBuild.write(
        created.id,
        ${JSON.stringify(definition)},
        { revision: started.revision },
      );
      const renamed = await env.workflowBuild.define(
        created.id,
        {
          kind: "change",
          pointer: "/steps/0",
          step: { ...JSON.parse(saved.source).steps[0], title: "Assess the claim" },
        },
        { revision: saved.revision },
      );
      const paused = await env.workflowBuild.define(
        created.id,
        { kind: "insert", list: "/steps", index: 0, id: "settle", step: { type: "wait", for: "1 second" } },
        { revision: renamed.revision },
      );
      return {
        catalog: catalog.filter(({ key }) => key === ${JSON.stringify(judge)}),
        problems: paused.problems,
        steps: JSON.parse(paused.source).steps.map(({ id, title }) => [id, title ?? null]),
        revision: paused.revision,
      };
    };`;
    const provider = await fakeProvider(
      readApiStep("workflowBuild"),
      codeStep(build),
      says("Drafted.")
    );
    await grant();

    await chat.ask("Build me a workflow that summarises expense claims");

    // The declaration it read gives each of the format's step types, so
    // a judgement needn't be written as code.
    const declared = JSON.stringify(provider.requests[1]?.body);
    expect(
      Object.keys(stepListPaths).filter(
        (type) => !declared.includes(`\`${type}\`: `)
      )
    ).toStrictEqual([]);
    // And the actions of the run's files and the Brain it teaches are
    // exactly the ones the format takes.
    expect({
      files: declaredActionsOf(declared, "files"),
      brain: declaredActionsOf(declared, "brain"),
    }).toStrictEqual({ files: [...filesActions], brain: [...brainActions] });
    // And each example expression in it is one the format takes, reading
    // the steps its examples name by their IDs.
    const exampleSteps = ["send", "invoice", "extract", "invoiceBody"];
    const examples = [...declared.matchAll(exampleExpression)].map(
      (match) => match.groups?.source ?? ""
    );
    expect(examples.length).toBeGreaterThan(0);
    expect(
      examples.filter(
        (source) =>
          !checkExpression(source, {
            roots: exampleSteps,
          }).ok
      )
    ).toStrictEqual([]);
    const [result] = await codeResults(chat.stub, chat.chat.id);
    const drafted = z
      .looseObject({ revision: z.int() })
      .parse(returned(result?.text));
    // The person publishes what it drafted.
    const subject = { kind: "workflow", id: made.id } as const;
    const live = await person.api.drafts.publish(subject, drafted.revision);
    const version = await person.api.versions.get(subject, live.version);
    expect({
      ...drafted,
      bindings:
        "resourceId" in version
          ? version.bindings.map(({ alias, kind, contractId }) => ({
              alias,
              kind,
              contractId,
            }))
          : [],
    }).toStrictEqual({
      catalog: [{ key: judge, kind: "model" }],
      problems: [],
      steps: [
        ["settle", null],
        ["assess", "Assess the claim"],
      ],
      revision: drafted.revision,
      bindings: [{ alias: "ai", kind: "model", contractId: judge }],
    });
  });

  it("builds for a builder with no permission of the agent's own, and nothing for a person who doesn't build", async () => {
    const calls = (workflow: string) =>
      tryEach({
        draft: `typeof (await env.workflowBuild.draft(${JSON.stringify(workflow)})).revision`,
      });
    const ungranted = await setUp([]);
    const own = await ungranted.person.api.workflowResources.create(
      `own-${unique()}`
    );
    await fakeProvider(codeStep(calls(own.id)), says("Read."));
    await ungranted.chat.ask("Work on my workflow");
    const theirs = await ungranted.builder.api.workflowResources.create(
      `theirs-${unique()}`
    );
    const asUser = await setUp([], "user");
    await asUser.grant();
    await fakeProvider(codeStep(calls(theirs.id)), says("No."));
    await asUser.chat.ask("Work on that workflow");

    const [read] = await codeResults(
      ungranted.chat.stub,
      ungranted.chat.chat.id
    );
    const [forUser] = await codeResults(asUser.chat.stub, asUser.chat.chat.id);
    expect({
      ungranted: returned(read?.text),
      user: returned(forUser?.text),
    }).toStrictEqual({
      ungranted: { draft: "number" },
      user: { draft: unavailable },
    });
  });

  it("does nothing to a workflow its person has no role in", async () => {
    const { builder, chat, grant } = await setUp([]);
    const other = await signedInApi(idp, "builder");
    const theirs = await other.api.workflowResources.create(
      `theirs-${unique()}`
    );
    const mine = await builder.api.workflowResources.create(`mine-${unique()}`);
    await publishOverRpc(builder.api, mine.id, definitionOf());
    const id = JSON.stringify(theirs.id);
    const calls = tryEach({
      draft: `await env.workflowBuild.draft(${id})`,
      write: `await env.workflowBuild.write(${id}, "{}", { revision: 0 })`,
      define: `await env.workflowBuild.define(${id}, { kind: "insert", list: "/steps", index: 0, id: "settle", step: { type: "wait", for: "1 second" } }, { revision: 0 })`,
      startTest: `await env.workflowBuild.startTest(${id}, { revision: 1, args: {}, fixtures: {} })`,
      testRun: `await env.workflowBuild.testRun(${id}, "run-1")`,
      requestTheirs: `await env.workflowBuild.requestPermission(${id}, { object: { type: "workflow", workflowId: ${JSON.stringify(mine.id)} }, actions: ["start"], binding: "CHILD" })`,
    });
    await fakeProvider(codeStep(calls), says("No."));
    await grant();

    await chat.ask("Change their workflow");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    expect(returned(result?.text)).toStrictEqual({
      draft: unavailable,
      write: unavailable,
      define: unavailable,
      startTest: unavailable,
      testRun: unavailable,
      requestTheirs: unavailable,
    });
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
    await fakeProvider(codeStep(calls), says("Asked."));
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

  it("writes no workflow from a restricted chat, though building needs no grant", async () => {
    const { chat, person } = await setUp([]);
    const own = await person.api.workflowResources.create(
      `restricted-${unique()}`
    );
    await fakeProvider(
      codeStep(
        tryEach({
          write: `(await env.workflowBuild.write(${JSON.stringify(own.id)}, ${JSON.stringify(definitionOf())}, { revision: 0 })).revision`,
        })
      ),
      says("No.")
    );
    await runInDurableObject(chat.stub, (instance) =>
      instance.restrictChat(chatIdSchema.parse(chat.chat.id))
    );

    await chat.ask("Build a workflow now");

    const [result] = await codeResults(chat.stub, chat.chat.id);
    expect(returned(result?.text)).toStrictEqual({
      write: permissionErrors.create("permission.restricted").message,
    });
  });
});

describe("the agent following independent workflows", () => {
  it("lists and follows a workflow's runs only once it may read it, never what a run returned", async () => {
    const { admin, builder, chat } = await setUp([]);
    const flow = await builder.api.workflowResources.create(
      `followed-${unique()}`
    );
    await publishOverRpc(builder.api, flow.id, definitionOf());
    const { id: run } = await builder.api.workflowResources.start(flow.id, {
      expected: 1,
      args: { who: "Ada" },
      key: `key-${unique()}`,
    });
    const id = JSON.stringify(flow.id);
    const calls = tryEach({
      independent: "(await env.workflows.independent()).map(({ id }) => id)",
      runs: `await env.workflows.independentRuns(${id})`,
    });
    await fakeProvider(
      codeStep(calls),
      says("Not yet."),
      codeStep(calls),
      says("There.")
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
