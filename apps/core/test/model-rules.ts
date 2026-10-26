import type { AiBinding } from "@earendil-works/pi-ai/api/cloudflare-ai-binding";
import { runActorOf } from "@grasp-os/shared/audit";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { appIdSchema } from "@grasp-os/shared/ids";
import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, vi } from "vite-plus/test";

import { modelLedger } from "../src/model-ledger.ts";
import { models } from "../src/models.ts";
import type { ModelCall, ModelsEnv } from "../src/models.ts";
import { fakeGateway } from "./ai-gateway.ts";
import type { GatewayReply } from "./ai-gateway.ts";
import { verifiedCandidate } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import type { Idp } from "./idp.ts";
import { outcome, signedInApi } from "./sign-in.ts";
import {
  appWith as serverAppWith,
  modelRegistration,
} from "./workflow-apps.ts";

// What the tests of the client's rules for model calls share
// (model-rules.test.ts, model-rules-budgets.test.ts): the rules as a test
// sets them, calls that meet them, and what the audit log says of each.
// AI Gateway is the outside system: a fake behind the AI binding.

/**
 * A new App with the sample server and `files`, declaring the model
 * resources its workflows' AI steps go through, which a test binds.
 */
export const appWith = async (
  builder: Parameters<typeof serverAppWith>[0],
  files: Record<string, string>
): Promise<string> =>
  await serverAppWith(builder, {
    ...modelRegistration({ reader: 32_768, anywhere: 6000, eu: 32_768 }),
    ...files,
  });

/** An AI step reading a total through the App's `reader`, with `retries`. */
export const llm = (retries: string) => `  return await step.llm("extract", {
    description: "Read the total",
    binding: "reader",
    instructions: "Read the total in cents.",
    input: "Total 12.34 EUR",
    schema: z.object({ total: z.int() }),
    ${retries}
  });`;

/**
 * Commits `files` over App `app` and makes them current behind
 * activation's back, as no API does: activation seals the release, then
 * refuses AI steps through models it doesn't declare. What activation
 * said, for the run-time gate to be tested past it.
 */
export const currentPastActivation = async (
  builder: Awaited<ReturnType<typeof signedInApi>>,
  app: string,
  files: Record<string, string>
): Promise<string> => {
  const { version } = await builder.api.apps.files.commit(app, files, "Past");
  const activation = await outcome(
    builder.api.apps.versions.setCurrent(app, version)
  );
  await verifiedCandidate(app, version);
  await env.DB.prepare("UPDATE apps SET current_version = ? WHERE id = ?")
    .bind(version, app)
    .run();
  return activation;
};

export const workersAi = "workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const anthropic = "anthropic/claude-sonnet-4-5";
/** Hosted in the EU, as the tests' config says: its provider's EU region. */
export const euModel = "openai/gpt-5.4";

export const gateway = "grasp-os-test";
export const allowed = [workersAi, anthropic, euModel];

/** An answer that costs next to nothing. */
export const cheapAnswer = { text: "Hi.", inputTokens: 10, outputTokens: 5 };

let monthsUsed = 0;

/**
 * A month no other test counts budgets in, so none depends on the real
 * month or another test's spend.
 */
const newMonth = (): string => {
  monthsUsed += 1;
  const year = 2100 + Math.floor(monthsUsed / 12);
  return `${year}-${String((monthsUsed % 12) + 1).padStart(2, "0")}`;
};

/**
 * Core's env with the fake gateway answering up to eight calls with
 * `answer`, and the rules `config` adds; budgets count in `month`.
 */
export const withRules = (
  config: Record<string, unknown>,
  answer: GatewayReply = cheapAnswer,
  month = newMonth()
) => {
  const fake = fakeGateway(...Array.from({ length: 8 }, () => answer));
  const rulesEnv: ModelsEnv = {
    ...env,
    AI: fake.binding,
    MODEL_GATEWAY: { gateway, models: allowed, ...config },
    MODEL_BUDGET_MONTH: month,
  };
  const { call, agent } = models(rulesEnv);
  return { fake, call, agent };
};

/** A person no other test uses, so their audit events are this test's. */
const newPerson = () =>
  ({ type: "person", userId: `person-${crypto.randomUUID()}` }) as const;

/**
 * What `run` returns, with `config` as the deployment's gateway config for
 * the workflow runs it starts, and the fake gateway answering with
 * `replies`.
 */
export const withDeploymentRules = async <Result>(
  config: unknown,
  replies: GatewayReply[],
  run: () => Promise<Result>
) => {
  const { MODEL_GATEWAY: before, MODEL_BUDGET_MONTH: month } = env;
  const fake = fakeGateway(...replies);
  const ai: AiBinding = env.AI;
  const sending = vi.spyOn(ai, "fetch").mockImplementation(fake.binding.fetch);
  try {
    env.MODEL_GATEWAY = config;
    env.MODEL_BUDGET_MONTH = newMonth();
    return { fake, result: await run() };
  } finally {
    env.MODEL_GATEWAY = before;
    env.MODEL_BUDGET_MONTH = month;
    sending.mockRestore();
  }
};

/** The model gateway's actions among `events`, in order. */
export const modelActions = (events: AuditEvent[]): string[] =>
  events
    .map(({ action }) => action)
    .filter((action) => action.startsWith("model."));

/** A run of `workflow` in `app` no other test uses. */
export const runOf = (app: string, workflow: string) =>
  runActorOf({ runId: `run-${crypto.randomUUID()}`, app, workflow });

/**
 * The audit events `actor` triggered, the model ledger's alerts included:
 * its alarm delivers what its outbox holds.
 */
export const eventsOf = async (actor: unknown): Promise<AuditEvent[]> => {
  await runDurableObjectAlarm(modelLedger(env));
  const events = await allEvents();
  return events.filter(
    (event) => JSON.stringify(event.actor) === JSON.stringify(actor)
  );
};
/**
 * Where the calls of the `describe` it is called in work unless a test
 * says otherwise: an App of their own, never restricted, made before the
 * first test (once `idp` is up) and kept for the rest. What it returns
 * makes a call there of `model`, with `more` over it.
 */
export const callsInAnApp = (idp: Idp) => {
  let appWork: ModelCall<undefined>["work"] | undefined;

  const requireWork = (): ModelCall<undefined>["work"] => {
    if (appWork === undefined) {
      throw new Error("The tests' App isn't made yet");
    }
    return appWork;
  };

  beforeEach(async () => {
    if (appWork !== undefined) {
      return;
    }
    const builder = await signedInApi(idp, "builder");
    const { id } = await builder.api.apps.create({ name: "Model rules" });
    const appId = appIdSchema.parse(id);
    appWork = {
      authority: {
        subject: { type: "app", appId },
        onBehalfOf: builder.userId,
        mode: "interactive",
        appVersion: 1,
      },
      context: { type: "app", appId },
    };
  });

  return (
    model: string,
    more: Partial<ModelCall<undefined>> = {}
  ): ModelCall<undefined> => ({
    model,
    input: "Hello.",
    purpose: "chat.turn",
    trigger: newPerson(),
    work: requireWork(),
    ...more,
  });
};
