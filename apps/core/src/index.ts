import { errorFields, log } from "@grasp-os/shared/log";

import { tickClock } from "./clock.ts";
import { handleRequest } from "./entry.ts";
import { receiveEmail } from "./workflows/inbound-email.ts";

/** The cron trigger that runs every 15 minutes (wrangler.jsonc). */
const quarterHourCron = "*/15 * * * *";

export { App } from "./app.ts";
export { Clock } from "./clock.ts";
export { AuditLog } from "./audit-log.ts";
export { ChatApi } from "./agent-apis.ts";
export { AppsApi } from "./agent-apps.ts";
export { BuildApi } from "./agent-builds.ts";
export { ConnectionsApi } from "./agent-connections.ts";
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
export { WorkflowRuns } from "./workflows/run-object.ts";
export {
  PreviewCollection,
  PreviewConnection,
  PreviewExports,
  PreviewGuests,
  PreviewStatistics,
} from "./preview-bindings.ts";
export { Workspace } from "./workspace.ts";

export default {
  fetch: handleRequest,
  // Mail Email Routing sends to workflows' email triggers (see
  // src/workflows/inbound-email.ts).
  email: async (message, env) => {
    await receiveEmail(message, env);
  },
  // Every minute: audit events waiting in core's outboxes and connect's
  // (see src/audit-outbox.ts), personal connections of removed people still
  // connected (see src/members.ts), revocations an App's host couldn't be
  // told of, told again (see src/access-revocations.ts), Apps copied from a blueprint left
  // pending (see src/app-blueprints.ts), uploads left behind
  // (see src/knowledge/uploads.ts), a new version of core, audited as
  // a platform update (see src/platform-updates.ts), and workflows'
  // schedules due by the minute it runs for (see src/workflows/triggers.ts),
  // starts core stopped in the middle of, sent to the engine again (see
  // `repairStarts`, src/workflows/runs.ts, and `repairResourceStarts`,
  // src/workflows/resource-runs.ts), terminations of runs cancelled while
  // starting the engine is still to confirm (`repairResourceTerminations`,
  // the same file), and pauses, resumes and
  // cancels the engine is still to confirm (see `repairControls`,
  // src/workflows/controls.ts), wakes owed to runs waiting on a person,
  // sent again (see `repairWakes`, src/workflows/wakes.ts), and connector
  // events:
  // where connect listens, and the events it read, delivered (see
  // src/workflows/connector-events.ts).
  //
  // Every 15 minutes, on a trigger of its own so neither shares an
  // invocation with the jobs above: the day's improvement signals and
  // Knowledge usage signals, until they're computed, from one pass over the audit log (see
  // src/daily-signals.ts), and Apps whose entry in the Apps
  // collection isn't of their current version (see
  // src/knowledge/apps-collection.ts), statistics past their retention
  // (see src/statistics.ts), and messages email triggers kept, deleted
  // once their days are over (see src/workflows/kept-email.ts), guest
  // chats 30 days after they ended (see src/guests.ts), and the details
  // of workflow runs that ended longer ago than their retention (see
  // src/workflows/retention.ts), with their own files once those went
  // (see src/workflows/run-files.ts), and screens' staged builds 30 days
  // after they were last staged (see src/screen-frame.ts), and cached
  // builds 30 days after they were last used (see src/screens.ts), and npm
  // tarballs and package builds no lock names any more (see
  // src/packages/cleanup.ts), and sealed App releases nothing keeps any
  // more, with the artifacts no other release names (see
  // src/release-retention.ts), and the fixture stores App test runs
  // left behind (see src/app-tests.ts), and chats' preview stores a week
  // after they were made (see src/sealed-previews.ts), and App token keys
  // that can verify
  // nothing any more (see src/auth/app-tokens.ts). And the
  // audit log's retention alarm armed, if it isn't yet: retention itself
  // runs on that alarm (see
  // src/audit-log.ts), and a deployment that appends nothing after a
  // release still gets it.
  scheduled: async (controller, env, ctx) => {
    // The client's clock runs them (src/clock.ts): this cron is one of its
    // explicit ticks, until the hard cut removes the crons.
    const period =
      controller.cron === quarterHourCron ? "quarterHour" : "minute";
    try {
      await tickClock(env, ctx, period, controller.scheduledTime);
    } catch (error) {
      log.error("cron.failed", errorFields(error));
    }
  },
} satisfies ExportedHandler<Env>;
