import { appIdSchema } from "@grasp-os/shared/ids";
import { modelSpendListed } from "@grasp-os/shared/models";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";

import { modelUsage } from "../src/db/core/schema.ts";
import { modelForRole, models, modelSettings } from "../src/models.ts";
import type { ModelCall, ModelsNow } from "../src/models.ts";
import { mockIdp } from "./idp.ts";
import {
  askingTasks,
  askingWorkflow,
  endedRun,
  jsonWorkflowAppsOf,
  startedBy,
} from "./json-workflow-apps.ts";
import { connectModels, fakeProviderFor } from "./model-provider.ts";
import { recordedUsage } from "./model-usage.ts";
import {
  openRpc,
  outcome,
  signedIn,
  signedInWithRole,
  staffPerson,
} from "./sign-in.ts";

// Admins read the model gateway's settings: the models the organization
// chose, and this month's spend, which real model calls add to, a JSON
// workflow's runs' `grasp.model` tasks among them. The provider behind
// connect is the outside system: a fake (test/model-provider.ts).

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
  const coreEnv: Env = { ...env, SPEND_MONTH: newMonth() };
  return coreEnv;
};

/** Chooses `refs` with a key no other test uses (`connectModels`). */
const choose = async (...refs: string[]): Promise<void> => {
  await connectModels(`test-model-key-${crypto.randomUUID()}`, refs);
};

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
      month: coreEnv.SPEND_MONTH,
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
    const coreEnv: Env = { ...env, SPEND_MONTH: undefined };
    const { signedIn: signedInPerson } = jsonWorkflowAppsOf(idp);
    const [admin, builder] = await Promise.all([
      signedInPerson("admin"),
      signedInPerson("builder"),
    ]);
    // Each of an independent workflow's two runs asks Claude in its
    // `grasp.model` task, then a person's chat turn does.
    await fakeProviderFor(
      [anthropic],
      ...Array.from({ length: 2 }, () => ({
        ...pricedAnswer,
        text: '{"line": "Hi."}',
      })),
      pricedAnswer
    );
    const workflow = await askingWorkflow(
      admin,
      builder,
      askingTasks(),
      anthropic
    );
    const runs = [
      await startedBy(builder, workflow.id),
      await startedBy(builder, workflow.id),
    ];
    const ended = await Promise.all(
      runs.map(async (runId) => await endedRun(builder, workflow.id, runId))
    );
    expect(ended.map(({ status }) => status)).toStrictEqual([
      "completed",
      "completed",
    ]);
    // Where a person's chat turn works: an App of theirs.
    const { id: app } = await builder.api.apps.create({ name: "Invoices" });
    const appId = appIdSchema.parse(app);
    const chatTurn: ModelCall<undefined> = {
      model: anthropic,
      input: "Hello.",
      purpose: "chat.turn",
      trigger: { type: "person", userId: builder.userId },
      work: {
        authority: {
          subject: { type: "app", appId },
          onBehalfOf: builder.userId,
          mode: "interactive",
          appVersion: 1,
        },
        context: { type: "app", appId },
      },
    };
    await expect(outcome(models(coreEnv).call(chatTurn))).resolves.toBe("ok");
    // The three calls, recorded after their answers.
    const month = new Date().toISOString().slice(0, "yyyy-mm".length);
    await recordedUsage(month, 3);
    // Workflows of an App no longer here, as many as are listed, each
    // spending less: the least is left out.
    const gone = Array.from({ length: modelSpendListed }, (_, index) => ({
      id: crypto.randomUUID(),
      period: month,
      personId: "someone",
      triggerType: "workflow",
      workflowAppId: "gone-app",
      workflowId: `w${index}`,
      model: anthropic,
      credential: "organization",
      inputTokens: 1000 + index,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: (1000 + index) / 1_000_000,
      estimated: false,
      createdAt: new Date(),
    }));
    // One row a statement: D1 binds at most 100 values.
    await Promise.all(
      gone.map(
        async (row) => await drizzle(env.DB).insert(modelUsage).values(row)
      )
    );
    const goneTotal = gone.reduce((sum, { cost }) => sum + cost, 0);

    const { session } = await signedInWithRole(idp, "admin");
    const { core } = await openRpc(session, { coreEnv });
    const spend = await core.authenticate().models.spend();
    expect(spend.workflows).toHaveLength(modelSpendListed);
    // The three calls, and the gone App's workflows'.
    expect({
      ...spend,
      total: Math.round(spend.total * 1_000_000),
      workflows: spend.workflows.slice(0, 2).map(({ amount, ...listed }) => ({
        ...listed,
        amount: Math.round(amount * 1_000_000),
      })),
    }).toStrictEqual({
      month,
      total: Math.round((0.0135 + goneTotal) * 1_000_000),
      workflows: [
        {
          appId: null,
          appName: null,
          workflowId: workflow.id,
          name: workflow.name,
          amount: 9000,
          runs: 2,
        },
        {
          appId: "gone-app",
          appName: null,
          workflowId: `w${modelSpendListed - 1}`,
          name: `w${modelSpendListed - 1}`,
          amount: 1000 + modelSpendListed - 1,
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

  it("refused to Grasp staff, whatever role their access gives", async () => {
    await choose(mistral);
    const coreEnv = envWith();
    const session = await signedIn(idp, "grasp-staff", staffPerson());
    const { core } = await openRpc(session, { coreEnv });
    const staff = core.authenticate();
    await expect(staff.whoami()).resolves.toMatchObject({
      staff: true,
      role: "admin",
    });
    await expect(outcome(staff.models.settings())).resolves.toBe(
      "role.forbidden"
    );
  });
});
