/* oxlint-disable no-template-curly-in-string -- workflow expressions are written as ${ … } strings */
import { v } from "@grasp-os/sdk";
import { generatedPaths } from "@grasp-os/sdk/host";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { canonicalJson } from "@grasp-os/shared/json";
import type { OperationResult } from "@grasp-os/shared/operations";
import { workflowNamespace } from "@grasp-os/shared/workflow-resources";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { callAppFunction, callScreenFunction } from "../src/app-functions.ts";
import { artifactKey } from "../src/app-releases.ts";
import type { Release } from "../src/app-releases.ts";
import {
  bindWorkflowToApp,
  unbindWorkflowFromApp,
} from "../src/app-workflow-bindings.ts";
import { setCurrentVersion, versionFiles } from "../src/apps.ts";
import { boundWorkflowsOf } from "../src/bound-workflows.ts";
import { withDraftReferences } from "../src/draft-references.ts";
import { withScreenReferences } from "../src/screen-references.ts";
import { buildScreens } from "../src/screens.ts";
import {
  publishCatalogContract,
  resolveCatalogKeys,
} from "../src/workflow-catalog.ts";
import {
  createWorkflowResource,
  publishWorkflowVersion,
} from "../src/workflow-resources.ts";
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

const context = v.object({ amount: v.number() });
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

/** What a call answered, or its refusal's code. */
const answerOf = (result: OperationResult): unknown =>
  result.ok ? result.value : result.error.code;

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

    it("answer an empty inbox, and refuse every decision alike, while independent runs have none", async () => {
      const { fixture } = await boundApp();
      const release = await seal(fixture);
      await setCurrentVersion(env, fixture.owner, fixture.app, 1);
      const ask = async (
        name: "decisions" | "decision",
        input: unknown,
        window?: number
      ): Promise<OperationResult> => {
        const request = JSON.stringify({
          reference: await queryReference(release, "review", name),
          input,
          ...(window === undefined ? {} : { window: { extent: window } }),
        });
        const { result } =
          window === undefined
            ? await callAppFunction(env, fixture.owner, fixture.app, request)
            : await callScreenFunction(
                env,
                fixture.owner,
                fixture.app,
                request,
                Date.now() + 30_000,
                async () => {
                  // A window's pages cost nothing here.
                }
              );
        return result;
      };
      expect({
        inbox: answerOf(await ask("decisions", { pagination: {} })),
        window: answerOf(await ask("decisions", {}, 20)),
        decision: answerOf(
          await ask("decision", { runId: "run-1", decisionId: "decision-1" })
        ),
      }).toStrictEqual({
        inbox: { items: [], nextCursor: null, hasMore: false },
        window: { items: [], hasMore: false },
        decision: "workflow.decision_unavailable",
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
