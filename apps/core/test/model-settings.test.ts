import { runActorOf } from "@grasp-os/shared/audit";
import { appIdSchema, runIdSchema } from "@grasp-os/shared/ids";
import { modelSpendListed } from "@grasp-os/shared/models";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

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
// chose, and this month's spend, which real model calls add to. The provider behind connect is the
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

/** The model each role gets. */
const roleIn = (settings: ModelsNow) => ({
  quick: modelForRole(settings, "quick"),
  careful: modelForRole(settings, "careful"),
});

/** Core's env, counting in its own month. */
const envWith = () => {
  const coreEnv: Env = { ...env, MODEL_BUDGET_MONTH: newMonth() };
  return coreEnv;
};

/** Chooses `refs` with a key no other test uses (`connectModels`). */
const choose = async (...refs: string[]): Promise<void> => {
  await connectModels(`test-model-key-${crypto.randomUUID()}`, refs);
};

/** A scope the ledger counts spend in. */
const counted = (scope: "user" | "workflow", key: string): LedgerScope => ({
  scope,
  key,
});

/** Shares of the requests in flight roomy enough that none fills here. */
const roomyFair = () => ({
  subject: "spend-settings",
  shares: { client: 1000, person: 1000 },
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
  it("show admins the organization's models and this month, say when no model is chosen, and read to admins only", async () => {
    await choose(mistral);
    const coreEnv = envWith();
    await expect(settingsIn(coreEnv)).resolves.toStrictEqual({
      models: [mistral],
      month: coreEnv.MODEL_BUDGET_MONTH,
      // No App has a model binding here (resource-bindings.test.ts lists them).
      bindings: { listed: [], more: false },
    });
    await env.DB.prepare(
      "DELETE FROM org_settings WHERE kind = 'ai_models'"
    ).run();
    await expect(settingsIn(envWith())).resolves.toMatchObject({ models: [] });
    await expect(outcome(settingsIn(envWith(), "builder"))).resolves.toBe(
      "role.forbidden"
    );
  });

  it("offer the organization's chosen models, its default first, to admins and in chat", async () => {
    await choose(euModel, anthropic);
    const coreEnv = envWith();
    await expect(settingsIn(coreEnv)).resolves.toMatchObject({
      models: [euModel, anthropic],
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

  it("give every role the organization's default model, and none until it chose one", async () => {
    await choose(anthropic, euModel);
    const coreEnv = envWith();
    const { session } = await signedInWithRole(idp, "user");
    const { core } = await openRpc(session, { coreEnv });
    const [chat] = await core.authenticate().chats.models();
    const rolesWith = async () => roleIn(await modelSettings(envWith()));

    const roles = { chat, ...(await rolesWith()) };
    await env.DB.prepare(
      "DELETE FROM org_settings WHERE kind = 'ai_models'"
    ).run();
    const unchosen = await outcome(rolesWith());

    expect({ ...roles, unchosen }).toStrictEqual({
      chat: anthropic,
      quick: anthropic,
      careful: anthropic,
      unchosen: "model.no_provider",
    });
  });

  it("show admins this month's spend: the total, and the workflows that spent most with their runs, and nobody else", async () => {
    // The month it is: workflow runs are counted in it.
    const coreEnv: Env = { ...env, MODEL_BUDGET_MONTH: undefined };
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
    });
  });
});
