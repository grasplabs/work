import { runActorOf } from "@grasp-os/shared/audit";
import { defaultGatewayModels } from "@grasp-os/shared/deployment-config";
import { appIdSchema, runIdSchema } from "@grasp-os/shared/ids";
import { modelSpendListed } from "@grasp-os/shared/models";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { budgetDay } from "../src/model-budgets.ts";
import { modelLedger } from "../src/model-ledger.ts";
import type { LedgerScope } from "../src/model-ledger.ts";
import { models } from "../src/models.ts";
import type { ModelCall, ModelsEnv } from "../src/models.ts";
import { fakeGateway } from "./ai-gateway.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
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

// Admins read the model gateway's settings: the allowlist, the client's
// rules, and this month's spend against each budget, which real model
// calls add to. AI Gateway is the outside system: a fake behind the AI
// binding.

const idp = mockIdp();

const workersAi = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const anthropic = "anthropic/claude-sonnet-4-5";
const euModel = "openai/gpt-5.4";
const allowed = [workersAi, anthropic, euModel];

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

/** Core's env with `config` as the gateway's, counting in its own month. */
const envWith = (config?: unknown) => {
  const coreEnv: ModelsEnv & Env = {
    ...env,
    MODEL_GATEWAY: config,
    MODEL_BUDGET_MONTH: newMonth(),
  };
  return coreEnv;
};

/** A scope the ledger counts spend in, with no budget. */
const counted = (scope: "user" | "workflow", key: string): LedgerScope => ({
  scope,
  key,
  limitMicros: null,
  alertMicros: null,
  names: {},
});

/** Values in order, as their JSON sorts. */
const byJson = (one: unknown, other: unknown): number =>
  JSON.stringify(one).localeCompare(JSON.stringify(other));

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
  it("show admins the allowlist, the rules, and the spend against each budget (this month's, a run lineage's whole life), most first, with names", async () => {
    const coreEnv = envWith({
      gateway: "grasp-os-test",
      models: allowed,
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
    const fake = fakeGateway(...Array.from({ length: 4 }, () => pricedAnswer));
    const { call } = models({ ...coreEnv, AI: fake.binding });
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
      models: allowed,
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
                  appId: app,
                  appName: "Invoices",
                  workflowId: "idle",
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
      // Nothing held for review: this file's first test.
      held: [],
      // No App has a model binding here (resource-bindings.test.ts lists them).
      bindings: { listed: [], more: false },
    });
  });

  it("say when the rules don't parse, or models aren't set up, and read to admins only", async () => {
    const config = {
      gateway: "grasp-os-test",
      models: [workersAi],
      budgets: { user: { limit: 1 } },
    };
    await expect(
      settingsIn(envWith({ ...config, budgets: { user: { limit: -1 } } }))
    ).resolves.toMatchObject({
      models: [workersAi],
      rules: { state: "invalid" },
    });
    // A config that doesn't parse allows nothing: calls fail closed.
    await expect(settingsIn(envWith("{"))).resolves.toMatchObject({
      models: [],
    });
    await expect(outcome(settingsIn(envWith(config), "builder"))).resolves.toBe(
      "role.forbidden"
    );
  });

  it("offer the default models on a deployment whose MODEL_GATEWAY isn't set, to admins and in chat", async () => {
    const coreEnv = envWith();
    await expect(settingsIn(coreEnv)).resolves.toMatchObject({
      models: [...defaultGatewayModels],
    });
    const { session } = await signedInWithRole(idp, "user");
    const { core } = await openRpc(session, { coreEnv });
    await expect(core.authenticate().chats.models()).resolves.toStrictEqual([
      ...defaultGatewayModels,
    ]);
  });

  it("tell chat the efforts each allowed model takes, and none for one that doesn't think", async () => {
    const { session } = await signedInWithRole(idp, "user");
    const efforts = async (coreEnv: Env) => {
      const { core } = await openRpc(session, { coreEnv });
      return await core.authenticate().chats.efforts();
    };

    await expect(
      efforts(
        envWith({
          gateway: "grasp-os-test",
          models: [...allowed, "anthropic/claude-opus-4-8"],
        })
      )
    ).resolves.toStrictEqual({
      [workersAi]: { levels: [], default: null },
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
    // A new deployment's: GLM-5.3 Flash has no medium, so a question that
    // names no effort gets the next level up.
    await expect(efforts(envWith())).resolves.toStrictEqual({
      [defaultGatewayModels[0]]: { levels: [], default: null },
      [defaultGatewayModels[1]]: {
        levels: ["low", "high", "max"],
        default: "high",
      },
    });
  });

  it("list the most who spent, most first and ties by key, say more spent, and name nobody who's gone", async () => {
    const coreEnv = envWith({
      gateway: "grasp-os-test",
      models: [workersAi],
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
        model: workersAi,
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

  it("show admins the reservations held for review, and let them release or charge each, audited, telling them when one was already decided, and nobody else", async () => {
    const coreEnv = envWith({
      gateway: "grasp-os-test",
      models: [workersAi],
      budgets: { user: { limit: 1 } },
    });
    const period = coreEnv.MODEL_BUDGET_MONTH;
    if (period === undefined) {
      throw new Error("Each test counts in a month of its own");
    }
    const key = `held-${crypto.randomUUID()}`;
    const ledger = modelLedger(env);
    // Two requests whose scopes a release stored otherwise: set aside.
    const ids = [crypto.randomUUID(), crypto.randomUUID()] as const;
    for (const [index, id] of ids.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- one after another
      await ledger.admit({
        id,
        period,
        scopes: [{ ...counted("user", key), limitMicros: 1_000_000 }],
        model: workersAi,
        price: {
          version: "test",
          input: 1_000_000,
          output: 1_000_000,
          cacheRead: 0,
          cacheWrite: 0,
        },
        reservedMicros: 10_000 * (index + 1),
        actor: { type: "person", userId: key },
        deadline: Date.now() + 60_000,
        reconcileAt: Date.now() + 60_000,
      });
    }
    await runInDurableObject(ledger, (_instance, state) => {
      for (const id of ids) {
        state.storage.sql.exec(
          "UPDATE requests SET scopes = 'not JSON' WHERE id = ?",
          id
        );
      }
    });
    await Promise.all(
      ids.map(async (id) => await ledger.settle(id, { by: "refused" }))
    );
    const { session, userId } = await signedInWithRole(idp, "admin");
    const { core } = await openRpc(session, { coreEnv });
    const admin = core.authenticate();
    const builder = await signedInWithRole(idp, "builder");
    const { core: builderCore } = await openRpc(builder.session, { coreEnv });
    const ours = <Held extends { id: string }>(held: readonly Held[]) =>
      held.filter(({ id }) => ids.includes(id));

    const shown = await admin.models.settings();
    const [releasing, charging] = ids;
    await expect(
      outcome(
        builderCore.authenticate().models.resolveHeld(releasing, "release")
      )
    ).resolves.toBe("role.forbidden");
    const before = Date.now();
    const decided = [
      await admin.models.resolveHeld(releasing, "release"),
      await admin.models.resolveHeld(charging, "charge"),
    ];
    // Someone else's decision came first: this one changes nothing.
    const again = await admin.models.resolveHeld(charging, "release");
    await runDurableObjectAlarm(ledger);
    const events = await allEvents();
    const spentNow = await ledger.spendOf(period, ["user"], 1000);

    expect({
      shown: ours(shown.held)
        .map(({ id, amount, model, releaseOnly }) => [
          id,
          amount,
          model,
          releaseOnly,
        ])
        .toSorted(byJson),
      decided,
      again: {
        ...again,
        decidedAt:
          "decidedAt" in again &&
          Date.parse(again.decidedAt) >= before &&
          Date.parse(again.decidedAt) <= Date.now(),
      },
      after: ours(await admin.models.held()),
      spent: spentNow.user?.find((row) => row.key === key),
      audited: events
        .filter(
          ({ actor, detail }) =>
            JSON.stringify(actor) ===
              JSON.stringify({ type: "person", userId }) &&
            ids.includes(String(detail.request))
        )
        .map(({ action, detail }) => [action, detail.request])
        .toSorted(byJson),
    }).toStrictEqual({
      shown: [
        [releasing, 0.01, workersAi, false],
        [charging, 0.02, workersAi, false],
      ].toSorted(byJson),
      decided: [
        { state: "decided", how: "release", amount: 0 },
        { state: "decided", how: "charge", amount: 0.02 },
      ],
      again: {
        state: "already_decided",
        how: "charge",
        amount: 0.02,
        decidedAt: true,
      },
      after: [],
      spent: { key, spentMicros: 20_000, reservedMicros: 0 },
      audited: [
        ["model.spend.charged", charging],
        ["model.spend.released", releasing],
      ].toSorted(byJson),
    });
  });

  it("show admins which held reservations can only be released, as their budget record is damaged, and refuse to charge one", async () => {
    const coreEnv = envWith({
      gateway: "grasp-os-test",
      models: [workersAi],
      budgets: { user: { limit: 1 } },
    });
    const period = coreEnv.MODEL_BUDGET_MONTH;
    if (period === undefined) {
      throw new Error("Each test counts in a month of its own");
    }
    const key = `damaged-${crypto.randomUUID()}`;
    const ledger = modelLedger(env);
    const id = crypto.randomUUID();
    await ledger.admit({
      id,
      period,
      scopes: [{ ...counted("user", key), limitMicros: 1_000_000 }],
      model: workersAi,
      price: {
        version: "test",
        input: 1_000_000,
        output: 1_000_000,
        cacheRead: 0,
        cacheWrite: 0,
      },
      reservedMicros: 10_000,
      actor: { type: "person", userId: key },
      deadline: Date.now() + 60_000,
      reconcileAt: Date.now() + 60_000,
    });
    // Set aside, and its person's spend gone with it.
    await runInDurableObject(ledger, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE requests SET scopes = 'not JSON' WHERE id = ?",
        id
      );
      state.storage.sql.exec("DELETE FROM spend WHERE key = ?", key);
    });
    await ledger.settle(id, { by: "refused" });
    const { session } = await signedInWithRole(idp, "admin");
    const { core } = await openRpc(session, { coreEnv });
    const admin = core.authenticate();

    const listed = await admin.models.held();
    const charged = await admin.models.resolveHeld(id, "charge");
    const released = await admin.models.resolveHeld(id, "release");

    expect({
      listed: listed
        .filter((held) => held.id === id)
        .map(({ releaseOnly }) => releaseOnly),
      charged,
      released,
    }).toStrictEqual({
      listed: [true],
      charged: { state: "release_only" },
      released: { state: "decided", how: "release", amount: 0 },
    });
  });

  it("show admins this month's spend with no budget set: the total, and the workflows that spent most with their runs, and nobody else", async () => {
    // The month it is: workflow runs are counted in it.
    const coreEnv: ModelsEnv & Env = {
      ...env,
      MODEL_GATEWAY: { gateway: "grasp-os-test", models: [anthropic] },
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
    const fake = fakeGateway(...Array.from({ length: 3 }, () => pricedAnswer));
    const { call } = models({ ...coreEnv, AI: fake.binding });
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
    const ledger = modelLedger(env);
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
          amount: 0.009,
          runs: 2,
        },
        {
          appId: "gone-app",
          appName: null,
          workflowId: `w${modelSpendListed - 1}`,
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
    const coreEnv = envWith({ gateway: "grasp-os-test", models: [workersAi] });
    const session = await signedIn(idp, "grasp-staff", staffPerson());
    const { core } = await openRpc(session, { coreEnv });
    const staff = core.authenticate();
    await expect(staff.whoami()).resolves.toMatchObject({ staff: true });
    await expect(staff.models.settings()).resolves.toMatchObject({
      models: [workersAi],
      rules: { state: "on", budgets: [] },
    });
  });
});
