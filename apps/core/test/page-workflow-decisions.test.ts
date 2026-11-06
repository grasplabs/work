import { v } from "@grasp-os/sdk";
import {
  declaredWorkflows,
  generatedPaths,
  workflowFingerprint,
} from "@grasp-os/sdk/host";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { appIdSchema } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import type { OperationResult } from "@grasp-os/shared/operations";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { callAppFunction, callPageFunction } from "../src/app-functions.ts";
import { artifactKey } from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import {
  bindWorkflowToApp,
  unbindWorkflowFromApp,
} from "../src/app-workflow-bindings.ts";
import { appFor, setCurrentVersion, versionFiles } from "../src/apps.ts";
import { boundWorkflowsOf } from "../src/bound-workflows.ts";
import { decisionOutcome } from "../src/decisions/decisions.ts";
import { withDraftReferences } from "../src/draft-references.ts";
import { appHost } from "../src/durable-objects.ts";
import { withPageReferences } from "../src/page-references.ts";
import { readWorkflowWatch } from "../src/page-workflows.ts";
import { buildPages } from "../src/pages.ts";
import { requireResourceRole } from "../src/permission-resources.ts";
import { grantPermission, requestPermission } from "../src/permissions.ts";
import { approveWorkflowBinding } from "../src/workflow-bindings.ts";
import {
  publishCatalogContract,
  resolveCatalogKeys,
} from "../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import {
  confirmPageDecision,
  decidePageRun,
  reviewPageDecision,
} from "../src/workflows/page-decisions.ts";
import { resourceRunFor } from "../src/workflows/resource-runs.ts";
import { withRespond } from "../src/workflows/run-waits.ts";
import { repairWakes } from "../src/workflows/wakes.ts";
import { appDefinition } from "./app-definitions.ts";
import { allEvents } from "./audit-events.ts";
import {
  resumed,
  runInstance,
  stopped as stopRun,
  whileEngineRefuses,
} from "./runs.ts";
import { appWith, person, queryReference, seal } from "./sealed-apps.ts";
import type { Fixture } from "./sealed-apps.ts";
import { unique } from "./sign-in.ts";

// The decisions of the workflows an App binds, in the references its
// pages import (bound-workflows.ts): each of the bound version's
// decision bindings, read from the catalog contract it pinned, typed in
// `workflows.<alias>.decisions`. Sealed with the release, so a binding
// changed later changes no sealed version's pages; a draft's references
// follow the App's bindings as they are.

/** A page reading `key` of the `review` workflow's decisions. */
const pageOf = (
  key: string
): string => `import { createFileRoute } from "@tanstack/react-router";
import { workflows } from "@server/_generated/api";

const decision = workflows.review.decisions.${key};
export const valueSchema = decision.valueSchema;
export const context = decision.context;

function Desk() {
  return <p>{decision.key}</p>;
}

export const Route = createFileRoute("/")({ component: Desk });
`;

const files = (page = pageOf("approval")): Record<string, string> => ({
  ...appDefinition({
    name: "Invoices",
    tables: {
      invoices: {
        fields: { amount: "v.number()" },
        access: { read: "appMembers", write: "appMembers" },
      },
    },
    permissions: [
      'permission.workflow("review", {\n  input: v.object({ amount: v.number() }),\n  output: v.object({ status: v.string() }),\n})',
    ],
  }),
  "server/invoices.ts": `import { v } from "@grasp-os/sdk";
import { query } from "@server/_generated/server";
import { permissions } from "../grasp.config.ts";

export const review = permissions.review;

export const count = query({
  args: {},
  returns: v.number(),
  handler: async (ctx) => (await ctx.db.query("invoices").collect()).length,
});
`,

  "src/routes/index.tsx": page,
});

/** The JSON Schema of an object of `properties`, each required. */
const objectDocument = (properties: Record<string, unknown>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

/**
 * An approval workflow asking, in `ask`, for decision `contract` as
 * `approval`; with `looped`, once for each item of a `forEach`, `lines`.
 */
const definitionOf = (contract: string, looped = false): string => {
  const ask = {
    id: "ask",
    type: "decision",
    binding: "approval",
    recipients: ["role:admin"],
    prompt: "Approve this invoice?",
    input: { amount: { $expr: "input.amount" } },
  };
  return JSON.stringify({
    $schema: workflowSchemaUrl,
    input: objectDocument({ amount: { type: "number" } }),
    output: {
      schema: objectDocument({ status: { type: "string" } }),
      value: { status: "done" },
    },
    bindings: { approval: { kind: "decision", contract } },
    steps: looped
      ? [
          {
            id: "lines",
            type: "forEach",
            items: { $expr: "[1, 2]" },
            do: [ask],
          },
        ]
      : [ask],
  });
};

// Null too: a decision's context may be JSON `null` when its contract takes it.
const context = v.object({ amount: v.number() }).nullable();
const value = v.object({ comment: v.string() });

/** An App bound to a workflow version with a decision binding, as `review`. */
const boundApp = async (
  looped = false
): Promise<{
  fixture: Fixture;
  binding: string;
  workflowId: string;
}> => {
  const admin = await person("admin");
  const fixture = await appWith(files(), "Invoices");
  const key = `approval-${unique()}`;
  await publishCatalogContract(env, admin, {
    key,
    kind: "decision",
    input: JSON.stringify(context.descriptor),
    response: JSON.stringify(value.descriptor),
  });
  const workflow = await createWorkflowResource(
    env,
    fixture.owner,
    `approve-${unique()}`
  );
  await publishWorkflowVersion(env, fixture.owner, workflow.id, {
    definition: definitionOf(key, looped),
    basedOn: null,
  });
  const { id } = await bindWorkflowToApp(env, fixture.owner, workflow.id, {
    app: fixture.app,
    alias: "review",
    version: 1,
  });
  return { fixture, binding: id, workflowId: workflow.id };
};

/** A page sending the `review` workflow's `jobEvents`, its type literal. */
const eventPage = `import { createFileRoute } from "@tanstack/react-router";
import { workflows } from "@server/_generated/api";

const event = workflows.review.events.jobEvents;
export const type: "grasp.job.completed" = event.type;
export const data = event.data;

function Desk() {
  return <p>{event.alias}</p>;
}

export const Route = createFileRoute("/")({ component: Desk });
`;

/** A job's events, one a page sends and one it doesn't, both of `jobId`. */
const jobEvents = {
  "grasp.job.completed": {
    data: JSON.stringify(v.object({ jobId: v.string() }).descriptor),
    browser: true,
  },
  "grasp.job.timeout": {
    data: JSON.stringify(v.object({ jobId: v.string() }).descriptor),
    browser: false,
  },
};

/** A workflow waiting, in `await-job`, for the job event a page sends. */
const eventDefinitionOf = (contract: string): string =>
  JSON.stringify({
    $schema: workflowSchemaUrl,
    input: objectDocument({ amount: { type: "number" } }),
    output: {
      schema: objectDocument({ status: { type: "string" } }),
      value: { status: "done" },
    },
    bindings: { jobEvents: { kind: "event", contract } },
    steps: [
      {
        id: "await-job",
        type: "wait",
        event: { from: "jobEvents", type: "grasp.job.completed" },
        timeout: "24 hours",
      },
    ],
  });

/** An App bound, as `review`, to a workflow version waiting for a page's event. */
const eventApp = async (): Promise<Fixture> => {
  const admin = await person("admin");
  const fixture = await appWith(files(eventPage), "Invoices");
  const key = `job-events-${unique()}`;
  await publishCatalogContract(env, admin, {
    key,
    kind: "event",
    events: jobEvents,
  });
  const workflow = await createWorkflowResource(
    env,
    fixture.owner,
    `wait-${unique()}`
  );
  await publishWorkflowVersion(env, fixture.owner, workflow.id, {
    definition: eventDefinitionOf(key),
    basedOn: null,
  });
  await bindWorkflowToApp(env, fixture.owner, workflow.id, {
    app: fixture.app,
    alias: "review",
    version: 1,
  });
  return fixture;
};

/** The text of `path` among `release`'s artifacts, as it was sealed. */
const sealedText = async (release: Release, path: string): Promise<string> => {
  const entry = release.manifest.artifacts.find(
    (artifact) => artifact.path === path
  );
  const object =
    entry === undefined ? null : await env.FILES.get(artifactKey(entry.sha256));
  if (object === null) {
    throw new Error(`The release has no ${path}`);
  }
  return await object.text();
};

/** The errors of a build of `files`' pages, for `fixture`'s version 1. */
const pageErrors = async (
  fixture: Fixture,
  built: Record<string, string>
): Promise<string[]> => {
  const build = await buildPages(env, built, fixture.app);
  return build.ok
    ? []
    : build.diagnostics
        .filter(({ severity }) => severity === "error")
        .map(({ file, line, message }) => `${file}:${line}: ${message}`);
};

/** "answered" when `call` succeeds, else the code it was refused with. */
const codeOf = async (call: () => Promise<unknown>): Promise<unknown> => {
  try {
    await call();
    return "answered";
  } catch (error) {
    return error instanceof Error && "code" in error
      ? error.code
      : String(error);
  }
};

/**
 * The person `who`'s whole answer `answer` to decision `of` on `page`, as
 * the page makes it: reviewed, confirmed in its dialog, then sent with
 * that confirmation. Answers the decision's status as it answered, or the
 * code it was refused with.
 */
const answered = async (
  who: Parameters<typeof reviewPageDecision>[1],
  page: Parameters<typeof reviewPageDecision>[2],
  of: { runId: string; decisionId: string },
  answer: { approved: boolean; payload?: unknown },
  /** Between the confirmation and the answer. */
  between: () => Promise<void> = async () => {
    await Promise.resolve();
  }
): Promise<unknown> => {
  try {
    const reviewed = await reviewPageDecision(
      env,
      who,
      page,
      of.runId,
      of.decisionId,
      answer
    );
    if (reviewed.state !== "review") {
      return reviewed.decision.status;
    }
    const { confirmation } = await confirmPageDecision(
      env,
      who,
      page,
      of.runId,
      of.decisionId,
      reviewed.decision.revision,
      reviewed.response
    );
    await between();
    const view = await decidePageRun(
      env,
      who,
      page,
      of.runId,
      of.decisionId,
      reviewed.response,
      confirmation
    );
    return view.status;
  } catch (error) {
    return error instanceof Error && "code" in error
      ? error.code
      : String(error);
  }
};

/** Decision `decision`'s status, as its row has it. */
const statusOf = async (decision: string): Promise<string> => {
  const row = await env.DB.prepare(
    "SELECT status FROM workflow_decisions WHERE id = ?"
  )
    .bind(decision)
    .first();
  return z.object({ status: z.string() }).parse(row).status;
};

/**
 * `database`, but ending run `runId` (completed, with an output) right
 * after the read that admits a person to its snapshot (page-workflows.ts,
 * `seenRun`), before the snapshot reads the run again.
 */
const endsRunAfterAdmission = (database: D1Database, runId: string) => {
  const ended = async () => {
    await database
      .prepare(
        "UPDATE workflow_resource_runs SET status = 'completed', ended_at = ? WHERE id = ?"
      )
      .bind(Date.now(), runId)
      .run();
  };
  /** `statement`, ending the run once any of its reads settled. */
  const ending = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get: (inner, name) => {
        const member: unknown = Reflect.get(inner, name);
        if (typeof member !== "function") {
          return member;
        }
        if (name === "bind") {
          return (...args: unknown[]) => {
            // SAFETY: `bind` answers a prepared statement, as D1 types it.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
            const bound = Reflect.apply(
              member,
              inner,
              args
            ) as D1PreparedStatement;
            return ending(bound);
          };
        }
        return async (...args: unknown[]) => {
          const result: unknown = await Reflect.apply(member, inner, args);
          await ended();
          return result;
        };
      },
    });
  return new Proxy(database, {
    get: (target, property) => {
      const member: unknown = Reflect.get(target, property);
      if (property !== "prepare") {
        return typeof member === "function"
          ? (...args: unknown[]): unknown => Reflect.apply(member, target, args)
          : member;
      }
      return (query: string) =>
        query.includes("origin_app_version")
          ? ending(target.prepare(query))
          : target.prepare(query);
    },
  });
};

/** What a call answered, or its refusal's code. */
const answerOf = (result: OperationResult): unknown =>
  result.ok ? result.value : result.error.code;

/**
 * An App bound to the decision workflow, sealed and current, with a
 * reviewer, a starter and an outsider among its people; runs of its pinned
 * version it started for the starter, each asking the admins; and a call
 * of its decision queries, as whoever calls.
 */
const decisionInbox = async (looped = false) => {
  const { fixture, workflowId, binding } = await boundApp(looped);
  const release = await seal(fixture);
  await setCurrentVersion(env, fixture.owner, fixture.app, 1);
  const [reviewer, starter, outsider] = await Promise.all([
    person("admin"),
    person("admin"),
    person("user"),
  ]);
  await env.DB.batch(
    [reviewer, starter, outsider].map((member) =>
      env.DB.prepare(
        "INSERT INTO app_members (app_id, member_type, member_id, role, added_by, added_at) VALUES (?, 'person', ?, 'user', ?, ?)"
      ).bind(fixture.app, member.userId, fixture.owner.userId, Date.now())
    )
  );
  const pinnedRow = await env.DB.prepare(
    "SELECT manifest_hash AS hash FROM workflow_resource_versions WHERE workflow_resource_id = ? AND version = 1"
  )
    .bind(workflowId)
    .first<{ hash: string }>();
  const manifestHash = pinnedRow?.hash ?? "";
  const opened = Date.now() - 60_000;
  /** A run of the pinned version `app` started for `starter`, asking `ask`. */
  const runAsking = async (
    app: string,
    at: number,
    {
      step = "ask:task",
      restricted = false,
      version = 1,
      input = { amount: 5 },
    }: {
      step?: string;
      restricted?: boolean;
      version?: number;
      input?: unknown;
    } = {}
  ): Promise<{ runId: string; decisionId: string }> => {
    const runId = crypto.randomUUID();
    const decisionId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO workflow_start_receipts (id, invoker_type, invoker_id, idempotency_key, workflow_resource_id, workflow_resource_version, manifest_hash, principal_id, authority_generation, input_hash, created_at, origin_app_version) VALUES (?, 'app', ?, ?, ?, ?, ?, ?, 1, 'h', ?, 1)"
      ).bind(
        runId,
        app,
        `key-${runId}`,
        workflowId,
        version,
        manifestHash,
        starter.userId,
        at
      ),
      env.DB.prepare(
        "INSERT INTO workflow_resource_runs (id, workflow_resource_id, version, manifest_hash, build_hash, principal_id, status, restricted, created_at) VALUES (?, ?, ?, ?, 'b', ?, 'running', ?, ?)"
      ).bind(
        runId,
        workflowId,
        version,
        manifestHash,
        starter.userId,
        restricted ? 1 : 0,
        at
      ),
      env.DB.prepare(
        "INSERT INTO workflow_decisions (id, resource_run_id, step, deciders, description, status, opened_at, expires_at, input) VALUES (?, ?, ?, 'role:admin', 'Approve this invoice?', 'open', ?, ?, ?)"
      ).bind(
        decisionId,
        runId,
        step,
        at,
        at + 86_400_000,
        input === null ? null : JSON.stringify(input)
      ),
    ]);
    return { runId, decisionId };
  };
  const ask = async (
    who: Parameters<typeof callAppFunction>[1],
    name: "decisions" | "decision",
    input: unknown,
    window?: number
  ): Promise<unknown> => {
    const request = JSON.stringify({
      reference: queryReference(release, "review", name),
      input,
      ...(window === undefined ? {} : { window: { extent: window } }),
    });
    const { result } =
      window === undefined
        ? await callAppFunction(env, who, fixture.app, request)
        : await callPageFunction(
            env,
            who,
            fixture.app,
            request,
            Date.now() + 30_000,
            async () => {
              // A window's pages cost nothing here.
            }
          );
    return answerOf(result);
  };
  return {
    fixture,
    release,
    binding,
    workflowId,
    manifestHash,
    opened,
    reviewer,
    starter,
    outsider,
    runAsking,
    ask,
  };
};

describe(
  "the decisions of an App's bound workflows",
  { timeout: 180_000 },
  () => {
    it("are sealed into the release's references, typed for its pages, and stay as sealed when the binding goes", async () => {
      const { fixture, binding } = await boundApp();
      const release = await seal(fixture);
      const references = await sealedText(release, generatedPaths.api);
      const sealedFiles = await versionFiles(env, fixture.app, 1);
      const sealedBuild = async () =>
        await pageErrors(
          fixture,
          await withPageReferences(env, fixture.app, 1, sealedFiles)
        );
      const typedBefore = await sealedBuild();

      await unbindWorkflowFromApp(env, fixture.owner, binding);

      expect({
        sealed: release.workflows.find(({ alias }) => alias === "review")
          ?.decisions,
        referencesNameIt:
          references.includes("approval") && references.includes("comment"),
        typedBefore,
        typedAfterUnbinding: await sealedBuild(),
      }).toStrictEqual({
        sealed: {
          approval: { value: value.descriptor, context: context.descriptor },
        },
        referencesNameIt: true,
        typedBefore: [],
        typedAfterUnbinding: [],
      });
    });

    it("list the decisions of the App's runs a person may answer now, oldest first, and refuse every other decision alike", async () => {
      const {
        workflowId,
        fixture,
        manifestHash,
        opened,
        reviewer,
        starter,
        outsider,
        runAsking,
        ask,
      } = await decisionInbox();
      const first = await runAsking(fixture.app, opened);
      const second = await runAsking(fixture.app, opened + 1000);
      // Another App's run, and a step no decision task of the build names.
      const elsewhere = await runAsking(`other-${unique()}`, opened + 2000);
      const unnamed = await runAsking(fixture.app, opened + 3000, {
        step: "other:task",
      });
      const waitOf = (
        { runId, decisionId }: { runId: string; decisionId: string },
        at: number
      ) => ({
        run: {
          runId,
          workflowId,
          workflowVersion: 1,
          manifestHash,
        },
        wait: {
          kind: "decision",
          id: decisionId,
          taskId: "ask",
          key: "approval",
          title: "ask",
          openedAt: at,
          deadline: at + 86_400_000,
          canRespond: true,
        },
      });
      const page = await ask(reviewer, "decisions", {
        pagination: { pageSize: 1 },
      });
      const cursor =
        typeof page === "object" && page !== null && "nextCursor" in page
          ? page.nextCursor
          : null;
      const detail = async (who: typeof reviewer, of: typeof first) =>
        await ask(who, "decision", {
          runId: of.runId,
          decisionId: of.decisionId,
        });
      const before = {
        page,
        next: await ask(reviewer, "decisions", {
          pagination: { pageSize: 1, cursor },
        }),
        ofRun: await ask(reviewer, "decisions", {
          runId: second.runId,
          pagination: {},
        }),
        window: await ask(reviewer, "decisions", {}, 20),
        starter: await ask(starter, "decisions", { pagination: {} }),
        outsider: await ask(outsider, "decisions", { pagination: {} }),
        detail: await detail(reviewer, first),
        starterDetail: await detail(starter, first),
        outsiderDetail: await detail(outsider, first),
        elsewhere: await detail(reviewer, elsewhere),
        unnamed: await detail(reviewer, unnamed),
        mismatched: await ask(reviewer, "decision", {
          runId: second.runId,
          decisionId: first.decisionId,
        }),
        unknown: await ask(reviewer, "decision", {
          runId: first.runId,
          decisionId: "decision-1",
        }),
        decisionWindow: await ask(
          reviewer,
          "decision",
          { runId: first.runId, decisionId: first.decisionId },
          20
        ),
      };
      await env.DB.prepare(
        "UPDATE workflow_decisions SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ?"
      )
        .bind(reviewer.userId, Date.now(), first.decisionId)
        .run();

      expect({
        ...before,
        answered: await detail(reviewer, first),
        afterAnswer: await ask(reviewer, "decisions", { pagination: {} }),
      }).toStrictEqual({
        page: {
          items: [waitOf(first, opened)],
          nextCursor: `${opened}:${first.decisionId}`,
          hasMore: true,
        },
        // The unnamed decision after it takes a place it never shows in.
        next: {
          items: [waitOf(second, opened + 1000)],
          nextCursor: `${opened + 1000}:${second.decisionId}`,
          hasMore: true,
        },
        ofRun: {
          items: [waitOf(second, opened + 1000)],
          nextCursor: null,
          hasMore: false,
        },
        window: {
          items: [waitOf(first, opened), waitOf(second, opened + 1000)],
          hasMore: false,
        },
        // Their own run's decision is never theirs to answer (R8).
        starter: { items: [], nextCursor: null, hasMore: false },
        outsider: { items: [], nextCursor: null, hasMore: false },
        detail: {
          key: "approval",
          wait: waitOf(first, opened).wait,
          prompt: "Approve this invoice?",
          context: { amount: 5 },
          canRespond: true,
        },
        starterDetail: "workflow.decision_unavailable",
        outsiderDetail: "workflow.decision_unavailable",
        elsewhere: "workflow.decision_unavailable",
        unnamed: "workflow.decision_unavailable",
        mismatched: "workflow.decision_unavailable",
        unknown: "workflow.decision_unavailable",
        // One decision isn't a list a window reads.
        decisionWindow: "contract.not_paginated",
        // Theirs to read, but no longer taking an answer.
        answered: null,
        afterAnswer: {
          items: [waitOf(second, opened + 1000)],
          nextCursor: null,
          hasMore: false,
        },
      });
    });

    it("list and answer a decision asked in a loop's item, as the run host names its step", async () => {
      const { fixture, opened, reviewer, runAsking, ask } =
        await decisionInbox(true);
      // As the SDK names the item's step: its key, `task@0`, URI-encoded.
      const looped = await runAsking(fixture.app, opened, {
        step: "ask:task%400",
      });
      // Its key in no encoding the SDK writes, and a part of a decision.
      const unencoded = await runAsking(fixture.app, opened + 1000, {
        step: "ask:task@0",
      });
      const part = await runAsking(fixture.app, opened + 2000, {
        step: "ask:task%400#answer",
      });
      const list = await ask(reviewer, "decisions", { pagination: {} });
      const listed =
        typeof list === "object" && list !== null && "items" in list
          ? list.items
          : list;
      const detail = async (of: { runId: string; decisionId: string }) =>
        await ask(reviewer, "decision", {
          runId: of.runId,
          decisionId: of.decisionId,
        });
      expect({
        listed: z
          .array(
            z.object({
              run: z.object({ runId: z.string() }),
              wait: z.object({ taskId: z.string() }),
            })
          )
          .parse(listed)
          .map(({ run, wait }) => ({ runId: run.runId, taskId: wait.taskId })),
        looped: z.object({ key: z.string() }).parse(await detail(looped)).key,
        unencoded: await detail(unencoded),
        part: await detail(part),
      }).toStrictEqual({
        listed: [{ runId: looped.runId, taskId: "ask" }],
        looped: "approval",
        unencoded: "workflow.decision_unavailable",
        part: "workflow.decision_unavailable",
      });
    });

    it("show an open decision whose context is null, as its contract allows", async () => {
      const { fixture, opened, reviewer, runAsking, ask } =
        await decisionInbox();
      const open = await runAsking(fixture.app, opened, { input: null });

      await expect(
        ask(reviewer, "decision", {
          runId: open.runId,
          decisionId: open.decisionId,
        })
      ).resolves.toMatchObject({
        key: "approval",
        prompt: "Approve this invoice?",
        context: null,
        canRespond: true,
      });
    });

    it("leave out a restricted run's decisions unless the App is restricted, and ask removed members and staff nothing", async () => {
      const { fixture, opened, reviewer, runAsking, ask } =
        await decisionInbox();
      const open = await runAsking(fixture.app, opened);
      const restricted = await runAsking(fixture.app, opened + 1000, {
        restricted: true,
      });
      const listed = async (who: typeof reviewer) => {
        const page = await ask(who, "decisions", { pagination: {} });
        return (
          z
            .object({
              items: z.array(z.object({ wait: z.object({ id: z.string() }) })),
            })
            .safeParse(page)
            .data?.items.map(({ wait }) => wait.id) ?? page
        );
      };
      const detail = async (who: typeof reviewer, of: typeof open) =>
        await ask(who, "decision", {
          runId: of.runId,
          decisionId: of.decisionId,
        });
      // An admin with Grasp's staff flag, and a member of the App.
      const staff = { ...(await person("admin")), staff: true };
      await env.DB.prepare(
        "INSERT INTO app_members (app_id, member_type, member_id, role, added_by, added_at) VALUES (?, 'person', ?, 'user', ?, ?)"
      )
        .bind(fixture.app, staff.userId, fixture.owner.userId, Date.now())
        .run();
      const unrestricted = {
        listed: await listed(reviewer),
        restrictedDetail: await detail(reviewer, restricted),
        staffListed: await listed(staff),
        staffDetail: await detail(staff, open),
      };
      await appHost(env, appIdSchema.parse(fixture.app)).restrict();
      const whileRestricted = await listed(reviewer);
      // The reviewer, removed from the organization: asked nothing more.
      const removed = await env.DB.prepare(
        "INSERT INTO member_removals (organization_id, user_id, removed_at) VALUES ('organization', ?, ?)"
      )
        .bind(reviewer.userId, Date.now())
        .run();

      expect({
        ...unrestricted,
        whileRestricted,
        removedWritten: removed.success,
        removedListed: await listed(reviewer),
        removedDetail: await detail(reviewer, open),
      }).toStrictEqual({
        listed: [open.decisionId],
        restrictedDetail: "workflow.decision_unavailable",
        staffListed: [],
        staffDetail: "workflow.decision_unavailable",
        whileRestricted: [open.decisionId, restricted.decisionId],
        removedWritten: true,
        removedListed: [],
        removedDetail: "workflow.decision_unavailable",
      });
    });

    it("answer an independent run's decision from the App's page once, after the page's confirmation, and refuse every decision the App may not answer alike", async () => {
      const { fixture, binding, opened, reviewer, outsider, runAsking, ask } =
        await decisionInbox();
      const { app } = fixture;
      // The page's App, at the release its frame runs.
      const page = { app, version: 1 };
      const asked = await runAsking(app, opened);
      const restricted = await runAsking(app, opened + 1000, {
        restricted: true,
      });
      const elsewhere = await runAsking(`other-${unique()}`, opened + 2000);
      const answer = { approved: true, payload: { comment: "Looks right" } };
      const review = async (
        who: typeof reviewer,
        of: typeof asked
      ): Promise<unknown> =>
        await codeOf(
          async () =>
            await reviewPageDecision(
              env,
              who,
              page,
              of.runId,
              of.decisionId,
              answer
            )
        );
      const refusals = {
        restricted: await review(reviewer, restricted),
        elsewhere: await review(reviewer, elsewhere),
        // Its ID with another run of the App's: never the decision's.
        mismatched: await review(reviewer, {
          runId: restricted.runId,
          decisionId: asked.decisionId,
        }),
        outsider: await review(outsider, asked),
      };
      const reviewed = await reviewPageDecision(
        env,
        reviewer,
        page,
        asked.runId,
        asked.decisionId,
        answer
      );
      if (reviewed.state !== "review") {
        throw new Error("Nothing to review");
      }
      // The page alone can't answer: only with the page's confirmation.
      const unconfirmed = await codeOf(
        async () =>
          await decidePageRun(
            env,
            reviewer,
            page,
            asked.runId,
            asked.decisionId,
            reviewed.response,
            null
          )
      );
      const { confirmation } = await confirmPageDecision(
        env,
        reviewer,
        page,
        asked.runId,
        asked.decisionId,
        reviewed.decision.revision,
        reviewed.response
      );
      const decided = await decidePageRun(
        env,
        reviewer,
        page,
        asked.runId,
        asked.decisionId,
        reviewed.response,
        confirmation
      );
      // Exactly that answer again is the recorded decision; another isn't.
      const again = await decidePageRun(
        env,
        reviewer,
        page,
        asked.runId,
        asked.decisionId,
        reviewed.response,
        confirmation
      );
      const changed = await codeOf(
        async () =>
          await decidePageRun(
            env,
            reviewer,
            page,
            asked.runId,
            asked.decisionId,
            { approved: false },
            confirmation
          )
      );
      const events = await allEvents();
      const answeredEvent = events.find(
        ({ action, target }) =>
          action === "workflow.decision.approved" &&
          target?.id === asked.decisionId
      );
      const stored = await env.DB.prepare(
        "SELECT status, decided_by AS decidedBy, payload FROM workflow_decisions WHERE id = ?"
      )
        .bind(asked.decisionId)
        .first();
      // The App no longer binds the workflow: its runs' decisions aren't
      // its pages' to answer.
      const later = await runAsking(app, opened + 3000);
      // Once the App reads restricted data, a run it started before stays
      // unrestricted: an answer its page composes may carry what it read.
      await appHost(env, appIdSchema.parse(app)).restrict();
      const afterRestricting = {
        answer: await review(reviewer, later),
        listed: await ask(reviewer, "decisions", {
          runId: later.runId,
          pagination: {},
        }),
      };
      // A run as restricted as the App is now: its page may answer it,
      // until the App no longer binds the workflow.
      const matching = await runAsking(app, opened + 4000, {
        restricted: true,
      });
      const beforeUnbinding = await review(reviewer, matching);
      await unbindWorkflowFromApp(env, fixture.owner, binding);

      expect({
        ...refusals,
        unconfirmed,
        decided: decided.status,
        again: again.status,
        changed,
        stored,
        answeredBy: answeredEvent?.detail,
        afterRestricting,
        beforeUnbinding,
        unbound: await review(reviewer, matching),
      }).toMatchObject({
        restricted: "decision.not_found",
        elsewhere: "decision.not_found",
        mismatched: "decision.not_found",
        outsider: "decision.forbidden",
        unconfirmed: "decision.unconfirmed",
        decided: "approved",
        again: "approved",
        changed: "decision.closed",
        stored: {
          status: "approved",
          decidedBy: reviewer.userId,
          payload: JSON.stringify({ comment: "Looks right" }),
        },
        // Which App's page answered: an independent run names none.
        answeredBy: { via: "page", app },
        afterRestricting: {
          answer: "decision.not_found",
          // Still shown to the reviewer, as one their page can't answer.
          listed: {
            items: [{ wait: { id: later.decisionId, canRespond: false } }],
          },
        },
        beforeUnbinding: "answered",
        unbound: "decision.not_found",
      });
    });

    it("keep one answer of a decision answered from pages at once, or against its deadline, and take none against a changed context or a binding gone", async () => {
      const { fixture, binding, workflowId, opened, reviewer, runAsking } =
        await decisionInbox();
      const { app } = fixture;
      const page = { app, version: 1 };
      const second = await person("admin");
      await env.DB.prepare(
        "INSERT INTO app_members (app_id, member_type, member_id, role, added_by, added_at) VALUES (?, 'person', ?, 'user', ?, ?)"
      )
        .bind(app, second.userId, fixture.owner.userId, Date.now())
        .run();
      const approve = { approved: true, payload: { comment: "Yes" } };
      const reject = { approved: false, payload: { comment: "No" } };

      // Two reviewers answer at once, differently: both confirm before
      // either answers (a barrier), so both confirmed answers reach the
      // final write together. One answer stands.
      const raced = await runAsking(app, opened);
      let confirmed = 0;
      const bothConfirmed = Promise.withResolvers<null>();
      const barrier = async (): Promise<void> => {
        confirmed += 1;
        if (confirmed === 2) {
          bothConfirmed.resolve(null);
        }
        await bothConfirmed.promise;
      };
      const both = await Promise.all([
        answered(reviewer, page, raced, approve, barrier),
        answered(second, page, raced, reject, barrier),
      ]);
      const racedStatus = await statusOf(raced.decisionId);
      const racedEvents = await allEvents();
      const racedAnswers = racedEvents.filter(
        ({ action, target }) =>
          (action === "workflow.decision.approved" ||
            action === "workflow.decision.rejected") &&
          target?.id === raced.decisionId
      ).length;

      // An answer against its run closing it at the deadline, both orders,
      // each landed at the exact point: reviewed and confirmed first, then
      // the close just before the answer's write, or just after it.
      const runOf = (asked: { runId: string }) => ({
        kind: "resource" as const,
        runId: asked.runId,
        workflow: workflowId,
        version: 1,
      });
      const closedFirst = await runAsking(app, opened + 1000);
      let closedBefore: { answered: boolean } | undefined;
      const lateAnswer = await answered(
        reviewer,
        page,
        closedFirst,
        approve,
        async () => {
          closedBefore = await decisionOutcome(
            env,
            runOf(closedFirst),
            closedFirst.decisionId,
            true
          );
        }
      );
      const answeredFirst = await runAsking(app, opened + 1500);
      const intime = await answered(reviewer, page, answeredFirst, approve);
      const closedAfter = await decisionOutcome(
        env,
        runOf(answeredFirst),
        answeredFirst.decisionId,
        true
      );
      const deadline = {
        closedFirst: {
          answer: lateAnswer,
          status: await statusOf(closedFirst.decisionId),
          answered: closedBefore?.answered,
        },
        answeredFirst: {
          answer: intime,
          status: await statusOf(answeredFirst.decisionId),
          answered: closedAfter.answered,
        },
      };

      // The context changes between the confirmation and the answer.
      const changed = await runAsking(app, opened + 2000);
      const conflict = await answered(
        reviewer,
        page,
        changed,
        approve,
        async () => {
          await env.DB.prepare(
            "UPDATE workflow_decisions SET description = 'Approve this larger invoice?' WHERE id = ?"
          )
            .bind(changed.decisionId)
            .run();
        }
      );
      const changedStatus = await statusOf(changed.decisionId);
      // Asked again, against the context as it is: it takes the answer.
      const reviewedAgain = await answered(reviewer, page, changed, approve);
      // Its acknowledgement lost, the page asks once more: the recorded
      // answer, never a second one.
      const askedTwice = await answered(reviewer, page, changed, approve);
      const events = await allEvents();
      const answers = events.filter(
        ({ action, target }) =>
          action.startsWith("workflow.decision.") &&
          ["approved", "rejected"].some((end) => action.endsWith(end)) &&
          target?.id === changed.decisionId
      ).length;

      // The App unbinds the workflow between the confirmation and the answer.
      const unbound = await runAsking(app, opened + 3000);
      const gone = await answered(
        reviewer,
        page,
        unbound,
        approve,
        async () => {
          await unbindWorkflowFromApp(env, fixture.owner, binding);
        }
      );

      const winners = both.filter(
        (outcome) => outcome === "approved" || outcome === "rejected"
      );
      expect({
        // Exactly one answered; the other found it closed.
        oneStands: winners.length === 1 && both.includes("decision.closed"),
        racedMatches: racedStatus === winners[0],
        racedAnswers,
        // The answer and the close agree on how it ended, either way.
        deadline,
        conflict,
        changedStatus,
        reviewedAgain,
        askedTwice,
        answers,
        gone,
        unboundStatus: await statusOf(unbound.decisionId),
      }).toStrictEqual({
        oneStands: true,
        racedMatches: true,
        racedAnswers: 1,
        deadline: {
          closedFirst: {
            answer: "decision.closed",
            status: "timed_out",
            answered: false,
          },
          answeredFirst: {
            answer: "approved",
            status: "approved",
            answered: true,
          },
        },
        conflict: "decision.conflict",
        changedStatus: "open",
        reviewedAgain: "approved",
        askedTwice: "approved",
        answers: 1,
        gone: "decision.not_found",
        unboundStatus: "open",
      });
    });

    it("let a reviewer watch the run a decision asks them about, its decisions to them alone and no control, until it no longer asks them", async () => {
      const {
        fixture,
        release,
        opened,
        reviewer,
        starter,
        outsider,
        runAsking,
      } = await decisionInbox();
      const { app } = fixture;
      const declared = declaredWorkflows(release.app, release.workflows).find(
        ({ alias }) => alias === "review"
      );
      if (declared === undefined) {
        throw new Error("The release declares no review");
      }
      const workflow = {
        resourceId: release.manifest.resourceId,
        resourceVersion: release.manifest.resourceVersion,
        contractId: "workflows.review",
        fingerprint: await workflowFingerprint(declared),
        kind: "workflow" as const,
      };
      /** `who`'s snapshot of run `runId`, or the code it was refused with. */
      const watched = async (
        who: Parameters<typeof readWorkflowWatch>[1],
        runId: string
      ): Promise<unknown> => {
        try {
          const read = await readWorkflowWatch(env, who, app, {
            workflow,
            watch: "run",
            runId,
          });
          return read.value;
        } catch (error) {
          return error instanceof Error && "code" in error
            ? error.code
            : String(error);
        }
      };
      const shownTo = async (who: typeof reviewer, runId: string) => {
        const snapshot = await watched(who, runId);
        const parsed = z
          .looseObject({
            waits: z.array(z.looseObject({ kind: z.string() })),
            control: z.looseObject({}),
          })
          .safeParse(snapshot);
        return parsed.success
          ? {
              fields: Object.keys(parsed.data).toSorted(),
              waits: parsed.data.waits.map(({ kind, canRespond }) => ({
                kind,
                canRespond,
              })),
              control: parsed.data.control,
            }
          : snapshot;
      };
      const asked = await runAsking(app, opened);
      const staff = { ...(await person("admin")), staff: true };
      // A control asked of it by the reviewer: refused, as for no run.
      const cancelled = await callPageFunction(
        env,
        reviewer,
        app,
        JSON.stringify({
          workflow,
          command: "cancel",
          runId: asked.runId,
          idempotencyKey: "0".repeat(32),
        }),
        Date.now() + 30_000,
        async () => {
          // Nothing here is charged.
        }
      );
      const before = {
        reviewer: await shownTo(reviewer, asked.runId),
        outsider: await watched(outsider, asked.runId),
        staff: await watched(staff, asked.runId),
        cancel: answerOf(cancelled.result),
      };
      // Each way a decision stops asking the reviewer: answered, closed at
      // its deadline, or asked of someone else.
      const answeredRun = await runAsking(app, opened + 1000);
      const closedRun = await runAsking(app, opened + 2000);
      const reassignedRun = await runAsking(app, opened + 3000);
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE workflow_decisions SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ?"
        ).bind(starter.userId, Date.now(), answeredRun.decisionId),
        env.DB.prepare(
          "UPDATE workflow_decisions SET status = 'timed_out' WHERE id = ?"
        ).bind(closedRun.decisionId),
        env.DB.prepare(
          "UPDATE workflow_decisions SET deciders = ? WHERE id = ?"
        ).bind(`person:${outsider.userId}`, reassignedRun.decisionId),
      ]);
      // A run that ends between the read that admits the reviewer and the
      // read of what it is: they see neither its output nor its error.
      const endingRun = await runAsking(app, opened + 4000);
      const racing = {
        ...env,
        DB: endsRunAfterAdmission(env.DB, endingRun.runId),
      };
      let ending: unknown;
      try {
        const read = await readWorkflowWatch(racing, reviewer, app, {
          workflow,
          watch: "run",
          runId: endingRun.runId,
        });
        ending = read.value;
      } catch (error) {
        ending =
          error instanceof Error && "code" in error
            ? error.code
            : String(error);
      }
      // Read before restricting the App, which refuses these on its own.
      const stopped = {
        answered: await watched(reviewer, answeredRun.runId),
        closed: await watched(reviewer, closedRun.runId),
        reassigned: await watched(reviewer, reassignedRun.runId),
      };
      // The App in restricted mode: the run, unrestricted, isn't its
      // page's to answer, so not the reviewer's to watch.
      const unrestrictedBefore = await watched(reviewer, asked.runId);
      await appHost(env, appIdSchema.parse(app)).restrict();

      expect({
        ...before,
        unrestrictedBefore: typeof unrestrictedBefore,
        afterRestricting: await watched(reviewer, asked.runId),
        ...stopped,
        ending,
      }).toStrictEqual({
        reviewer: {
          // Who the run is, its status, its waits and no control: nothing
          // of its outcome (what it returned, why it failed, what it rolls
          // back after), however the snapshot grows.
          fields: [
            "control",
            "fingerprint",
            "finishedAt",
            "manifestHash",
            "runId",
            "startedAt",
            "status",
            "waits",
            "workflowId",
            "workflowVersion",
          ],
          // No engine runs these rows' run, so it waits on nothing the
          // engine lists (run-waits.ts); a real run's decision wait, as a
          // reviewer and its starter see it, is page-typed-workflows'.
          waits: [],
          control: {
            canPause: false,
            canResume: false,
            canCancel: false,
            pendingControl: null,
          },
        },
        outsider: "workflow.run_unavailable",
        staff: "workflow.run_unavailable",
        cancel: "workflow.run_unavailable",
        unrestrictedBefore: "object",
        afterRestricting: "workflow.run_unavailable",
        ending: "workflow.run_unavailable",
        answered: "workflow.run_unavailable",
        closed: "workflow.run_unavailable",
        reassigned: "workflow.run_unavailable",
      });
    });

    it("go on once with a page's answer whose wake is lost while the run is down, the answer given again recording nothing twice", async () => {
      const { fixture, workflowId } = await boundApp();
      const { app, owner } = fixture;
      const admin = await person("admin");
      const reviewer = await person("admin");
      await approveWorkflowBinding(env, admin, workflowId, {
        alias: "approval",
        target: { kind: "decision", deciders: ["role:admin"] },
        reviewed: { version: 1 },
      });
      const release = await seal(fixture);
      await setCurrentVersion(env, owner, app, 1);
      const asked = await requestPermission(
        env,
        owner,
        {
          subject: { type: "app", appId: app },
          object: { type: "workflow", workflowId },
          actions: ["start"],
          binding: "REVIEW",
        },
        {
          app: async (named, role) => await appFor(env, owner, named, role),
          resource: async (ref, needed) => {
            await requireResourceRole(env, owner, ref, needed);
          },
        }
      );
      await grantPermission(env, admin, asked.id, {
        version: release.manifest.resourceVersion,
      });
      const declared = declaredWorkflows(release.app, release.workflows).find(
        ({ alias }) => alias === "review"
      );
      if (declared === undefined) {
        throw new Error("The release declares no review");
      }
      // The App's page starts a run on the real engine, as its owner.
      const { result } = await callPageFunction(
        env,
        owner,
        app,
        JSON.stringify({
          workflow: {
            resourceId: release.manifest.resourceId,
            resourceVersion: release.manifest.resourceVersion,
            contractId: "workflows.review",
            fingerprint: await workflowFingerprint(declared),
            kind: "workflow",
          },
          command: "start",
          input: { amount: 5 },
          idempotencyKey: "1".repeat(32),
        }),
        Date.now() + 30_000,
        async () => {
          // Nothing here is charged.
        }
      );
      const { runId } = z.object({ runId: z.string() }).parse(answerOf(result));
      const decisionId = await vi.waitFor(
        async () => {
          const row = await env.DB.prepare(
            "SELECT id FROM workflow_decisions WHERE resource_run_id = ?"
          )
            .bind(runId)
            .first<{ id: string }>();
          if (row === null) {
            throw new Error("No decision yet");
          }
          return row.id;
        },
        { timeout: 20_000, interval: 100 }
      );
      const page = { app, version: 1 };
      const answer = { approved: true, payload: { comment: "Looks right" } };
      const reviewed = await reviewPageDecision(
        env,
        reviewer,
        page,
        runId,
        decisionId,
        answer
      );
      if (reviewed.state !== "review") {
        throw new Error("Nothing to review");
      }
      const { confirmation } = await confirmPageDecision(
        env,
        reviewer,
        page,
        runId,
        decisionId,
        reviewed.decision.revision,
        reviewed.response
      );
      const decide = async (response: unknown) =>
        await codeOf(async () => {
          const decided = await decidePageRun(
            env,
            reviewer,
            page,
            runId,
            decisionId,
            response,
            confirmation
          );
          return decided.status;
        });
      // Waiting on the engine for its wake, as the engine reports it: its
      // look at the decision (`:decision:reached`) done, it heard no
      // answer. Stopped before that look, it would read the answer as it
      // resumes and need no wake.
      {
        using waits = await runInstance(runId).subscribe({
          filter: ["wait_started"],
        });
        const { done } = await waits.next();
        if (done === true) {
          throw new Error(`Run ${runId} ended before it waited`);
        }
      }
      // Killed while it waits, and the engine unreachable as the page's
      // answer comes in: the answer is recorded, and the wake it owes is
      // lost.
      await stopRun(runId);
      const first = await whileEngineRefuses(
        (method) => method === "sendEvent",
        async () => await decide(reviewed.response)
      );
      // The page sends the same answer again, as after an acknowledgement
      // that never came: the decision already taken. Another finds it
      // closed.
      const again = await decide(reviewed.response);
      const other = await decide({ ...reviewed.response, approved: false });
      // The repair sends the wake while the run is down; it takes it once,
      // back up.
      await repairWakes(env, new Date(Date.now() + 60_000));
      await resumed(runId);
      const ended = await vi.waitFor(
        async () => {
          const run = await resourceRunFor(env, owner, workflowId, runId);
          expect(run.status).toBe("completed");
          return run.status === "completed"
            ? { status: run.status, output: run.output }
            : { status: run.status };
        },
        { timeout: 30_000, interval: 100 }
      );
      const events = await allEvents();

      expect({
        first,
        again,
        other,
        ended,
        decisions: await env.DB.prepare(
          "SELECT status, decided_by AS decidedBy FROM workflow_decisions WHERE resource_run_id = ?"
        )
          .bind(runId)
          .all()
          .then(({ results }) => results),
        openings: events.filter(
          ({ action, target }) =>
            action === "workflow.decision.opened" && target?.id === decisionId
        ).length,
        approvals: events.filter(
          ({ action, target }) =>
            action === "workflow.decision.approved" && target?.id === decisionId
        ).length,
        receipts: events
          .filter(
            ({ action, target, detail }) =>
              action === "workflow.run.called" &&
              target?.id === runId &&
              detail?.call === "grasp.decision"
          )
          .map(({ detail }) => detail?.outcome),
      }).toStrictEqual({
        first: "answered",
        again: "answered",
        other: "decision.closed",
        ended: { status: "completed", output: { status: "done" } },
        decisions: [{ status: "approved", decidedBy: reviewer.userId }],
        openings: 1,
        approvals: 1,
        receipts: ["opened", "answered"],
      });
    });

    it("answer from a page only a decision of the version the release pins, as its inbox lists them", async () => {
      const { fixture, opened, reviewer, runAsking } = await decisionInbox();
      const { app } = fixture;
      // The App's binding of `review` moved to version 2 without a new
      // release: the release still pins version 1.
      await env.DB.prepare(
        "UPDATE app_workflow_bindings SET workflow_resource_version = 2 WHERE app_id = ? AND alias = 'review' AND status = 'active'"
      )
        .bind(app)
        .run();
      const unsealed = await runAsking(app, opened, { version: 2 });

      await expect(
        codeOf(
          async () =>
            await reviewPageDecision(
              env,
              reviewer,
              { app, version: 1 },
              unsealed.runId,
              unsealed.decisionId,
              { approved: true, payload: { comment: "Fine" } }
            )
        )
      ).resolves.toBe("decision.not_found");
    });

    it("say a run's decision wait is answerable only by whom it asks, never staff, and only where the run's restricted mode is the App's", async () => {
      const { fixture, opened, reviewer, starter, outsider, runAsking } =
        await decisionInbox();
      const asked = await runAsking(fixture.app, opened);
      const decisionWait = {
        kind: "decision",
        id: asked.decisionId,
        taskId: "ask",
        key: "approval",
        title: "ask",
        openedAt: opened,
        deadline: opened + 86_400_000,
        canRespond: false,
      };
      // A timer beside it, which nothing of this changes.
      const timer = { kind: "timer", id: "wait-1", purpose: "sleep" };
      const respond = async (
        viewer: Parameters<typeof withRespond>[3]
      ): Promise<unknown[]> => {
        const waits = await withRespond(
          env,
          asked.runId,
          [decisionWait, timer],
          viewer
        );
        return waits.map(
          (wait) =>
            z.object({ canRespond: z.boolean() }).safeParse(wait).data
              ?.canRespond
        );
      };
      const shown = {
        reviewer: await respond({
          userId: reviewer.userId,
          sameRestriction: true,
        }),
        starter: await respond({
          userId: starter.userId,
          sameRestriction: true,
        }),
        outsider: await respond({
          userId: outsider.userId,
          sameRestriction: true,
        }),
        staff: await respond({
          userId: reviewer.userId,
          staff: true,
          sameRestriction: true,
        }),
        otherRestriction: await respond({
          userId: reviewer.userId,
          sameRestriction: false,
        }),
      };
      await env.DB.prepare(
        "UPDATE workflow_decisions SET status = 'approved' WHERE id = ?"
      )
        .bind(asked.decisionId)
        .run();

      expect({
        ...shown,
        answered: await respond({
          userId: reviewer.userId,
          sameRestriction: true,
        }),
      }).toStrictEqual({
        reviewer: [true, undefined],
        starter: [false, undefined],
        outsider: [false, undefined],
        staff: [false, undefined],
        otherRestriction: [false, undefined],
        answered: [false, undefined],
      });
    });

    it("follow the App's bindings in a draft, and fail a page's type check on a decision the workflow doesn't have", async () => {
      const { fixture, binding } = await boundApp();
      const draftErrors = async (key: string) => {
        const drafted = await withDraftReferences(
          env,
          fixture.app,
          1,
          files(pageOf(key))
        );
        return await pageErrors(fixture, drafted.files);
      };
      const bound = await draftErrors("approval");
      const missing = await draftErrors("missing");
      await unbindWorkflowFromApp(env, fixture.owner, binding);
      const unbound = await draftErrors("approval");

      expect({
        bound,
        missing: missing.some((message) => message.includes("missing")),
        unbound: unbound.some((message) => message.includes("approval")),
      }).toStrictEqual({ bound: [], missing: true, unbound: true });
    });

    it("resolve every workflow an App declares and binds, more of them than one statement binds values", async () => {
      const { fixture, workflowId } = await boundApp();
      const release = await seal(fixture);
      // 60 more aliases, each declared and bound to the same version: past
      // the 100 values D1 binds to one statement, two per pinned version.
      const declared = release.app.workflows.review;
      if (declared === undefined) {
        throw new Error("The App declares no review");
      }
      const aliases = Array.from(
        { length: 60 },
        (_, index) => `review${index}`
      );
      await env.DB.batch(
        aliases.map((alias) =>
          env.DB.prepare(
            "INSERT INTO app_workflow_bindings (id, app_id, alias, workflow_resource_id, workflow_resource_version, status, bound_by, bound_at) VALUES (?, ?, ?, ?, 1, 'active', ?, ?)"
          ).bind(
            crypto.randomUUID(),
            fixture.app,
            alias,
            workflowId,
            fixture.owner.userId,
            Date.now()
          )
        )
      );
      const bound = await boundWorkflowsOf(env, fixture.app, {
        ...release.app,
        workflows: {
          ...release.app.workflows,
          ...Object.fromEntries(
            aliases.map((alias) => [alias, { ...declared, alias }])
          ),
        },
      });

      expect({
        count: bound.length,
        eachDecides: bound.every(({ decisions }) =>
          Object.hasOwn(decisions, "approval")
        ),
      }).toStrictEqual({ count: 61, eachDecides: true });
    });

    it("seal the events a page sends, and the event waits on them as typed waits", async () => {
      const fixture = await eventApp();
      const release = await seal(fixture);
      const references = await sealedText(release, generatedPaths.api);
      const sealed = release.workflows.find(({ alias }) => alias === "review");

      expect({
        events: sealed?.events,
        listens: sealed?.listens,
        typedWait: references.includes(
          'WorkflowEventWait<"await-job", WorkflowEventReference<"workflows.review", "jobEvents", "grasp.job.completed"'
        ),
        page: await pageErrors(
          fixture,
          await withPageReferences(
            env,
            fixture.app,
            1,
            await versionFiles(env, fixture.app, 1)
          )
        ),
      }).toStrictEqual({
        events: {
          jobEvents: {
            type: "grasp.job.completed",
            data: v.object({ jobId: v.string() }).descriptor,
          },
        },
        listens: { "await-job": ["jobEvents"] },
        typedWait: true,
        page: [],
      });
    });

    it("read the catalog contracts their decisions name, more of them than one statement binds values", async () => {
      const admin = await person("admin");
      const contract = canonicalJson({
        kind: "decision",
        input: JSON.stringify(context.descriptor),
        response: JSON.stringify(value.descriptor),
      });
      const fingerprint = await sha256Hex(contract);
      const keys = Array.from(
        { length: 120 },
        (_, index) => `many-${unique()}-${index}`
      );
      await env.DB.batch(
        keys.map((key) =>
          env.DB.prepare(
            "INSERT INTO workflow_catalog_contracts (key, kind, contract, fingerprint, published_by, published_at) VALUES (?, 'decision', ?, ?, ?, ?)"
          ).bind(key, contract, fingerprint, admin.userId, Date.now())
        )
      );

      const resolved = await resolveCatalogKeys(env, keys);

      expect(resolved.size).toBe(120);
    });
  }
);
