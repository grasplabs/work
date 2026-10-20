import { errorFields, log } from "@grasp-os/shared/log";

import { retryAccessRevocations } from "./access-revocations.ts";
import { sweepTestFixtures } from "./app-tests.ts";
import { auditLog } from "./audit-log.ts";
import { drainAuditOutboxes } from "./audit-outbox.ts";
import { sweepTokenKeys } from "./auth/app-tokens.ts";
import { refreshDailySignals } from "./daily-signals.ts";
import { handleRequest } from "./entry.ts";
import { sweepGuestChats } from "./guests.ts";
import { indexApps } from "./knowledge/apps-collection.ts";
import { sweepUploads } from "./knowledge/uploads.ts";
import { retryDisconnects } from "./members.ts";
import { sweepPackageFiles } from "./packages/cleanup.ts";
import { recordPlatformUpdate } from "./platform-updates.ts";
import { sweepReleases } from "./release-retention.ts";
import { sweepScreenFrames } from "./screen-frame.ts";
import { sweepScreenSubmissions } from "./screen-submissions.ts";
import { sweepBuilds } from "./screens.ts";
import { sweepPreviewStores } from "./sealed-previews.ts";
import { sweepStatistics } from "./statistics.ts";
import { sweepCandidateRuns } from "./workflows/candidate-runs.ts";
import { pumpConnectorEvents } from "./workflows/connector-events.ts";
import { repairControls } from "./workflows/controls.ts";
import { receiveEmail } from "./workflows/inbound-email.ts";
import { deleteExpiredEmail } from "./workflows/kept-email.ts";
import {
  repairResourceStarts,
  repairResourceTerminations,
} from "./workflows/resource-runs.ts";
import { sweepRunDetails } from "./workflows/retention.ts";
import { sweepRunFiles } from "./workflows/run-files.ts";
import { repairStarts } from "./workflows/runs.ts";
import { startDueSchedules } from "./workflows/triggers.ts";
import { repairWakes } from "./workflows/wakes.ts";

/** The cron trigger that runs every 15 minutes (wrangler.jsonc). */
const quarterHourCron = "*/15 * * * *";

export { App } from "./app.ts";
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
  scheduled: async (controller, env) => {
    const jobs =
      controller.cron === quarterHourCron
        ? [
            refreshDailySignals(env),
            indexApps(env),
            sweepStatistics(env),
            deleteExpiredEmail(env, new Date(controller.scheduledTime)),
            sweepGuestChats(env, new Date(controller.scheduledTime)),
            sweepRunDetails(env, new Date(controller.scheduledTime)),
            sweepCandidateRuns(env, new Date(controller.scheduledTime)),
            // The clock as it sweeps: its grace counts from real time.
            sweepRunFiles(env),
            sweepScreenFrames(env, new Date(controller.scheduledTime)),
            sweepPreviewStores(env, new Date(controller.scheduledTime)),
            sweepBuilds(env, new Date(controller.scheduledTime)),
            sweepPackageFiles(env, new Date(controller.scheduledTime)),
            sweepReleases(env, new Date(controller.scheduledTime)),
            sweepTestFixtures(env, new Date(controller.scheduledTime)),
            sweepScreenSubmissions(env, new Date(controller.scheduledTime)),
            sweepTokenKeys(env, new Date(controller.scheduledTime)),
            auditLog(env).armRetention(),
          ]
        : [
            drainAuditOutboxes(env),
            retryDisconnects(env),
            retryAccessRevocations(env),
            sweepUploads(env),
            // Deploys apply migrations first (CI's db:migrate, and the
            // console's deploy), so `platform_versions` exists. A version
            // running before it does records nothing, and the first run
            // after the migration records the version then running: only a
            // version that came and went in between goes unrecorded.
            recordPlatformUpdate(env),
            startDueSchedules(env, new Date(controller.scheduledTime)),
            repairStarts(env),
            repairResourceStarts(env, new Date(controller.scheduledTime)),
            repairResourceTerminations(env, new Date(controller.scheduledTime)),
            repairControls(env),
            repairWakes(env, new Date(controller.scheduledTime)),
            pumpConnectorEvents(env),
          ];
    const results = await Promise.allSettled(jobs);
    for (const result of results) {
      if (result.status === "rejected") {
        log.error("cron.failed", errorFields(result.reason));
      }
    }
  },
} satisfies ExportedHandler<Env>;
