import { errorFields, log } from "@grasp-os/shared/log";

import { clock } from "./clock.ts";
import { handleRequest } from "./entry.ts";
import { receiveEmail } from "./workflows/inbound-email.ts";

export { App } from "./app.ts";
export { Clock } from "./clock.ts";
export { AuditLog } from "./audit-log.ts";
export { ChatApi } from "./agent-apis.ts";
export { AppsApi } from "./agent-apps.ts";
export { BuildApi } from "./agent-builds.ts";
export { ConnectionsApi } from "./agent-connections.ts";
export { BrainAgentApi } from "./agent-brain.ts";
export { DashboardApi } from "./agent-dashboard.ts";
export { KnowledgeApi } from "./agent-knowledge.ts";
export { MemoryApi } from "./agent-memory.ts";
export { WorkflowsApi } from "./agent-workflows.ts";
export { Builtins } from "./builtins.ts";
export { Onboarding } from "./onboarding/store.ts";
export { ModelLedger } from "./model-ledger.ts";
export { DataStore } from "./data-store.ts";
export { AppTail } from "./server-logs.ts";
export { AppConnectionBinding } from "./app-bindings.ts";
export { AppExportBinding } from "./app-calls.ts";
export { AppStatisticsBinding } from "./statistics-binding.ts";
export { AppGuestsBinding } from "./guests-binding.ts";
export { ConnectionBinding } from "./bindings.ts";
export { AppCollectionBinding } from "./knowledge/app-binding.ts";
export { CollectionBinding } from "./knowledge/binding.ts";
export { KnowledgeBinding } from "./knowledge/tools-binding.ts";
export { ActionInvocation } from "./action-invocation.ts";
export { ChatState } from "@grasp-os/chat/state";
export { WorkflowRuns } from "./workflows/run-object.ts";
export { Workspace } from "./workspace.ts";

/** Arms the clock if nothing has, logging a failure by its kind only. */
const armClock = async (env: Env): Promise<void> => {
  try {
    await clock(env).ensure();
  } catch (error) {
    log.error("clock.ensure_failed", errorFields(error));
  }
};

export default {
  fetch: handleRequest,
  // Mail Email Routing sends to workflows' email triggers (see
  // src/workflows/inbound-email.ts).
  email: async (message, env, ctx) => {
    // Mail may be all a quiet deployment gets: each message arms the clock
    // if nothing has (src/clock.ts), in the background. A failure is
    // logged; the next message, request or probe tries again.
    ctx.waitUntil(armClock(env));
    await receiveEmail(message, env);
  },
  // No `scheduled`: core's maintenance runs on the client's clock, its own
  // alarm (src/clock.ts), since a Workers for Platforms user Worker can't
  // have a clock.
} satisfies ExportedHandler<Env>;
