import type { AuditEvent } from "@grasp-os/shared/audit";
import { appIdSchema } from "@grasp-os/shared/ids";
import type { PersonLimitSubject } from "@grasp-os/shared/models";
import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { models } from "../src/models.ts";
import type { ModelCall, ModelsEnv } from "../src/models.ts";
import { messagesAnHourOf } from "../src/person-limits.ts";
import { fakeGateway } from "./ai-gateway.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { newTeam } from "./knowledge.ts";
import { openRpc, outcome, signedInApi, signedInWithRole } from "./sign-in.ts";

// The limits a company's admins set per person (D8): reserved against by
// the model ledger as one more scope beside Grasp's budgets, never above
// them, and read by the chat door for its messages an hour. Admins set
// them over `/rpc`; model calls go through the real gateway and ledger,
// with AI Gateway as the outside system, a fake behind the AI binding.
// Each test has a ledger of its own, so no limit it sets reaches another
// file's calls.

const idp = mockIdp();

const workersAi = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** Costs $0.029526 from Llama 3.3, at its list prices. */
const dearAnswer = { text: "Hi.", inputTokens: 100_000, outputTokens: 100 };

let monthsUsed = 0;

/** A month no other test counts spend in: from 2500, clear of other files. */
const newMonth = (): string => {
  monthsUsed += 1;
  return `${2500 + Math.floor(monthsUsed / 12)}-${String((monthsUsed % 12) + 1).padStart(2, "0")}`;
};

/**
 * Core's env with Grasp's `budgets`, a fake gateway answering `replies`
 * dear answers, and a model ledger of its own.
 */
const deploymentWith = (budgets: Record<string, unknown>, replies = 0) => {
  const ledger = crypto.randomUUID();
  const fake = fakeGateway(
    ...Array.from({ length: replies }, () => dearAnswer)
  );
  const coreEnv: Env = {
    ...env,
    MODEL_GATEWAY: { gateway: "grasp-os-test", models: [workersAi], budgets },
    MODEL_BUDGET_MONTH: newMonth(),
    MODEL_LEDGER: new Proxy(env.MODEL_LEDGER, {
      get: (namespace, name): unknown =>
        name === "getByName"
          ? () => namespace.getByName(ledger)
          : Reflect.get(namespace, name, namespace),
    }),
  };
  const modelsEnv: ModelsEnv = { ...coreEnv, AI: fake.binding };
  return { coreEnv, ledger, call: models(modelsEnv).call };
};

/** An admin's `ModelsApi` on `coreEnv`, and their user ID. */
const adminOn = async (coreEnv: Env) => {
  const admin = await signedInApi(idp, "admin");
  const { core } = await openRpc(admin.session, { coreEnv });
  return { ...admin, models: core.authenticate().models };
};

/** A capped call to Llama made by `userId` in an App of theirs. */
const helloBy = async (userId: string) => {
  const builder = await signedInApi(idp, "builder");
  const { id } = await builder.api.apps.create({ name: "Person limits" });
  const appId = appIdSchema.parse(id);
  return (): ModelCall<undefined> => ({
    model: workersAi,
    maxTokens: 100,
    input: "Hello.",
    purpose: "chat.turn",
    trigger: { type: "person", userId },
    work: {
      authority: {
        subject: { type: "app", appId },
        onBehalfOf: userId,
        mode: "interactive",
        appVersion: 1,
      },
      context: { type: "app", appId },
    },
  });
};

/** The outcomes of `count` calls, one after another. */
const inTurn = async (
  count: number,
  made: () => Promise<unknown>
): Promise<string[]> => {
  const outcomes: string[] = [];
  for (let at = 0; at < count; at += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one after another, as a person would
    outcomes.push(await outcome(made()));
  }
  return outcomes;
};

/** What a refused call was told: its code, and the cap that refused it. */
const toldBy = async (refused: Promise<unknown>) =>
  z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.object({ because: z.string() }),
    })
    .parse(
      await refused.then(
        () => "admitted",
        (error: unknown) => error
      )
    );

/** The limit changes `ledger` audited, its outbox delivered. */
const limitEvents = async (ledger: string): Promise<AuditEvent[]> => {
  await runDurableObjectAlarm(env.MODEL_LEDGER.getByName(ledger));
  const events = await allEvents();
  return events.filter(({ action }) => action.startsWith("model.limit."));
};

const person = (userId: string): PersonLimitSubject => ({
  type: "person",
  userId,
});

describe("person limits", { timeout: 60_000 }, () => {
  it("hold a person to the monthly limit an admin set for them, and no one else", async () => {
    const { coreEnv, call } = deploymentWith({ user: { limit: 1 } }, 5);
    const { models: admin } = await adminOn(coreEnv);
    const ada = await signedInApi(idp, "user");
    const bea = await signedInApi(idp, "user");
    const [adas, beas] = [await helloBy(ada.userId), await helloBy(bea.userId)];

    const set = await admin.setLimit(person(ada.userId), {
      monthly: 0.05,
      messagesAnHour: null,
    });
    // $0.0295 a call: the second takes Ada past $0.05.
    const outcomes = await inTurn(3, async () => await call(adas()));
    const told = await toldBy(call(adas()));
    const bes = await outcome(call(beas()));
    const listed = await admin.limits();
    const adaListed = listed.people.find(({ userId }) => userId === ada.userId);
    // Raised to Grasp's budget for a person, she goes on.
    await admin.setLimit(person(ada.userId), {
      monthly: 1,
      messagesAnHour: null,
    });
    const raised = await outcome(call(adas()));

    expect({
      set,
      outcomes,
      told,
      bes,
      raised,
      ada: adaListed && {
        from: adaListed.from,
        limit: adaListed.limit,
        spent: adaListed.spent,
      },
    }).toStrictEqual({
      set: { state: "set" },
      outcomes: ["ok", "ok", "model.over_budget"],
      told: {
        code: "model.over_budget",
        message:
          "The monthly model limit your company's admins set for the person this call is made for is used up, so no more model calls can be made for them until it resets at the start of next month (UTC). Ask one of your company's admins to raise it in Settings.",
        details: { because: "person" },
      },
      bes: "ok",
      raised: "ok",
      // Two calls, what her limit counts.
      ada: {
        from: "person",
        limit: { monthly: 0.05, messagesAnHour: null },
        spent: (29_526 * 2) / 1_000_000,
      },
    });
  });

  it("list each exception by its person's name, past the hundred a query can bind", async () => {
    const { coreEnv } = deploymentWith({ user: { limit: 1 } });
    const { models: admin } = await adminOn(coreEnv);
    const people = await Promise.all(
      Array.from(
        { length: 101 },
        async () => await signedInWithRole(idp, "user")
      )
    );
    for (const { userId } of people) {
      // oxlint-disable-next-line no-await-in-loop -- one after another, as an admin would
      await admin.setLimit(person(userId), {
        monthly: 0.5,
        messagesAnHour: null,
      });
    }
    const listed = await admin.limits();
    const named = new Map(
      listed.exceptions.flatMap(({ subject, name }) =>
        subject.type === "person" ? [[subject.userId, name]] : []
      )
    );
    expect(
      people.filter(({ userId }) => typeof named.get(userId) !== "string")
    ).toStrictEqual([]);
  });

  it("never lift a person above Grasp's budgets: a limit above one is refused, and none leaves Grasp's in charge", async () => {
    const { coreEnv, call } = deploymentWith(
      { user: { limit: 0.05 }, deployment: { limit: 10 } },
      3
    );
    const { models: admin } = await adminOn(coreEnv);
    const ada = await signedInApi(idp, "user");
    const team = await newTeam(await signedInApi(idp, "admin"), [ada]);
    const adas = await helloBy(ada.userId);

    const above = await Promise.all([
      admin.setLimit(person(ada.userId), { monthly: 0.06, messagesAnHour: 5 }),
      admin.setLimit(
        { type: "team", teamId: team },
        {
          monthly: 20,
          messagesAnHour: null,
        }
      ),
      admin.setLimit(
        { type: "default" },
        { monthly: 0.051, messagesAnHour: null }
      ),
    ]);
    const afterRefusals = await admin.limits();
    // No limit of her own: Grasp's budget for a person still holds her.
    await admin.setLimit(person(ada.userId), {
      monthly: null,
      messagesAnHour: null,
    });
    const outcomes = await inTurn(3, async () => await call(adas()));
    const deploymentOnly = await adminOn(
      deploymentWith({ deployment: { limit: 0.5 } }).coreEnv
    );

    expect({
      above,
      exceptions: afterRefusals.exceptions,
      ceiling: afterRefusals.ceiling,
      outcomes,
      deploymentOnly: await deploymentOnly.models.setLimit(person(ada.userId), {
        monthly: 0.75,
        messagesAnHour: null,
      }),
    }).toStrictEqual({
      above: [
        { state: "above_budget", ceiling: 0.05 },
        { state: "above_budget", ceiling: 0.05 },
        { state: "above_budget", ceiling: 0.05 },
      ],
      exceptions: [],
      ceiling: 0.05,
      outcomes: ["ok", "ok", "model.over_budget"],
      deploymentOnly: { state: "above_budget", ceiling: 0.5 },
    });
    await expect(toldBy(call(adas()))).resolves.toMatchObject({
      details: { because: "user" },
    });
  });

  it("give the chat door each person's messages an hour: their own, else their teams' most, else the default", async () => {
    const { coreEnv } = deploymentWith({});
    const { models: admin, session } = await adminOn(coreEnv);
    const [ada, bea, cem, dov] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const few = await newTeam({ session }, [bea, cem]);
    const many = await newTeam({ session }, [cem]);
    const before = await messagesAnHourOf(coreEnv, dov.userId);

    for (const [subject, messagesAnHour] of [
      [{ type: "default" }, 20],
      [{ type: "team", teamId: few }, 30],
      [{ type: "team", teamId: many }, 60],
      [person(ada.userId), 5],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one change at a time
      await admin.setLimit(subject, { monthly: 2, messagesAnHour });
    }
    const hourly = await Promise.all(
      [ada, bea, cem, dov].map(
        async ({ userId }) => await messagesAnHourOf(coreEnv, userId)
      )
    );
    const listed = await admin.limits();
    await admin.removeLimit({ type: "default" });
    const removed = await messagesAnHourOf(coreEnv, dov.userId);

    expect({
      before,
      hourly,
      removed,
      default: listed.default,
      people: [ada, bea, cem, dov].map(({ userId }) => {
        const listedAs = listed.people.find((one) => one.userId === userId);
        return listedAs === undefined
          ? undefined
          : {
              userId,
              from: listedAs.from,
              limit: listedAs.limit,
              spent: listedAs.spent,
            };
      }),
    }).toStrictEqual({
      before: null,
      hourly: [5, 30, 60, 20],
      removed: null,
      default: { monthly: 2, messagesAnHour: 20 },
      people: [
        {
          userId: ada.userId,
          from: "person",
          limit: { monthly: 2, messagesAnHour: 5 },
          spent: 0,
        },
        {
          userId: bea.userId,
          from: "team",
          limit: { monthly: 2, messagesAnHour: 30 },
          spent: 0,
        },
        {
          userId: cem.userId,
          from: "team",
          limit: { monthly: 2, messagesAnHour: 60 },
          spent: 0,
        },
        {
          userId: dov.userId,
          from: "default",
          limit: { monthly: 2, messagesAnHour: 20 },
          spent: 0,
        },
      ],
    });

    // The teams an admin may name in an exception, each with its name.
    expect(
      listed.teams.filter(({ teamId }) => teamId === few || teamId === many)
    ).toHaveLength(2);
    expect(listed.teams.every(({ name }) => name.length > 0)).toBeTruthy();
  });

  it("audit every change in the admin's name, with what it replaced, and let only admins make one", async () => {
    const { coreEnv, ledger } = deploymentWith({ user: { limit: 5 } });
    const { models: admin, userId: adminId } = await adminOn(coreEnv);
    const ada = await signedInApi(idp, "user");
    const builder = await signedInApi(idp, "builder");
    const { core } = await openRpc(builder.session, { coreEnv });
    const notAdmin = core.authenticate().models;

    await admin.setLimit(person(ada.userId), {
      monthly: 1,
      messagesAnHour: 10,
    });
    await admin.setLimit(person(ada.userId), {
      monthly: 2,
      messagesAnHour: null,
    });
    // Nine dollars is above Grasp's five: refused, so nothing to audit.
    const above = await admin.setLimit(person(ada.userId), {
      monthly: 9,
      messagesAnHour: 1,
    });
    await admin.removeLimit(person(ada.userId));
    // Removing what isn't there changes nothing, and records nothing.
    await admin.removeLimit(person(ada.userId));
    const refused = await Promise.all([
      outcome(notAdmin.limits()),
      outcome(
        notAdmin.setLimit(person(builder.userId), {
          monthly: null,
          messagesAnHour: null,
        })
      ),
      outcome(notAdmin.removeLimit({ type: "default" })),
    ]);
    const nobody = await admin.setLimit(person(crypto.randomUUID()), {
      monthly: 1,
      messagesAnHour: null,
    });
    const events = await limitEvents(ledger);

    expect({
      above,
      refused,
      nobody,
      events: events
        .filter(({ detail }) => detail.userId === ada.userId)
        .map(({ actor, action, detail }) => ({ actor, action, detail })),
    }).toStrictEqual({
      above: { state: "above_budget", ceiling: 5 },
      refused: ["role.forbidden", "role.forbidden", "role.forbidden"],
      nobody: { state: "not_found" },
      events: [
        {
          actor: { type: "person", userId: adminId },
          action: "model.limit.set",
          detail: {
            subject: "person",
            userId: ada.userId,
            monthly: 1,
            messagesAnHour: 10,
            "before.monthly": null,
            "before.messagesAnHour": null,
            "before.set": false,
          },
        },
        {
          actor: { type: "person", userId: adminId },
          action: "model.limit.set",
          detail: {
            subject: "person",
            userId: ada.userId,
            monthly: 2,
            messagesAnHour: null,
            "before.monthly": 1,
            "before.messagesAnHour": 10,
            "before.set": true,
          },
        },
        {
          actor: { type: "person", userId: adminId },
          action: "model.limit.removed",
          detail: {
            subject: "person",
            userId: ada.userId,
            "before.monthly": 2,
            "before.messagesAnHour": null,
          },
        },
      ],
    });
  });
});
