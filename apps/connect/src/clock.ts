import { errorFields, log } from "@grasp-os/shared/log";
import { ClockObject } from "@grasp-os/workerflow/clock";
import type { ClockReport, ClockTask } from "@grasp-os/workerflow/clock";

import { resealAiProviderKeys } from "./ai-providers.ts";
import {
  purgeExpiredToolkitFlows,
  reconcileUnsyncedTools,
  retryComposioCleanups,
} from "./composio-connections.ts";
import { purgeExpiredFlows, resealFlows } from "./oauth.ts";
import { expireHeldActions } from "./pending.ts";
import { retryRevocations } from "./revocations.ts";
import { resealTokens } from "./tokens.ts";

// The client's clock for connect (spec 43.5, @grasp-os/workerflow/clock):
// connect's cleanup and rotation tasks, each run once a minute with its own
// durable state, on the clock's alarm. Connect has no cron: a Workers for
// Platforms user Worker can't. Core's clock arms this one every minute, if
// nothing has (core's src/clock.ts).

/** Every task connect's clock runs. */
export const clockTasks: readonly ClockTask<Env>[] = [
  // OAuth and Composio flows nobody finished.
  { name: "oauth.flows", period: "minute", run: purgeExpiredFlows },
  {
    name: "composio.flows",
    period: "minute",
    run: purgeExpiredToolkitFlows,
  },
  // Deletions at Composio earlier tries couldn't make.
  {
    name: "composio.cleanups",
    period: "minute",
    run: retryComposioCleanups,
  },
  // Revokes at a provider a disconnect couldn't make (src/revocations.ts).
  { name: "oauth.revocations", period: "minute", run: retryRevocations },
  // Composio's tools brought to connect's, where a change's reconcile
  // didn't finish.
  {
    name: "composio.tools",
    period: "minute",
    run: reconcileUnsyncedTools,
  },
  // Held writes from a chat platform whose company's day is over.
  { name: "held.ended", period: "minute", run: expireHeldActions },
  // What a rotated key sealed, sealed again.
  { name: "vault.tokens", period: "minute", run: resealTokens },
  { name: "vault.flows", period: "minute", run: resealFlows },
  { name: "vault.ai_keys", period: "minute", run: resealAiProviderKeys },
];

/** How connect logs a task that failed: its name and the error, nothing it worked on. */
export const report: ClockReport = (event, task, error) => {
  log.error(event, { task, ...errorFields(error) });
};

/** The client's one clock for connect. */
export class Clock extends ClockObject<Env> {
  protected readonly clockTasks = clockTasks;
  protected report = report;
}

/**
 * The namespace to get the clock from, in the EU unless turned off: as
 * core's (core's src/durable-objects.ts), workerd and on-prem pass
 * `DURABLE_OBJECT_JURISDICTION=none`, never set in wrangler.jsonc.
 */
const clockNamespace = (
  env: Pick<Env, "CLOCK" | "DURABLE_OBJECT_JURISDICTION">
): DurableObjectNamespace<Clock> =>
  env.DURABLE_OBJECT_JURISDICTION === "none"
    ? env.CLOCK
    : env.CLOCK.jurisdiction("eu");

/** The client's one clock for connect. */
export const clock = (
  env: Pick<Env, "CLOCK" | "DURABLE_OBJECT_JURISDICTION">
): DurableObjectStub<Clock> => clockNamespace(env).getByName("clock");
