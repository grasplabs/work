import { runActorOf } from "@grasp-os/shared/audit";
import { appIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";

import type { ModelCall } from "../src/models.ts";
import {
  listResourceBindings,
  revokeResourceBinding,
} from "../src/resource-bindings.ts";
import { release as nextVersion } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import type { ProviderReply } from "./model-provider.ts";
import {
  appWith,
  llm,
  currentPastActivation,
  anthropic,
  euModel,
  withRules,
  withDeploymentRules,
  modelActions,
  eventsOf,
  callsInAnApp,
} from "./model-rules.ts";
import { finished, sleeping, woken } from "./runs.ts";
import { person } from "./sealed-apps.ts";
import { outcome, signedInApi } from "./sign-in.ts";
import {
  bindModel,
  modelRegistration,
  workflowFiles,
} from "./workflow-apps.ts";

// The client's rules for model calls, checked on every call before
// anything is sent: which models, in which work context, and through
// which binding. The model provider behind connect is the outside system
// (test/model-provider.ts). Everything else is real, down to the audit
// log and, for the
// rules a workflow run meets, the run.

const idp = mockIdp();

// The tests that run a workflow release an App of their own, which runs
// its workflow tests to activate it, have permissions granted where they
// need them, and wait for up to two runs to end, one after another
// (`finished` gives each up to 20 seconds). On a loaded CI runner that
// takes longer than Vitest's default five seconds. Sixty seconds fits two runs' waits with room for the setup, as
// app-roles.test.ts and knowledge-access.test.ts give theirs.
describe("model rules", { timeout: 60_000 }, () => {
  const hello = callsInAnApp(idp);

  it("audit a model the organization didn't choose as refused", async () => {
    const { call } = await withRules();
    const refused = hello("anthropic/claude-opus-4-1");

    await expect(outcome(call(refused))).resolves.toBe("model.not_allowed");
    await expect(eventsOf(refused.trigger)).resolves.toMatchObject([
      {
        action: "model.refused",
        detail: {
          reason: "model.not_allowed",
          because: null,
          model: "anthropic/claude-opus-4-1",
          provenanceDropped: 0,
        },
      },
    ]);
  });

  it("record a refusal whose provenance is too large for the audit log, with as much of it as fits", async () => {
    const { call } = await withRules();
    // A hundred identifiers of 256 three-byte characters: 77 KB.
    const provenance = Array.from({ length: 100 }, (_, index) =>
      `${index}`.padEnd(256, "€")
    );
    const refused = hello("anthropic/claude-opus-4-1", { provenance });

    await expect(outcome(call(refused))).resolves.toBe("model.not_allowed");
    const [event, ...more] = await eventsOf(refused.trigger);
    const kept = event?.provenance.length ?? 0;
    expect({
      more: more.length,
      kept: kept > 0 && kept < 100,
      provenance: event?.provenance,
      dropped: event?.detail.provenanceDropped,
    }).toStrictEqual({
      more: 0,
      kept: true,
      provenance: provenance.slice(0, kept),
      dropped: 100 - kept,
    });
  });

  it("refuse and audit a call that claims to work in another App's context", async () => {
    const { fake, call } = await withRules();
    const app = appIdSchema.parse(`app-${crypto.randomUUID()}`);
    const other = appIdSchema.parse(`app-${crypto.randomUUID()}`);
    const claimed = hello(anthropic, {
      work: {
        authority: {
          subject: { type: "app", appId: app },
          onBehalfOf: "person-1",
          mode: "workflow",
          appVersion: 1,
        },
        context: { type: "app", appId: other },
      },
    });

    await expect(outcome(call(claimed))).resolves.toBe(
      "permission.context_invalid"
    );
    expect(fake.requests).toStrictEqual([]);
    await expect(eventsOf(claimed.trigger)).resolves.toMatchObject([
      {
        action: "model.refused",
        detail: { reason: "permission.context_invalid", because: null },
      },
    ]);
  });

  it("refuse and audit a call that comes without a work context", async () => {
    const { fake, call } = await withRules();
    const { work: _, ...withoutWork } = hello(anthropic);
    // SAFETY: missing on purpose, as from a caller that isn't type-checked;
    // every typed caller must pass `work`.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const contextless = withoutWork as ModelCall<undefined>;

    await expect(outcome(call(contextless))).resolves.toBe(
      "permission.context_invalid"
    );
    expect(fake.requests).toStrictEqual([]);
    await expect(eventsOf(contextless.trigger)).resolves.toMatchObject([
      {
        action: "model.refused",
        detail: { reason: "permission.context_invalid", because: null },
      },
    ]);
  });

  it("refuse a workflow's AI step through an alias no admin bound, or one its version doesn't declare however it became current, before any model is asked", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(
      builder,
      workflowFiles("reader", llm("retries: { limit: 2, delay: 1 },"), {
        extract: { total: 1234 },
      })
    );
    const { fake, result: runs } = await withDeploymentRules([], async () => {
      const unbound = await builder.api.workflows.start(app, "reader");
      await finished(unbound.id);
      // A version that no longer declares `anywhere`, though an admin
      // bound it for the one before, and whose step still names it:
      // activation refuses it, and the run's own gate all the same.
      await bindModel(app, "anywhere", anthropic);
      const activation = await currentPastActivation(builder, app, {
        ...modelRegistration({ reader: 32_768, eu: 32_768 }),
        ...workflowFiles(
          "stranger",
          llm("retries: { limit: 2, delay: 1 },").replace(
            'binding: "reader"',
            'binding: "anywhere"'
          ),
          { extract: { total: 1234 } }
        ),
      });
      const undeclared = await builder.api.workflows.start(app, "stranger");
      await finished(undeclared.id);
      return { activation, unbound: unbound.id, undeclared: undeclared.id };
    });
    const refused = {
      status: "failed",
      failure: { error: { code: "resource.unavailable" } },
    };
    expect(runs.activation).toBe("workflow.model_undeclared");
    await expect(
      Promise.all([
        builder.api.workflows.status(runs.unbound),
        builder.api.workflows.status(runs.undeclared),
      ])
    ).resolves.toMatchObject([refused, refused]);
    // Not retried, and nothing reached the provider or the ledger.
    expect(fake.requests).toStrictEqual([]);
    const events = await eventsOf(
      runActorOf({ runId: runs.unbound, app, workflow: "reader" })
    );
    expect(modelActions(events)).toStrictEqual([]);
  });

  it("refuse a workflow's AI step through a model resource with a structured output however its version became current: the step brings its own schema", async () => {
    const builder = await signedInApi(idp, "builder");
    const { id: app } = await builder.api.apps.create({ name: "Models" });
    // A declaration whose answers are the App's own shape, which
    // activation refuses: the run's own gate refuses it all the same.
    const activation = await currentPastActivation(builder, app, {
      "schema.ts": `import { defineSchema } from "@grasp-os/sdk";

export default defineSchema({});
`,
      "app.ts": `import { app, resource, v } from "@grasp-os/sdk";

import schema from "./schema.ts";

export const reader = resource.model("reader", {
  structuredOutput: v.object({ total: v.number() }),
  maxOutputTokens: 32_768,
});

export default app({
  name: "Models",
  schema,
  access: { tables: {} },
  operations: {},
  internalOperations: {},
  screens: [],
  uses: [reader],
});
`,
      ...workflowFiles("reader", llm("retries: { limit: 2, delay: 1 },"), {
        extract: { total: 1234 },
      }),
    });
    const { fake, result: run } = await withDeploymentRules([], async () => {
      // Bound by an admin all the same: it serves the App's actions.
      await bindModel(app, "reader", anthropic);
      const started = await builder.api.workflows.start(app, "reader");
      await finished(started.id);
      return started.id;
    });
    expect(activation).toBe("workflow.model_undeclared");
    await expect(builder.api.workflows.status(run)).resolves.toMatchObject({
      status: "failed",
      failure: { error: { code: "resource.unavailable" } },
    });
    expect(fake.requests).toStrictEqual([]);
  });

  it("send a step's next attempt through its binding as it is then: none once revoked, the new one once replaced", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(
      builder,
      workflowFiles("reader", llm("retries: { limit: 1, delay: 3000 },"), {
        extract: { total: 1234 },
      })
    );
    // Each attempt's request fails as a server does, which the gateway
    // neither retries nor falls back from: the step is tried again.
    const failing: ProviderReply[] = [{ status: 500 }];
    const attemptOnce = async (change: () => Promise<unknown>) =>
      await withDeploymentRules(
        [
          ...failing,
          { text: '{ "total": 1234 }', inputTokens: 10, outputTokens: 5 },
        ],
        async () => {
          await bindModel(app, "reader", anthropic);
          const run = await builder.api.workflows.start(app, "reader");
          // The first attempt has failed, as the ledger recorded it: the
          // binding changes before the next.
          await vi.waitFor(
            async () => {
              const events = await eventsOf(
                runActorOf({ runId: run.id, app, workflow: "reader" })
              );
              expect(modelActions(events)).not.toStrictEqual([]);
            },
            { timeout: 10_000, interval: 100 }
          );
          await change();
          await finished(run.id);
          return await builder.api.workflows.status(run.id);
        }
      );
    const revoked = await attemptOnce(async () => {
      const [binding] = await listResourceBindings(
        env,
        await person("admin"),
        app
      );
      await revokeResourceBinding(
        env,
        await person("admin"),
        binding?.id ?? ""
      );
    });
    const replaced = await attemptOnce(
      async () => await bindModel(app, "reader", euModel)
    );
    expect({
      revoked: {
        run: revoked.result,
        // Nothing more was sent once it was revoked.
        sent: revoked.fake.requests.length,
      },
      replaced: {
        run: replaced.result,
        // The next attempt asked the model the new binding names.
        lastToEuModel: replaced.fake.requests.at(-1)?.url.includes("openai"),
      },
    }).toMatchObject({
      revoked: {
        run: {
          status: "failed",
          failure: { error: { code: "resource.unavailable" } },
        },
        sent: failing.length,
      },
      replaced: {
        run: { status: "completed", output: { total: 1234 } },
        lastToEuModel: true,
      },
    });
  });

  it("refuse a run pinned to a version whose declaration its alias was rebound away from", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(
      builder,
      workflowFiles(
        "later",
        `  await step.sleep("go", { description: "Wait", duration: "1 day" });
${llm("retries: { limit: 2, delay: 1 },")}`,
        { extract: { total: 1234 } }
      )
    );
    const { fake, result: run } = await withDeploymentRules([], async () => {
      await bindModel(app, "reader", anthropic);
      const started = await builder.api.workflows.start(app, "later");
      await sleeping(started.id, "go");
      // The next version asks for shorter answers, and its admin binds
      // that declaration: the run stays on the first version.
      await nextVersion(builder, app, modelRegistration({ reader: 16_384 }));
      await bindModel(app, "reader", anthropic);
      await woken(started.id);
      await finished(started.id);
      return started.id;
    });
    await expect(builder.api.workflows.status(run)).resolves.toMatchObject({
      status: "failed",
      failure: { error: { code: "resource.unavailable" } },
    });
    expect(fake.requests).toStrictEqual([]);
  });

  it("refuse an AI step's next attempt the answer its timed-out attempt left, once its binding was revoked meanwhile", async () => {
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(
      builder,
      workflowFiles(
        "reader",
        llm("timeout: 1000, retries: { limit: 3, delay: 1 },"),
        { extract: { total: 1234 } }
      )
    );
    const release = Promise.withResolvers<boolean>();

    // The provider answers the first attempt only after its second began;
    // the binding is revoked before it does.
    const { fake, result } = await withDeploymentRules(
      [
        {
          text: '{ "total": 1234 }',
          inputTokens: 10,
          outputTokens: 5,
          pause: { at: 1, until: release.promise },
        },
      ],
      async () => {
        const binding = await bindModel(app, "reader", anthropic);
        const run = await builder.api.workflows.start(app, "reader");
        await scheduler.wait(1500);
        await revokeResourceBinding(env, await person("admin"), binding.id);
        await scheduler.wait(1000);
        release.resolve(true);
        await finished(run.id);
        return await builder.api.workflows.status(run.id);
      }
    );

    expect({ run: result, sent: fake.requests.length }).toMatchObject({
      run: {
        status: "failed",
        failure: { error: { code: "resource.unavailable" } },
      },
      sent: 1,
    });
  });
});
