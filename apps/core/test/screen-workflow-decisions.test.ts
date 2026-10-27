/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
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
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { callAppFunction, callScreenFunction } from "../src/app-functions.ts";
import { artifactKey } from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import {
  bindWorkflowToApp,
  unbindWorkflowFromApp,
} from "../src/app-workflow-bindings.ts";
import { setCurrentVersion, versionFiles } from "../src/apps.ts";
import { boundWorkflowsOf } from "../src/bound-workflows.ts";
import { decisionOutcome } from "../src/decisions/decisions.ts";
import { withDraftReferences } from "../src/draft-references.ts";
import { appHost } from "../src/durable-objects.ts";
import { withScreenReferences } from "../src/screen-references.ts";
import { readWorkflowWatch } from "../src/screen-workflows.ts";
import { buildScreens } from "../src/screens.ts";
import {
  publishCatalogContract,
  resolveCatalogKeys,
} from "../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
import { withRespond } from "../src/workflows/run-waits.ts";
import {
  confirmScreenDecision,
  decideScreenRun,
  reviewScreenDecision,
} from "../src/workflows/screen-runs.ts";
import { allEvents } from "./audit-events.ts";
import { appWith, person, queryReference, seal } from "./sealed-apps.ts";
import type { Fixture } from "./sealed-apps.ts";
import { unique } from "./sign-in.ts";

// The decisions of the workflows an App binds, in the references its
// screens import (bound-workflows.ts): each of the bound version's
// decision bindings, read from the catalog contract it pinned, typed in
// `workflows.<alias>.decisions`. Sealed with the release, so a binding
// changed later changes no sealed version's screens; a draft's references
// follow the App's bindings as they are.

/** A screen reading `key` of the `review` workflow's decisions. */
const screenOf = (key: string): string => `import { workflows } from "#grasp";

const decision = workflows.review.decisions.${key};
export const valueSchema = decision.valueSchema;
export const context = decision.context;

export default function Desk() {
  return <p>{decision.key}</p>;
}
`;

const files = (screen = screenOf("approval")): Record<string, string> => ({
  "schema.ts": `import { defineSchema, defineTable, v } from "@grasp-os/sdk";

export default defineSchema({
  invoices: defineTable({ amount: v.number() }),
});
`,
  "operations/invoices.ts": `import { resource, v } from "@grasp-os/sdk";
import { query } from "#grasp/server";

export const review = resource.workflow("review", {
  input: v.object({ amount: v.number() }),
  output: v.object({ status: v.string() }),
});

export const count = query({
  args: {},
  returns: v.number(),
  handler: async (ctx) => (await ctx.db.query("invoices").collect()).length,
});
`,
  "app.ts": `import { app } from "@grasp-os/sdk";
import { count, review } from "./operations/invoices.ts";
import schema from "./schema.ts";

export default app({
  name: "Invoices",
  schema,
  access: { tables: { invoices: { read: "appMembers", write: "appMembers" } } },
  operations: { invoices: { count } },
  screens: [],
  uses: [review],
});
`,
  "screens/desk.tsx": screen,
});

const objectSchema = (properties: Record<string, unknown>) => ({
  format: "json",
  document: {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  },
});

/** An approval workflow asking for decision `contract` as `approval`. */
const definitionOf = (name: string, contract: string): string =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace: workflowNamespace,
      name,
      version: "1.0.0",
      title: name,
      metadata: {
        grasp: {
          profile: "grasp-open-workflow/1",
          params: {},
          bindings: { approval: { kind: "decision", contract } },
        },
      },
    },
    input: { schema: objectSchema({ amount: { type: "number" } }) },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: [
      {
        ask: {
          call: "grasp.decision",
          with: {
            binding: "approval",
            recipients: ["role:admin"],
            prompt: "Approve this invoice?",
            input: { amount: "${ $workflow.input.amount }" },
          },
        },
      },
      { finish: { set: { status: "done" } } },
    ],
  });

// Null too: a decision's context may be JSON `null` when its contract takes it.
const context = v.object({ amount: v.number() }).nullable();
const value = v.object({ comment: v.string() });

/** An App bound to a workflow version with a decision binding, as `review`. */
const boundApp = async (): Promise<{
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
    definition: definitionOf(workflow.name, key),
    basedOn: null,
  });
  const { id } = await bindWorkflowToApp(env, fixture.owner, workflow.id, {
    app: fixture.app,
    alias: "review",
    version: 1,
  });
  return { fixture, binding: id, workflowId: workflow.id };
};

/** A screen sending the `review` workflow's `jobEvents`, its type literal. */
const eventScreen = `import { workflows } from "#grasp";

const event = workflows.review.events.jobEvents;
export const type: "grasp.job.completed" = event.type;
export const data = event.data;

export default function Desk() {
  return <p>{event.alias}</p>;
}
`;

/** A job's events, one a screen sends and one it doesn't, both of `jobId`. */
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

/** A workflow waiting, in `await-job`, for the job event a screen sends. */
const eventDefinitionOf = (name: string, contract: string): string =>
  JSON.stringify({
    document: {
      dsl: "1.0.3",
      namespace: workflowNamespace,
      name,
      version: "1.0.0",
      title: name,
      metadata: {
        grasp: {
          profile: "grasp-open-workflow/1",
          params: {},
          bindings: { jobEvents: { kind: "event", contract } },
        },
      },
    },
    input: { schema: objectSchema({ amount: { type: "number" } }) },
    output: { schema: objectSchema({ status: { type: "string" } }) },
    do: [
      {
        "await-job": {
          listen: {
            to: { one: { with: { type: "grasp.job.completed" } } },
            read: "data",
          },
          timeout: { after: { hours: 24 } },
          metadata: { grasp: { binding: "jobEvents" } },
        },
      },
      { finish: { set: { status: "done" } } },
    ],
  });

/** An App bound, as `review`, to a workflow version waiting for a screen's event. */
const eventApp = async (): Promise<Fixture> => {
  const admin = await person("admin");
  const fixture = await appWith(files(eventScreen), "Invoices");
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
    definition: eventDefinitionOf(workflow.name, key),
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

/** The errors of a build of `files`' screens, for `fixture`'s version 1. */
const screenErrors = async (
  fixture: Fixture,
  built: Record<string, string>
): Promise<string[]> => {
  const build = await buildScreens(env, built, fixture.app);
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
 * The person `who`'s whole answer `answer` to decision `of` on `screen`, as
 * the page makes it: reviewed, confirmed in its dialog, then sent with
 * that confirmation. Answers the decision's status as it answered, or the
 * code it was refused with.
 */
const answered = async (
  who: Parameters<typeof reviewScreenDecision>[1],
  screen: Parameters<typeof reviewScreenDecision>[2],
  of: { runId: string; decisionId: string },
  answer: { approved: boolean; payload?: unknown },
  /** Between the confirmation and the answer. */
  between: () => Promise<void> = async () => {
    await Promise.resolve();
  }
): Promise<unknown> => {
  try {
    const reviewed = await reviewScreenDecision(
      env,
      who,
      screen,
      of.runId,
      of.decisionId,
      answer
    );
    if (reviewed.state !== "review") {
      return reviewed.decision.status;
    }
    const { confirmation } = await confirmScreenDecision(
      env,
      who,
      screen,
      of.runId,
      of.decisionId,
      reviewed.decision.revision,
      reviewed.response
    );
    await between();
    const view = await decideScreenRun(
      env,
      who,
      screen,
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

/** What a call answered, or its refusal's code. */
const answerOf = (result: OperationResult): unknown =>
  result.ok ? result.value : result.error.code;

/**
 * An App bound to the decision workflow, sealed and current, with a
 * reviewer, a starter and an outsider among its people; runs of its pinned
 * version it started for the starter, each asking the admins; and a call
 * of its decision queries, as whoever calls.
 */
const decisionInbox = async () => {
  const { fixture, workflowId, binding } = await boundApp();
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
      step = "task:ask",
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
      reference: await queryReference(release, "review", name),
      input,
      ...(window === undefined ? {} : { window: { extent: window } }),
    });
    const { result } =
      window === undefined
        ? await callAppFunction(env, who, fixture.app, request)
        : await callScreenFunction(
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
    it("are sealed into the release's references, typed for its screens, and stay as sealed when the binding goes", async () => {
      const { fixture, binding } = await boundApp();
      const release = await seal(fixture);
      const references = await sealedText(release, generatedPaths.references);
      const sealedFiles = await versionFiles(env, fixture.app, 1);
      const sealedBuild = async () =>
        await screenErrors(
          fixture,
          await withScreenReferences(env, fixture.app, 1, sealedFiles)
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
        step: "task:other",
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

    it("answer an independent run's decision from the App's screen once, after the page's confirmation, and refuse every decision the App may not answer alike", async () => {
      const { fixture, binding, opened, reviewer, outsider, runAsking, ask } =
        await decisionInbox();
      const { app } = fixture;
      // The screen's App, at the release its frame runs.
      const screen = { app, version: 1 };
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
            await reviewScreenDecision(
              env,
              who,
              screen,
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
      const reviewed = await reviewScreenDecision(
        env,
        reviewer,
        screen,
        asked.runId,
        asked.decisionId,
        answer
      );
      if (reviewed.state !== "review") {
        throw new Error("Nothing to review");
      }
      // The screen alone can't answer: only with the page's confirmation.
      const unconfirmed = await codeOf(
        async () =>
          await decideScreenRun(
            env,
            reviewer,
            screen,
            asked.runId,
            asked.decisionId,
            reviewed.response,
            null
          )
      );
      const { confirmation } = await confirmScreenDecision(
        env,
        reviewer,
        screen,
        asked.runId,
        asked.decisionId,
        reviewed.decision.revision,
        reviewed.response
      );
      const decided = await decideScreenRun(
        env,
        reviewer,
        screen,
        asked.runId,
        asked.decisionId,
        reviewed.response,
        confirmation
      );
      // Exactly that answer again is the recorded decision; another isn't.
      const again = await decideScreenRun(
        env,
        reviewer,
        screen,
        asked.runId,
        asked.decisionId,
        reviewed.response,
        confirmation
      );
      const changed = await codeOf(
        async () =>
          await decideScreenRun(
            env,
            reviewer,
            screen,
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
      // its screens' to answer.
      const later = await runAsking(app, opened + 3000);
      // Once the App reads restricted data, a run it started before stays
      // unrestricted: an answer its screen composes may carry what it read.
      await appHost(env, appIdSchema.parse(app)).restrict();
      const afterRestricting = {
        answer: await review(reviewer, later),
        listed: await ask(reviewer, "decisions", {
          runId: later.runId,
          pagination: {},
        }),
      };
      // A run as restricted as the App is now: its screen may answer it,
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
        // Which App's screen answered: an independent run names none.
        answeredBy: { via: "screen", app },
        afterRestricting: {
          answer: "decision.not_found",
          // Still shown to the reviewer, as one their screen can't answer.
          listed: {
            items: [{ wait: { id: later.decisionId, canRespond: false } }],
          },
        },
        beforeUnbinding: "answered",
        unbound: "decision.not_found",
      });
    });

    it("keep one answer of a decision answered from screens at once, or against its deadline, and take none against a changed context or a binding gone", async () => {
      const { fixture, binding, workflowId, opened, reviewer, runAsking } =
        await decisionInbox();
      const { app } = fixture;
      const screen = { app, version: 1 };
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
        answered(reviewer, screen, raced, approve, barrier),
        answered(second, screen, raced, reject, barrier),
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
        screen,
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
      const intime = await answered(reviewer, screen, answeredFirst, approve);
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
        screen,
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
      const reviewedAgain = await answered(reviewer, screen, changed, approve);
      // Its acknowledgement lost, the page asks once more: the recorded
      // answer, never a second one.
      const askedTwice = await answered(reviewer, screen, changed, approve);
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
        screen,
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
              waits: parsed.data.waits.map(({ kind, canRespond }) => ({
                kind,
                canRespond,
              })),
              control: parsed.data.control,
              output: "output" in parsed.data,
            }
          : snapshot;
      };
      const asked = await runAsking(app, opened);
      const staff = { ...(await person("admin")), staff: true };
      // A control asked of it by the reviewer: refused, as for no run.
      const cancelled = await callScreenFunction(
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
      // The App in restricted mode: the run, unrestricted, isn't its
      // screen's to answer, so not the reviewer's to watch.
      const unrestrictedBefore = await watched(reviewer, asked.runId);
      await appHost(env, appIdSchema.parse(app)).restrict();

      expect({
        ...before,
        unrestrictedBefore: typeof unrestrictedBefore,
        afterRestricting: await watched(reviewer, asked.runId),
        answered: await watched(reviewer, answeredRun.runId),
        closed: await watched(reviewer, closedRun.runId),
        reassigned: await watched(reviewer, reassignedRun.runId),
      }).toStrictEqual({
        reviewer: {
          // No engine runs these rows' run, so it waits on nothing the
          // engine lists (run-waits.ts); a real run's are the journey's.
          waits: [],
          control: {
            canPause: false,
            canResume: false,
            canCancel: false,
            pendingControl: null,
          },
          output: false,
        },
        outsider: "workflow.run_unavailable",
        staff: "workflow.run_unavailable",
        cancel: "workflow.run_unavailable",
        unrestrictedBefore: "object",
        afterRestricting: "workflow.run_unavailable",
        answered: "workflow.run_unavailable",
        closed: "workflow.run_unavailable",
        reassigned: "workflow.run_unavailable",
      });
    });

    it("answer from a screen only a decision of the version the release pins, as its inbox lists them", async () => {
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
            await reviewScreenDecision(
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

    it("follow the App's bindings in a draft, and fail a screen's type check on a decision the workflow doesn't have", async () => {
      const { fixture, binding } = await boundApp();
      const draftErrors = async (key: string) =>
        await screenErrors(
          fixture,
          await withDraftReferences(env, fixture.app, 1, files(screenOf(key)))
        );
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

    it("seal the events a screen sends, and the listen tasks waiting on them as typed waits", async () => {
      const fixture = await eventApp();
      const release = await seal(fixture);
      const references = await sealedText(release, generatedPaths.references);
      const sealed = release.workflows.find(({ alias }) => alias === "review");

      expect({
        events: sealed?.events,
        listens: sealed?.listens,
        typedWait: references.includes(
          'WorkflowEventWait<"await-job", WorkflowEventReference<"workflows.review", "jobEvents", "grasp.job.completed"'
        ),
        screen: await screenErrors(
          fixture,
          await withScreenReferences(
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
        screen: [],
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
