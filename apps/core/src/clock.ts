import { sweepLinking } from "@grasp-os/brain/entities";
import { sweepIndexing } from "@grasp-os/brain/indexing";
import { sweepBrainReceipts } from "@grasp-os/brain/memories";
import { sweepPayloads } from "@grasp-os/brain/payloads";
import { errorFields, log } from "@grasp-os/shared/log";
import {
  ClockObject,
  clockStarter as starter,
} from "@grasp-os/workerflow/clock";
import type { ClockReport, ClockTask } from "@grasp-os/workerflow/clock";

import { retryAccessRevocations } from "./access-revocations.ts";
import { sweepTestFixtures } from "./app-tests.ts";
import { auditLog } from "./audit-log.ts";
import { drainAuditOutboxes } from "./audit-outbox.ts";
import { sweepTokenKeys } from "./auth/app-tokens.ts";
import { reconcileRunCaptures } from "./brain-capture.ts";
import { reconcileConsolidation } from "./brain-consolidation.ts";
import { sweepChannelLinks } from "./channels/accounts.ts";
import { sweepChannelSignals } from "./channels/signals.ts";
import { sweepStephenRequests } from "./channels/stephen-requests.ts";
import { refreshDailySignals } from "./daily-signals.ts";
import { recheckMalware } from "./dependencies/requests.ts";
import { inJurisdiction } from "./durable-objects.ts";
import { sweepGuestChats } from "./guests.ts";
import { sweepHeldStartInputs } from "./held-starts.ts";
import { indexApps } from "./knowledge/apps-collection.ts";
import { brainOf } from "./knowledge/ports.ts";
import { sweepUploads } from "./knowledge/uploads.ts";
import { retryDisconnects } from "./members.ts";
import { sweepPackageFiles } from "./packages/cleanup.ts";
import { retryErasures } from "./person-erasure.ts";
import { recordPlatformUpdate } from "./platform-updates.ts";
import { sweepReleases } from "./release-retention.ts";
import { sweepScreenFrames } from "./screen-frame.ts";
import { sweepBuilds } from "./screens.ts";
import { sweepPreviewStores } from "./sealed-previews.ts";
import { sweepSpokenLines } from "./speech-cache.ts";
import { sweepStatistics } from "./statistics.ts";
import { sendStephenSummaries } from "./stephen-summary.ts";
import { sweepCandidateRuns } from "./workflows/candidate-runs.ts";
import { pumpConnectorEvents } from "./workflows/connector-events.ts";
import { sweepConnectorTriggerHolds } from "./workflows/connector-triggers.ts";
import { cancelArchivedRuns, repairControls } from "./workflows/controls.ts";
import { drainEmittedEvents } from "./workflows/event-delivery.ts";
import { deleteExpiredEmail } from "./workflows/kept-email.ts";
import {
  repairResourceStarts,
  repairResourceTerminations,
} from "./workflows/resource-runs.ts";
import { sweepRunDetails } from "./workflows/retention.ts";
import { sweepRunFiles } from "./workflows/run-files.ts";
import { repairStarts } from "./workflows/runs.ts";
import { startDueScheduleTriggers } from "./workflows/schedule-triggers.ts";
import { startDueSchedules } from "./workflows/triggers.ts";
import { repairWakes } from "./workflows/wakes.ts";

// The client's clock for core (spec 43.5, @grasp-os/workerflow/clock):
// core's maintenance, repair and schedule-admission tasks, each run once
// per slot of its period with its own durable state, on the clock's alarm.
// Core has no cron: a Workers for Platforms user Worker can't.

/**
 * Every task, in the order each period starts them. Each runs concurrently
 * with the rest of its slot; its own failure is its own.
 */
export const clockTasks: readonly ClockTask<Env>[] = [
  { name: "audit.drain", period: "minute", run: drainAuditOutboxes },
  // Settled runs' outcomes the Brain doesn't have yet (src/brain-capture.ts).
  { name: "brain.capture", period: "minute", run: reconcileRunCaptures },
  // Scopes whose few new episodes waited long enough to be consolidated
  // into lesson candidates (src/brain-consolidation.ts).
  {
    name: "brain.consolidation",
    period: "minute",
    run: reconcileConsolidation,
  },
  { name: "members.disconnects", period: "minute", run: retryDisconnects },
  { name: "members.erasures", period: "minute", run: retryErasures },
  {
    name: "access.revocations",
    period: "minute",
    run: retryAccessRevocations,
  },
  { name: "knowledge.uploads", period: "minute", run: sweepUploads },
  // Knowledge payloads no version refers to (src/knowledge/payloads.ts).
  {
    name: "knowledge.payloads",
    period: "minute",
    run: async (env, at) => {
      await sweepPayloads(brainOf(env), at);
    },
  },
  // Documents whose indexing never started or ended unfinished, and failed
  // ones due another run (src/knowledge/indexing.ts).
  {
    name: "knowledge.indexing",
    period: "minute",
    run: async (env, at) => {
      await sweepIndexing(brainOf(env), at);
    },
  },
  // Brain sources settled since their change, linking runs that ended
  // unfinished, and failed ones due another run (packages/brain's
  // entities.ts).
  {
    name: "knowledge.linking",
    period: "minute",
    run: async (env, at) => {
      await sweepLinking(brainOf(env), at);
    },
  },
  // Deploys apply migrations first (CI's db:migrate, and the admin's
  // deploy), so `platform_versions` exists. A version running before it
  // does records nothing, and the first run after the migration records
  // the version then running: only a version that came and went in
  // between goes unrecorded.
  {
    name: "platform.updates",
    period: "minute",
    run: recordPlatformUpdate,
  },
  {
    name: "workflows.schedules",
    period: "minute",
    run: startDueSchedules,
  },
  // Independent schedule triggers' due occurrences
  // (src/workflows/schedule-triggers.ts).
  {
    name: "workflows.schedule_triggers",
    period: "minute",
    run: startDueScheduleTriggers,
  },
  {
    name: "workflows.starts",
    period: "minute",
    run: async (env) => {
      await repairStarts(env);
    },
  },
  {
    name: "workflows.resource_starts",
    period: "minute",
    run: repairResourceStarts,
  },
  {
    name: "workflows.resource_terminations",
    period: "minute",
    run: repairResourceTerminations,
  },
  { name: "workflows.controls", period: "minute", run: repairControls },
  {
    // An archived App's runs, cancelled in bounded passes (app-status.ts).
    name: "apps.archived_runs",
    period: "minute",
    run: async (env) => {
      await cancelArchivedRuns(env);
    },
  },
  { name: "workflows.wakes", period: "minute", run: repairWakes },
  {
    name: "workflows.connector_events",
    period: "minute",
    run: pumpConnectorEvents,
  },
  // Events JSON workflows emitted, delivered to the system triggers that
  // take them (src/workflows/event-delivery.ts).
  {
    name: "workflows.emitted_events",
    period: "minute",
    run: async (env) => {
      await drainEmittedEvents(env);
    },
  },
  // Connect's own clock armed, if nothing has (connect's src/clock.ts).
  {
    name: "connect.clock",
    period: "minute",
    run: async (env) => {
      await env.CONNECT.ensureClock();
    },
  },
  {
    name: "signals.daily",
    period: "quarterHour",
    run: refreshDailySignals,
  },
  {
    name: "knowledge.apps",
    period: "quarterHour",
    run: async (env) => {
      await indexApps(env);
    },
  },
  { name: "statistics.sweep", period: "quarterHour", run: sweepStatistics },
  // Brain command receipts past their retention (src/knowledge/memories.ts).
  {
    name: "knowledge.brain_receipts",
    period: "quarterHour",
    run: async (env, at) => {
      await sweepBrainReceipts(brainOf(env), at);
    },
  },
  {
    name: "email.kept",
    period: "quarterHour",
    run: deleteExpiredEmail,
  },
  { name: "guests.sweep", period: "quarterHour", run: sweepGuestChats },
  // Connector triggers' holds and tombstones of events long settled or no
  // longer coming (src/workflows/connector-triggers.ts).
  {
    name: "workflows.connector_holds",
    period: "quarterHour",
    run: sweepConnectorTriggerHolds,
  },
  { name: "channels.links", period: "quarterHour", run: sweepChannelLinks },
  // Stephen's counts past their week (src/channels/signals.ts).
  {
    name: "channels.signals",
    period: "quarterHour",
    run: sweepChannelSignals,
  },
  // Stephen's requests past their thirteen months, and the questions
  // nothing points at (src/channels/stephen-requests.ts).
  {
    name: "channels.requests",
    period: "quarterHour",
    run: sweepStephenRequests,
  },
  // The weekly summary of Stephen's requests, on Monday mornings
  // (src/stephen-summary.ts).
  {
    name: "stephen.summaries",
    period: "quarterHour",
    run: sendStephenSummaries,
  },
  // Gmail's watch on Stephen's mailbox, renewed daily (channels/gmail.ts).
  // Loaded when it runs, not as core starts: it brings the Chat SDK.
  {
    name: "channels.gmail_watch",
    period: "quarterHour",
    run: async (env) => {
      const { renewGmailWatch } = await import("./channels/gmail.ts");
      await renewGmailWatch(env);
    },
  },
  {
    name: "workflows.run_details",
    period: "quarterHour",
    run: sweepRunDetails,
  },
  // What a lapsed held start was asked to run with (held-starts.ts).
  {
    name: "workflows.held_start_inputs",
    period: "quarterHour",
    run: sweepHeldStartInputs,
  },
  {
    name: "workflows.candidate_runs",
    period: "quarterHour",
    run: sweepCandidateRuns,
  },
  // Its grace counts from real time, not the slot's.
  {
    name: "workflows.run_files",
    period: "quarterHour",
    run: async (env) => {
      await sweepRunFiles(env);
    },
  },
  {
    name: "screens.frames",
    period: "quarterHour",
    run: sweepScreenFrames,
  },
  {
    name: "screens.previews",
    period: "quarterHour",
    run: sweepPreviewStores,
  },
  { name: "screens.builds", period: "quarterHour", run: sweepBuilds },
  {
    name: "speech.spoken_lines",
    period: "quarterHour",
    run: sweepSpokenLines,
  },
  {
    name: "packages.files",
    period: "quarterHour",
    run: sweepPackageFiles,
  },
  // Approved packages checked again for malware reported since, a bounded
  // number of graphs a run (src/dependencies/requests.ts).
  {
    name: "dependencies.malware",
    period: "quarterHour",
    run: recheckMalware,
  },
  { name: "apps.releases", period: "quarterHour", run: sweepReleases },
  {
    name: "apps.test_fixtures",
    period: "quarterHour",
    run: sweepTestFixtures,
  },
  { name: "auth.token_keys", period: "quarterHour", run: sweepTokenKeys },
  // The audit log's retention alarm armed, if it isn't yet: retention
  // itself runs on that alarm (src/audit-log.ts), and a deployment that
  // appends nothing after a release still gets it.
  {
    name: "audit.retention",
    period: "quarterHour",
    run: async (env) => {
      await auditLog(env).armRetention();
    },
  },
];

/** How core logs a task that failed: its name and the error, nothing it worked on. */
export const report: ClockReport = (event, task, error) => {
  log.error(event, { task, ...errorFields(error) });
};

/** The client's one clock for core. */
export class Clock extends ClockObject<Env> {
  protected readonly clockTasks = clockTasks;
  protected report = report;
}

/** The client's one clock. */
export const clock = (
  env: Pick<Env, "CLOCK" | "DURABLE_OBJECT_JURISDICTION">
): DurableObjectStub<Clock> =>
  inJurisdiction(env, env.CLOCK).getByName("clock");

/** How core logs a clock it couldn't arm. */
const ensureFailed = (error: unknown): void => {
  log.error("clock.ensure_failed", errorFields(error));
};

/** An isolate's starter of the clock, which the first request it serves runs. */
export const clockStarter = () => starter<Env>(clock, ensureFailed);

/** This isolate's starter. */
export const ensureClockOnce = clockStarter();
