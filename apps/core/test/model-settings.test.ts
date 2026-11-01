import { runActorOf } from "@grasp-os/shared/audit";
import { appIdSchema, runIdSchema } from "@grasp-os/shared/ids";
import { modelSpendListed } from "@grasp-os/shared/models";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { budgetDay } from "../src/model-budgets.ts";
import { modelLedger } from "../src/model-ledger.ts";
import type { LedgerScope } from "../src/model-ledger.ts";
import { modelForRole, models, modelSettings } from "../src/models.ts";
import type { ModelCall, ModelsNow } from "../src/models.ts";
import { mockIdp } from "./idp.ts";
import { connectModels, fakeProviderFor } from "./model-provider.ts";
import { finished } from "./runs.ts";
import {
  openRpc,
  outcome,
  signedIn,
  signedInApi,
  signedInWithRole,
  staffPerson,
} from "./sign-in.ts";
import { appWith, workflowFiles } from "./workflow-apps.ts";

// Admins read the model gateway's settings: the models the organization
// chose, the client's rules, and this month's spend against each budget,
// which real model calls add to. The provider behind connect is the
// outside system: a fake (test/model-provider.ts).

const idp = mockIdp();

const mistral = "mistral/mistral-large-latest";
const anthropic = "anthropic/claude-sonnet-4-5";
const euModel = "openai/gpt-5.4";
/** The models the organization chose: its default, then its fallbacks. */
const chosen = [anthropic, mistral, euModel];

/**
 * An answer that costs $0.0045 from Claude Sonnet 4.5, at its list prices:
 * $3 per million tokens in, $15 out.
 */
const pricedAnswer = { text: "Hi.", inputTokens: 1000, outputTokens: 100 };

let monthsUsed = 0;

/** A month no other test counts spend in: from 2200, clear of other files. */
const newMonth = (): string => {
  monthsUsed += 1;
  return `${2200 + Math.floor(monthsUsed / 12)}-${String((monthsUsed % 12) + 1).padStart(2, "0")}`;
};

/** The model each onboarding role gets, for calls that carry sensitive data. */
const roleIn = (settings: ModelsNow) => ({
  quick: modelForRole(settings, "quick", { sensitive: true }),
  careful: modelForRole(settings, "careful", { sensitive: true }),
});

/** Core's env with `config` as the deployment's rules, counting in its own month. */
const envWith = (config?: unknown) => {
  const coreEnv: Env = {
    ...env,
    MODEL_GATEWAY: config,
    MODEL_BUDGET_MONTH: newMonth(),
  };
  return coreEnv;
};

/** Chooses `refs` with a key no other test uses (`connectModels`). */
const choose = async (...refs: string[]): Promise<void> => {
  await connectModels(`test-model-key-${crypto.randomUUID()}`, refs);
};

/** A scope the ledger counts spend in, with no budget. */
const counted = (scope: "user" | "workflow", key: string): LedgerScope => ({
  scope,
  key,
  limitMicros: null,
  alertMicros: null,
  names: {},
});

/** Shares of the requests in flight roomy enough that none fills here. */
const roomyFair = () => ({
  place: crypto.randomUUID(),
  subject: "spend-settings",
  resource: null,
  shares: {
    client: 1000,
    person: 1000,
    app: 1000,
    queuedPerPerson: 1000,
    queuedPerApp: 1000,
  },
});

/** The settings as an admin reads them from `coreEnv`. */
const settingsIn = async (
  coreEnv: Env,
  role: "admin" | "builder" = "admin"
) => {
  const { session } = await signedInWithRole(idp, role);
  const { core } = await openRpc(session, { coreEnv });
  return await core.authenticate().models.settings();
};

describe("model settings", { timeout: 60_000 }, () => {
  it("show admins the organization's models, the rules, and the spend against each budget (this month's, a run lineage's whole life), most first, with names", async () => {
    const coreEnv = envWith({
      eu: {
        models: [euModel],
        connections: ["conn-eu"],
      },
      sensitive: { models: [euModel], connections: ["conn-hr"] },
      budgets: {
        deployment: { limit: 100 },
        workflow: { limit: 5, alertAt: 50 },
        user: { limit: 1 },
        run: { limit: 2, alertAt: 90 },
      },
    });
    const builder = await signedInApi(idp, "builder");
    const other = await signedInApi(idp, "builder");
    const [builderName, otherName] = await Promise.all([
      builder.api.whoami(),
      other.api.whoami(),
    ]);
    const app = await appWith(builder, workflowFiles("idle", "  return null;"));
    const run = await builder.api.workflows.start(app, "idle");
    await finished(run.id);
    const appId = appIdSchema.parse(app);
    await fakeProviderFor(
      chosen,
      ...Array.from({ length: 4 }, () => pricedAnswer)
    );
    const { call } = models(coreEnv);
    const work = (userId: string): ModelCall<undefined>["work"] => ({
      authority: {
        subject: { type: "app", appId },
        onBehalfOf: userId,
        mode: "interactive",
        appVersion: 1,
      },
      context: { type: "app", appId },
    });
    const hello = (more: Partial<ModelCall<undefined>>) => ({
      model: anthropic,
      input: "Hello.",
      purpose: "chat.turn",
      trigger: { type: "person", userId: builder.userId } as const,
      work: work(builder.userId),
      ...more,
    });
    // The builder twice, the other builder once, and one workflow step the
    // builder's run makes for them.
    for (const made of [
      hello({}),
      hello({}),
      hello({
        trigger: { type: "person", userId: other.userId },
        work: work(other.userId),
      }),
      hello({
        purpose: "workflow.step",
        trigger: runActorOf({ runId: run.id, app, workflow: "idle" }),
        work: {
          authority: {
            subject: { type: "app", appId },
            onBehalfOf: builder.userId,
            mode: "workflow",
            appVersion: 1,
          },
          context: { type: "run", appId, runId: runIdSchema.parse(run.id) },
        },
      }),
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await expect(outcome(call(made))).resolves.toBe("ok");
    }

    const settings = await settingsIn(coreEnv);
    expect(settings).toStrictEqual({
      models: chosen,
      rules: {
        state: "on",
        eu: {
          models: [euModel],
          deployment: false,
          workflows: [],
          connections: ["conn-eu"],
        },
        sensitive: { models: [euModel], connections: ["conn-hr"] },
        budgets: [
          {
            scope: "deployment",
            limit: 100,
            alertAt: 80,
            spent: [{ of: { type: "deployment" }, amount: 0.018 }],
            more: false,
          },
          {
            scope: "workflow",
            limit: 5,
            alertAt: 50,
            spent: [
              {
                of: {
                  type: "workflow",
                  appId: app,
                  appName: "Invoices",
                  workflowId: "idle",
                  name: "idle",
                },
                amount: 0.0045,
              },
            ],
            more: false,
          },
          {
            scope: "user",
            limit: 1,
            alertAt: 80,
            spent: [
              {
                of: {
                  type: "user",
                  userId: builder.userId,
                  name: builderName.name,
                },
                amount: 0.0135,
              },
              {
                of: {
                  type: "user",
                  userId: other.userId,
                  name: otherName.name,
                },
                amount: 0.0045,
              },
            ],
            more: false,
          },
          {
            scope: "run",
            limit: 2,
            alertAt: 90,
            // Each lineage's whole life, by its root run.
            spent: [
              {
                of: {
                  type: "run",
                  runId: run.id,
                  rootRunId: null,
                  appId: app,
                  appName: "Invoices",
                  workflowId: "idle",
                  workflowName: "idle",
                  startedAt: run.createdAt,
                },
                amount: 0.0045,
              },
            ],
            more: false,
          },
        ],
      },
      month: coreEnv.MODEL_BUDGET_MONTH,
      day: budgetDay(coreEnv),
      // No App has a model binding here (resource-bindings.test.ts lists them).
      bindings: { listed: [], more: false },
    });
  });

  it("say when the rules don't parse, or no model is chosen, and read to admins only", async () => {
    const config = { budgets: { user: { limit: 1 } } };
    await choose(mistral);
    await expect(
      settingsIn(envWith({ budgets: { user: { limit: -1 } } }))
    ).resolves.toMatchObject({
      models: [mistral],
      rules: { state: "invalid" },
    });
    await expect(settingsIn(envWith("{"))).resolves.toMatchObject({
      rules: { state: "invalid" },
    });
    await env.DB.prepare(
      "DELETE FROM org_settings WHERE kind = 'ai_models'"
    ).run();
    await expect(settingsIn(envWith(config))).resolves.toMatchObject({
      models: [],
      rules: { state: "on" },
    });
    await expect(outcome(settingsIn(envWith(config), "builder"))).resolves.toBe(
      "role.forbidden"
    );
  });

  it("offer the organization's chosen models, its default first, to admins and in chat, on a deployment whose MODEL_GATEWAY isn't set", async () => {
    await choose(euModel, anthropic);
    const coreEnv = envWith();
    await expect(settingsIn(coreEnv)).resolves.toMatchObject({
      models: [euModel, anthropic],
      rules: { state: "on", eu: null, sensitive: null, budgets: [] },
    });
    const { session } = await signedInWithRole(idp, "user");
    const { core } = await openRpc(session, { coreEnv });
    await expect(core.authenticate().chats.models()).resolves.toStrictEqual([
      euModel,
      anthropic,
    ]);
  });

  it("tell chat the efforts each chosen model takes, and none for one that doesn't think", async () => {
    const { session } = await signedInWithRole(idp, "user");
    const efforts = async (coreEnv: Env) => {
      const { core } = await openRpc(session, { coreEnv });
      return await core.authenticate().chats.efforts();
    };

    await choose(...chosen, "anthropic/claude-opus-4-8");
    await expect(efforts(envWith())).resolves.toStrictEqual({
      [mistral]: { levels: [], default: null },
      [anthropic]: { levels: ["low", "medium", "high"], default: "medium" },
      [euModel]: {
        levels: ["low", "medium", "high", "xhigh"],
        default: "medium",
      },
      "anthropic/claude-opus-4-8": {
        levels: ["low", "medium", "high", "xhigh", "max"],
        default: "medium",
      },
    });
    // Mistral Small has no medium, so a question that names no effort
    // gets the next level up.
    await choose("mistral/mistral-small-latest");
    await expect(efforts(envWith())).resolves.toStrictEqual({
      "mistral/mistral-small-latest": { levels: ["high"], default: "high" },
    });
  });

  it("give every role the organization's default model, or the first of its fallbacks the rules let it use, and none until it chose one", async () => {
    await choose(anthropic, euModel);
    const coreEnv = envWith();
    const { session } = await signedInWithRole(idp, "user");
    const { core } = await openRpc(session, { coreEnv });
    const [chat] = await core.authenticate().chats.models();
    const rolesWith = async (config?: unknown) =>
      roleIn(await modelSettings(envWith(config)));

    const roles = {
      chat,
      ...(await rolesWith()),
      // Sensitive data only the fallback may take.
      sensitive: await rolesWith({
        sensitive: { models: [euModel], connections: [] },
      }),
      // Kept in the EU, where neither is hosted.
      none: await rolesWith({ eu: { deployment: true, models: [mistral] } }),
    };
    await env.DB.prepare(
      "DELETE FROM org_settings WHERE kind = 'ai_models'"
    ).run();
    const unchosen = await outcome(rolesWith());

    expect({ ...roles, unchosen }).toStrictEqual({
      chat: anthropic,
      quick: anthropic,
      careful: anthropic,
      sensitive: { quick: euModel, careful: euModel },
      none: { quick: undefined, careful: undefined },
      unchosen: "model.no_provider",
    });
  });

  it("list the most who spent, most first and ties by key, say more spent, and name nobody who's gone", async () => {
    const coreEnv = envWith({
      budgets: { workflow: { limit: 5 }, user: { limit: 1 } },
    });
    const period = coreEnv.MODEL_BUDGET_MONTH;
    if (period === undefined) {
      throw new Error("Each test counts in a month of its own");
    }
    // Spend already counted for people and an App no longer here: one more
    // person than are listed, the two who spent most tied.
    const people = Array.from({ length: modelSpendListed + 1 }, (_, index) => ({
      key: `gone-${String(index).padStart(3, "0")}`,
      micros: index < 2 ? 900_000 : 1000 + index,
    }));
    // Each charged through the ledger: a micro a token.
    const ledger = modelLedger(env);
    const spend = async (scope: LedgerScope, micros: number) => {
      const id = crypto.randomUUID();
      await ledger.admit({
        id,
        period,
        scopes: [scope],
        model: mistral,
        price: {
          version: "test",
          input: 1_000_000,
          output: 1_000_000,
          cacheRead: 0,
          cacheWrite: 0,
        },
        reservedMicros: micros,
        actor: { type: "person", userId: "someone" },
        deadline: Date.now() + 60_000,
        reconcileAt: Date.now() + 60_000,
        fair: roomyFair(),
      });
      await ledger.settle(id, {
        by: "usage",
        tokens: { input: micros, output: 0, cacheRead: 0, cacheWrite: 0 },
      });
    };
    await Promise.all([
      ...people.map(async ({ key, micros }) => {
        await spend(counted("user", key), micros);
      }),
      spend(counted("workflow", JSON.stringify(["gone-app", "digest"])), 5000),
    ]);

    const settings = await settingsIn(coreEnv);
    if (settings.rules.state !== "on") {
      throw new Error(`Expected the rules on, got ${settings.rules.state}`);
    }
    const [workflow, user] = settings.rules.budgets;
    expect(workflow).toStrictEqual({
      scope: "workflow",
      limit: 5,
      alertAt: 80,
      spent: [
        {
          of: {
            type: "workflow",
            appId: "gone-app",
            appName: null,
            workflowId: "digest",
            name: "digest",
          },
          amount: 0.005,
        },
      ],
      more: false,
    });
    expect(user?.more).toBeTruthy();
    // Most first; the tie goes by key, descending; the least is left out.
    expect(user?.spent.map(({ of }) => of)).toStrictEqual(
      [
        "gone-001",
        "gone-000",
        ...people
          .slice(2)
          .map(({ key }) => key)
          .toReversed()
          .slice(0, modelSpendListed - 2),
      ].map((userId) => ({ type: "user", userId, name: null }))
    );
    expect(user?.spent[0]?.amount).toBe(0.9);
  });

  it("show admins this month's spend with no budget set: the total, and the workflows that spent most with their runs, and nobody else", async () => {
    // The month it is: workflow runs are counted in it.
    const coreEnv: Env = {
      ...env,
      MODEL_GATEWAY: undefined,
      MODEL_BUDGET_MONTH: undefined,
    };
    const builder = await signedInApi(idp, "builder");
    const app = await appWith(builder, workflowFiles("idle", "  return null;"));
    const appId = appIdSchema.parse(app);
    const runs = [
      await builder.api.workflows.start(app, "idle"),
      await builder.api.workflows.start(app, "idle"),
    ];
    await Promise.all(
      runs.map(async ({ id }) => {
        await finished(id);
      })
    );
    await fakeProviderFor(
      [anthropic],
      ...Array.from({ length: 3 }, () => pricedAnswer)
    );
    const { call } = models(coreEnv);
    const step = (runId: string): ModelCall<undefined> => ({
      model: anthropic,
      input: "Hello.",
      purpose: "workflow.step",
      trigger: runActorOf({ runId, app, workflow: "idle" }),
      work: {
        authority: {
          subject: { type: "app", appId },
          onBehalfOf: builder.userId,
          mode: "workflow",
          appVersion: 1,
        },
        context: { type: "run", appId, runId: runIdSchema.parse(runId) },
      },
    });
    for (const made of [
      step(runs[0]?.id ?? ""),
      step(runs[1]?.id ?? ""),
      {
        ...step(runs[0]?.id ?? ""),
        purpose: "chat.turn",
        trigger: { type: "person", userId: builder.userId } as const,
        work: {
          authority: {
            subject: { type: "app", appId },
            onBehalfOf: builder.userId,
            mode: "interactive",
            appVersion: 1,
          },
          context: { type: "app", appId },
        },
      } satisfies ModelCall<undefined>,
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await expect(outcome(call(made))).resolves.toBe("ok");
    }
    // Workflows of an App no longer here, as many as are listed, each
    // spending less: the least is left out.
    const month = new Date().toISOString().slice(0, "yyyy-mm".length);
    const ledger = modelLedger(coreEnv);
    await Promise.all(
      Array.from({ length: modelSpendListed }, async (_, index) => {
        const id = crypto.randomUUID();
        await ledger.admit({
          id,
          period: month,
          scopes: [
            counted("workflow", JSON.stringify(["gone-app", `w${index}`])),
          ],
          model: anthropic,
          price: {
            version: "test",
            input: 1_000_000,
            output: 1_000_000,
            cacheRead: 0,
            cacheWrite: 0,
          },
          reservedMicros: 1000 + index,
          actor: { type: "person", userId: "someone" },
          deadline: Date.now() + 60_000,
          reconcileAt: Date.now() + 60_000,
          fair: roomyFair(),
        });
        await ledger.settle(id, {
          by: "usage",
          tokens: {
            input: 1000 + index,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
        });
      })
    );

    const { session } = await signedInWithRole(idp, "admin");
    const { core } = await openRpc(session, { coreEnv });
    const spend = await core.authenticate().models.spend();
    expect(spend.workflows).toHaveLength(modelSpendListed);
    // The three calls: the gone App's spend never counted for the deployment.
    expect({ ...spend, workflows: spend.workflows.slice(0, 2) }).toStrictEqual({
      month,
      total: 0.0135,
      workflows: [
        {
          appId,
          appName: "Invoices",
          workflowId: "idle",
          name: "idle",
          amount: 0.009,
          runs: 2,
        },
        {
          appId: "gone-app",
          appName: null,
          workflowId: `w${modelSpendListed - 1}`,
          name: `w${modelSpendListed - 1}`,
          amount: (1000 + modelSpendListed - 1) / 1_000_000,
          runs: 0,
        },
      ],
      more: true,
    });

    const { session: builderSession } = await signedInWithRole(idp, "builder");
    const { core: builderCore } = await openRpc(builderSession, { coreEnv });
    await expect(
      outcome(builderCore.authenticate().models.spend())
    ).resolves.toBe("role.forbidden");
  });

  it("read to Grasp staff too, through the admin role their access gives", async () => {
    await choose(mistral);
    const coreEnv = envWith();
    const session = await signedIn(idp, "grasp-staff", staffPerson());
    const { core } = await openRpc(session, { coreEnv });
    const staff = core.authenticate();
    await expect(staff.whoami()).resolves.toMatchObject({ staff: true });
    await expect(staff.models.settings()).resolves.toMatchObject({
      models: [mistral],
      rules: { state: "on", budgets: [] },
    });
  });
});
