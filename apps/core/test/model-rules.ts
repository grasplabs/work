import type { AuditEvent } from "@grasp-os/shared/audit";
import { appIdSchema } from "@grasp-os/shared/ids";
import { env } from "cloudflare:workers";
import { beforeEach } from "vite-plus/test";

import { models } from "../src/models.ts";
import type { ModelCall } from "../src/models.ts";
import { allEvents } from "./audit-events.ts";
import type { Idp } from "./idp.ts";
import { fakeProviderFor } from "./model-provider.ts";
import type { ProviderReply } from "./model-provider.ts";
import { signedInApi } from "./sign-in.ts";

// What the tests of the client's rules for model calls share
// (model-rules.test.ts): the rules as a test
// sets them, calls that meet them, and what the audit log says of each.
// The model provider behind connect is the outside system
// (test/model-provider.ts).

/** A model that doesn't think: the organization's default in these tests. */
export const mistral = "mistral/mistral-large-latest";
export const anthropic = "anthropic/claude-sonnet-4-5";
/** A third model the organization chose. */
export const euModel = "openai/gpt-5.4";

/** The models the organization chose: its default, then its fallbacks. */
export const chosen = [mistral, anthropic, euModel];

/** An answer that costs next to nothing. */
export const cheapAnswer = { text: "Hi.", inputTokens: 10, outputTokens: 5 };

let monthsUsed = 0;

/**
 * A month no other test counts spend in, so none depends on the real
 * month or another test's spend.
 */
const newMonth = (): string => {
  monthsUsed += 1;
  const year = 2100 + Math.floor(monthsUsed / 12);
  return `${year}-${String((monthsUsed % 12) + 1).padStart(2, "0")}`;
};

/**
 * Core's env with the provider answering up to eight calls with `answer`,
 * for the `chosen` models; spend counts in `month`.
 */
export const withRules = async (
  answer: ProviderReply = cheapAnswer,
  month = newMonth()
) => {
  const fake = await fakeProviderFor(
    chosen,
    ...Array.from({ length: 8 }, () => answer)
  );
  const rulesEnv: Env = {
    ...env,
    MODEL_BUDGET_MONTH: month,
  };
  const { call, agent } = models(rulesEnv);
  return { fake, call, agent };
};

/** A person no other test uses, so their audit events are this test's. */
const newPerson = () =>
  ({ type: "person", userId: `person-${crypto.randomUUID()}` }) as const;

/** The audit events `actor` triggered. */
export const eventsOf = async (actor: unknown): Promise<AuditEvent[]> => {
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
