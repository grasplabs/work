import { agentErrors } from "@grasp-os/shared/agent";
import { appErrors } from "@grasp-os/shared/apps";
import { isExpectedError } from "@grasp-os/shared/errors";
import { chatIdSchema, workspaceIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { executionErrors } from "@grasp-os/shared/workflows";
import type { WorkflowStepConfig } from "@grasp-os/workerflow/contracts";
import { z } from "zod";

import {
  afterProposal,
  buildingAs,
  buildsApps,
  checkFiles,
  draftOf,
  maxFailedChecks,
} from "./agent-builds.ts";
import type { DraftCheck, Proposal } from "./agent-builds.ts";
import { readDenied } from "./agent-person.ts";
import {
  auditAgentCall,
  auditedCall,
  chatAuthority,
  revokedSince,
} from "./agent-scope.ts";
import type { AgentScope } from "./agent-scope.ts";
import {
  appFor,
  draftFiles,
  draftOverLatest,
  proposeDraft,
  versionTree,
} from "./apps.ts";
import type { Acting } from "./auth/identity.ts";
import { memberOf } from "./auth/identity.ts";
import {
  admitBuild,
  buildDequeued,
  buildSeqOf,
  holding,
  maxBuildWaitMs,
} from "./build-admission.ts";
import type { BuildLease, BuildShare, BuildStep } from "./build-admission.ts";
import { reconcileReceipt } from "./build-job-receipts.ts";
import { brokenOff } from "./build-job-records.ts";
import type { BuildJobEnd } from "./build-job-records.ts";
import { workspace } from "./durable-objects.ts";
import { grantedPermissions } from "./permissions.ts";
import { keepTests, reviewVersion } from "./version-review.ts";
import { askAgainMs } from "./workflows/admission.ts";
import type { RunStep } from "./workflows/host.ts";
import type { BuildJob, Draft } from "./workspace.ts";

// A build a chat's code hands to a durable job (`env.build.submit`,
// agent-builds.ts): a check, or a proposal, of the chat's draft of an App,
// which may take longer than the code run that asks for it may live. The
// job is a workflow of core's own, run on the engine and dispatcher Apps'
// runs use (workflows/engine.ts, dispatcher.ts), like an upload's
// extraction: its steps are journaled, so a restart of the engine replays
// the steps that finished and runs the rest. Its record is the chat's, in
// its Workspace object (build-job-records.ts), and outlives a restart of
// that object too. How it ends goes to the chat: its record, and the turn
// that submitted it, if that turn still runs (workspace.ts). The code run
// itself ends as it would: nothing runs its code again, and the agent
// follows the job from a later run, a new one with an ID of its own
// (`env.build.job`).
//
// Threat model. A job runs with nobody's code in it, so what could go
// wrong is authority it shouldn't have, effects after it should have
// stopped, and effects made twice:
//
// - Ambient authority: its input is the workspace, the chat and the job,
//   nothing else. Each step reads the chat's agent and person from the
//   Workspace object and checks again what a build call does: the agent's
//   own permission to build Apps, the person still a member and a builder
//   of the App, the chat not restricted. Its last step checks all of it
//   once more before it hands on what the job came to.
// - Revocation: it acts on the authority of the code run that submitted
//   it, granted when that run opened. Each step, and each write right
//   before it commits, reads revocations since then (`admitJob`): one
//   found ends the job as revoked, and nothing it does after is admitted.
//   Any revoked permission of the agent ends it, not only those a build
//   uses (decided for GRA-443): a revocation is an admin narrowing the
//   agent's authority, which a job mustn't outlive on a guess at which
//   grants its work rests on, and a job is cheap to submit again.
//   A revoked job hands on no result. What it committed before keeps its
//   receipt: it stays, proposed for review, and is never said to be undone.
// - Cancellation: cancelling the turn that submitted it, or deleting the
//   chat, ends it; every later step and write is refused, and its instance
//   is terminated. Once its turn has ended, deleting the chat is the only
//   way to stop it, short of a revocation: it then runs to its end, bound
//   by its steps and its draft's revision.
// - Replay and double effects: a step that finished isn't run again. A
//   commit run again (its first try cut off after the version committed)
//   finds the version it recorded it was about to commit, and takes it as
//   its own rather than committing another (`reconcileReceipt`), before
//   it asks to be admitted: a commit that landed keeps its receipt, the
//   version, even when the job is then refused and ends revoked or
//   cancelled. The job ends once, however often its last step runs.
// - Another chat's job, or a guessed ID: a job's ID is random, and every
//   read and admission is the chat's own; another's reads as none.
// - A draft written after the job was submitted: the job is bound to the
//   draft's revision then, and fails with `app.conflict` once it changed,
//   read again after a check and right before a commit, so a write made
//   while either ran is never covered by a result for older files.
// - Rights lost while it commits: the person's build rights for the App
//   and restricted mode are checked again right before the commit lands,
//   not only revocations of the agent's permissions.
// - The repair loop: each job takes one of its draft's checks this turn,
//   as an in-call check does, and settles it as it ends (workspace.ts), so
//   jobs can't get the agent past the checks failed in a row it may make.
// - Builds of other chats and Apps: each step that builds (its check, its
//   commit) holds a lease on a share of the client's build jobs and of
//   its App's while it runs (build-admission.ts), so one App's jobs never
//   take every build slot, and one App never builds twice at once. A step
//   with no share waits in the queue, journaled, its job queued, not
//   failed, and asks again; it holds no lease while it waits.
// - Exhaustion: a chat has at most three jobs running at once, and keeps
//   the records of its latest hundred (build-job-records.ts). A job whose
//   instance ended or is gone while its record says it runs is failed,
//   freeing its place (`env.build.submit` and `env.build.job`). The engine
//   bounds each one's steps, and keeps an ended instance as long as an
//   App's run.

/** What the dispatcher hands a job (`env.build.submit`). */
const buildJobInputSchema = z.strictObject({
  workspaceId: workspaceIdSchema,
  chatId: chatIdSchema,
  jobId: z.uuid(),
});

type JobInput = z.infer<typeof buildJobInputSchema>;

/**
 * Retries of a step that failed with an error a retry may fix (the
 * database or the compiler out of reach for a moment): three, 10 seconds
 * apart and doubling. An expected error, a refusal or a conflict, isn't
 * retried: the step ends the job with it.
 */
const stepConfig: WorkflowStepConfig = {
  retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
  timeout: "10 minutes",
};

/** The refusal of a step or write of a job that has ended, and why. */
const jobRefusal = (call: "cancelled" | "revoked") =>
  agentErrors.create(
    call === "revoked" ? "agent.job_revoked" : "agent.job_cancelled"
  );

/** The scope a job acts in: its chat's, as the chat has it now. */
const scopeOf = (
  input: JobInput,
  job: BuildJob
): Omit<AgentScope, "runId"> => ({
  workspaceId: input.workspaceId,
  chatId: job.chatId,
  agentId: job.agentId,
  personId: job.personId,
});

/**
 * Admits a step or write of the job `jobId`, right before it: refused once
 * the job has ended (cancelled with its turn or chat, or revoked), and
 * when a permission of its agent was revoked since its authority was
 * granted, which ends it as revoked. The job's own check comes first, a
 * cheap refusal, and again last, after the slow read of revocations, so
 * nothing ended meanwhile is admitted.
 */
const admitJob = async (
  env: Env,
  scope: Omit<AgentScope, "runId">,
  jobId: string
): Promise<void> => {
  const chats = workspace(env, scope.workspaceId);
  const opened = await chats.admitFromBuildJob(scope.chatId, jobId);
  if (opened.call !== "open") {
    throw jobRefusal(opened.call);
  }
  if (await revokedSince(env, scope, opened.grantedAt)) {
    await chats.endBuildJob(scope.chatId, jobId, { status: "revoked" });
    throw jobRefusal("revoked");
  }
  const now = await chats.admitFromBuildJob(scope.chatId, jobId);
  if (now.call !== "open") {
    throw jobRefusal(now.call);
  }
};

/** A round a step of a job waited for a share in, as its step journals it. */
interface Queued {
  queued: {
    waitingFor: BuildShare;
    retryAfterSeconds: number;
    /** How long the job sleeps before it asks again. */
    sleepMs: number;
    /** When it asked, by the clock of the attempt that asked: journaled. */
    askedAt: number;
  };
}

/** What one step of a job comes to: what it made, or how the job ends. */
type StepOutcome<T> = { ok: true; value: T } | { ok: false; end: BuildJobEnd };

/**
 * How the job ends for `error`, an expected error: as the refusal says, or
 * failed with its code and message. Anything else is thrown on, for the
 * engine to retry the step.
 */
const endFor = (error: unknown): BuildJobEnd => {
  if (!isExpectedError(error)) {
    throw error;
  }
  if (error.code === "agent.job_revoked") {
    return { status: "revoked" };
  }
  if (error.code === "agent.job_cancelled") {
    return { status: "cancelled" };
  }
  return {
    status: "failed",
    error: JSON.stringify({ code: error.code, message: error.message }),
  };
};

/** What a step of a job works with. */
interface JobStep {
  job: BuildJob;
  scope: Omit<AgentScope, "runId">;
  app: AppId;
  by: Acting;
  /** The lease on its share of builds the step holds while it runs. */
  lease: BuildLease;
  /** Aborted once the lease is lost: the step starts nothing more. */
  lost: AbortSignal;
}

/** What a step of a job asks its admission to a share with. */
interface Asking {
  step: BuildStep;
  /** The engine's context for the step's attempt. */
  context: unknown;
  /** The rounds this step waited in a row. */
  waited: number;
  /** How long the job waited for a share in its steps before this one. */
  waitedBefore: number;
  /** When this step first waited for its share, if it has. */
  queuedSince: number | null;
}

/** What core reads of the engine's context for an attempt of a job's step. */
const stepContextSchema = z.object({
  attempt: z.int().positive(),
  step: z.object({ count: z.int().positive() }),
});

/** The job's sequence at the attempt of its step `asking` names. */
const seqOf = ({ step, context }: Pick<Asking, "step" | "context">): number => {
  const told = stepContextSchema.parse(context);
  return buildSeqOf(step, told.step.count, told.attempt);
};

/**
 * The chat's person as the job acts for them, and the job's App, once the
 * agent may still build it for them, as a build call checks it: the
 * agent's own permission to build Apps, the person still a member and a
 * builder of the App, and the chat not restricted.
 */
const authorize = async (
  env: Env,
  scope: Omit<AgentScope, "runId">,
  job: BuildJob
): Promise<{ by: Acting; app: AppId }> => {
  const permissions = await grantedPermissions(env, chatAuthority(scope));
  if (!buildsApps(permissions)) {
    throw readDenied("write");
  }
  const person = await memberOf(env.DB, scope.personId);
  if (person === undefined) {
    throw permissionErrors.create("permission.person_inactive");
  }
  const by = await buildingAs(env, scope, person);
  const { id: app } = await appFor(env, by, job.appId, "builder");
  return { by, app };
};

/**
 * A lease for the step `asking` names of job `job` on its share of the
 * client's builds and its App's (build-admission.ts), or the round it
 * waits, journaled by its step; the join recorded in the audit log, once
 * each time it joins the queue. A job that may wait no more, or whose
 * person or App has as many places as it may, ends failed. An attempt the
 * job has gone on without is thrown, for the engine, which takes only its
 * step's latest attempt.
 */
const admittedToBuild = async (
  env: Env,
  input: JobInput,
  scope: Omit<AgentScope, "runId">,
  job: BuildJob,
  { step, context, waited, waitedBefore, queuedSince }: Asking
): Promise<
  { lease: BuildLease } | Queued | { ok: false; end: BuildJobEnd }
> => {
  const seq = seqOf({ step, context });
  // How long it has waited, as time passed, not as it slept: a wakeup
  // that came late, or an engine that was down, counts in full.
  const askedAt = Date.now();
  const waitedMs =
    waitedBefore + (queuedSince === null ? 0 : askedAt - queuedSince);
  const owner = {
    job: input.jobId,
    subject: job.personId,
    resource: job.appId,
  };
  const method = `build.job.${step}`;
  try {
    const admitted = await admitBuild(env, owner, { seq, waited, waitedMs });
    if ("lease" in admitted) {
      return admitted;
    }
    const { wait } = admitted;
    if (wait.joined) {
      await auditAgentCall(env, scope, {
        method: "build.job.queued",
        detail: { job: job.id, app: job.appId, waitingFor: wait.waitingFor },
      });
    }
    return {
      queued: {
        waitingFor: wait.waitingFor,
        retryAfterSeconds: wait.retryAfterSeconds,
        sleepMs: askAgainMs({
          waited,
          retryAfterSeconds: wait.retryAfterSeconds,
          waitedMs,
          maxWaitMs: maxBuildWaitMs,
        }),
        askedAt,
      },
    };
  } catch (error) {
    // A stale attempt is the engine's; an unexpected error (the database
    // out of reach for a moment) is retried by it, the job keeping its
    // place. Only a refusal ends the job here.
    if (
      executionErrors.codeOf(error) === "execution.stale_attempt" ||
      !isExpectedError(error)
    ) {
      throw error;
    }
    await buildDequeued(env, owner, seq);
    await auditAgentCall(
      env,
      scope,
      { method, detail: { job: job.id } },
      { outcome: "refused", reason: error.code }
    );
    return { ok: false, end: endFor(error) };
  }
};

/**
 * Runs one step of the job as its chat's person, once it is admitted
 * (`admitJob`) and the agent may still build the App for them, as a
 * build call checks it: recorded as `agent.call` however it ends.
 */
const asJob = async <T>(
  env: Env,
  input: JobInput,
  method: string,
  asking: Asking,
  run: (step: JobStep) => Promise<T>
): Promise<StepOutcome<T> | Queued> => {
  const job = await workspace(env, input.workspaceId).buildJob(
    input.chatId,
    input.jobId
  );
  // Deleted with its chat: it does nothing more.
  if (job === undefined) {
    return { ok: false, end: { status: "cancelled" } };
  }
  const scope = scopeOf(input, job);
  try {
    await admitJob(env, scope, job.id);
  } catch (error) {
    const end = endFor(error);
    // Ended while it waited: it waits for a share no more.
    await buildDequeued(env, { job: input.jobId }, seqOf(asking));
    await auditAgentCall(
      env,
      scope,
      { method, detail: { job: job.id } },
      { outcome: "refused", reason: isExpectedError(error) ? error.code : null }
    );
    return { ok: false, end };
  }
  const admitted = await admittedToBuild(env, input, scope, job, asking);
  if (!("lease" in admitted)) {
    return admitted;
  }
  const { lease } = admitted;
  try {
    const value = await holding(
      lease,
      async (lost) =>
        await auditedCall(
          env,
          { ...scope, runId: job.runId },
          // The run that submitted it, recorded with each of its calls.
          { method, detail: { job: job.id, app: job.appId, run: job.runId } },
          async () => {
            const { by, app } = await authorize(env, scope, job);
            return await run({ job, scope, app, by, lease, lost });
          }
        )
    );
    return { ok: true, value };
  } catch (error) {
    return { ok: false, end: endFor(error) };
  }
};

/** The draft the job was submitted for: refused once it changed since. */
const submittedDraft = async (
  env: Env,
  { job, scope, app }: JobStep
): Promise<Draft> => {
  const draft = await draftOf(env, scope, app);
  if (draft.revision !== job.revision) {
    throw appErrors.create("app.conflict", {
      issues: [
        "The draft changed since the job was submitted: submit it again.",
      ],
    });
  }
  return draft;
};

/**
 * Refuses to go on, between a check's phases, once the step lost its
 * lease (`lost`): what it built so far is no one's, and another job of
 * its App may build now.
 */
const startsNothingOnceLost = (lost: AbortSignal) => (): void => {
  lost.throwIfAborted();
};

/** What a job's check comes to: the check, and the commit it would make. */
interface Checked {
  check: DraftCheck;
  /** The version a proposal commits over, and its tree: null for a check. */
  over: { parent: number | null; tree: string } | null;
}

/** Checks the job's draft: over the App's latest version, to propose it. */
const checkStep = async (env: Env, step: JobStep): Promise<Checked> => {
  const draft = await submittedDraft(env, step);
  const { job, scope, app } = step;
  if (job.kind === "check") {
    const files = await draftFiles(env, app, draft);
    const check = await checkFiles(
      env,
      scope,
      app,
      draft,
      Object.fromEntries(files),
      startsNothingOnceLost(step.lost)
    );
    // A check of files the draft no longer has says nothing of it.
    await submittedDraft(env, step);
    return {
      // The checks failed in a row are settled as the job ends, and set
      // in its result then (workspace.ts).
      check: { ...check, failedInARow: 0, maxFailedChecks },
      over: null,
    };
  }
  if (Object.keys(draft.changes).length === 0) {
    throw appErrors.create("app.nothing_to_commit");
  }
  const over = await draftOverLatest(env, app, draft);
  const check = await checkFiles(
    env,
    scope,
    app,
    draft,
    Object.fromEntries(over.files),
    startsNothingOnceLost(step.lost)
  );
  const { tree } = await versionTree(over.files);
  await submittedDraft(env, step);
  return {
    check: { ...check, failedInARow: 0, maxFailedChecks },
    over: { parent: over.parent, tree },
  };
};

/**
 * Commits the job's draft as the App's next version, pending review, as
 * `env.build.propose` does once its check passed: admitted right before
 * it commits (authorized again, the draft still at its revision, and the
 * job still open), and once only. A version it recorded it was about to commit
 * and did is its receipt: a commit run again takes it, rather than making
 * another. The tests its check ran are kept with the version, and the
 * draft's revision is dropped.
 */
const commitStep = async (
  env: Env,
  step: JobStep,
  checked: Checked & { over: NonNullable<Checked["over"]> }
): Promise<Proposal> => {
  const { job, scope, app, by } = step;
  const chats = workspace(env, scope.workspaceId);
  // Its receipt, recorded before this step was admitted (`reconcileReceipt`).
  let version = job.version ?? undefined;
  let { tree } = checked.over;
  if (version === undefined) {
    const over = await draftOverLatest(
      env,
      app,
      await submittedDraft(env, step)
    );
    const intended = await versionTree(over.files);
    if (over.parent !== checked.over.parent || intended.tree !== tree) {
      throw appErrors.create("app.conflict", {
        issues: ["The App changed since the job checked the draft."],
      });
    }
    if (
      !(await chats.intendBuildCommit(scope.chatId, job.id, over.parent, tree))
    ) {
      throw jobRefusal("cancelled");
    }
    // Proposed as this job's: what its receipt is found by.
    const byJob =
      by.via === undefined ? by : { ...by, via: { ...by.via, jobId: job.id } };
    const proposed = await proposeDraft(
      env,
      byJob,
      app,
      over,
      job.message,
      // Right before it commits, after storing its files: the person
      // still builds the App, the chat isn't restricted, the draft is
      // still the one checked, and the job may still act.
      async () => {
        await authorize(env, scope, job);
        await submittedDraft(env, step);
        await admitJob(env, scope, job.id);
      },
      // Its lease lapsed (it stalled): another job of the App may build
      // now, so the database refuses its commit, in the commit's own
      // transaction; the engine tries the step again, which waits for its
      // share.
      step.lease.fence()
    );
    ({ version, tree } = proposed);
  }
  // The check ran the tests of exactly these files: kept with the version,
  // before its receipt, so a commit cut off here takes the version again.
  if (checked.check.tests.status !== "not_run") {
    await keepTests(env, app, tree, checked.check.tests).catch(
      afterProposal("keep_tests", app, version)
    );
  }
  await chats.recordBuildReceipt(scope.chatId, job.id, version);
  await chats
    .dropDraft(scope.chatId, app, { revision: job.revision })
    .catch(afterProposal("drop_draft", app, version));
  const review = await reviewVersion(env, by, app, version).catch(
    afterProposal("review", app, version)
  );
  return {
    version,
    check: checked.check,
    review: review ?? null,
    reviewUnavailable: review === undefined,
  };
};

/** How the job ends once its steps came to `result`. */
const completed = (result: DraftCheck | Proposal): BuildJobEnd => ({
  status: "completed",
  result: JSON.stringify(result),
});

/**
 * Runs `run` as the engine's step `name` (`asJob`), journaled: run again
 * after a restart only when it never finished. A round with no share of
 * builds sleeps its wait, journaled too, and runs the step again, as a
 * new occurrence of it: so a restart replays the rounds it waited, and
 * how long, as they were.
 */
const jobStep = async <T>(
  step: RunStep,
  name: BuildStep,
  /** How long the job waited for a share in its steps before this one. */
  waitedBefore: number,
  run: (asking: Asking) => Promise<StepOutcome<T> | Queued>
): Promise<{ outcome: StepOutcome<T>; waitedMs: number }> => {
  let waited = 0;
  // A job's wait is held to its cap across its steps, not each step's: as
  // time passed since this step first waited (journaled), after the
  // waits of the steps before it.
  let queuedSince: number | null = null;
  let waitedUntil: number | null = null;
  for (;;) {
    const asked = { waited, waitedBefore, queuedSince };
    // oxlint-disable-next-line no-await-in-loop -- one round after another
    const journaled = await step.do(
      name,
      stepConfig,
      async (context) => await run({ step: name, context, ...asked })
    );
    // SAFETY: the engine hands back what `run` returned, as it stored it:
    // plain data, as `run` makes nothing else.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    const outcome = journaled as StepOutcome<T> | Queued;
    if (!("queued" in outcome)) {
      // This step's wait, up to its last sleep's end at least.
      const waitedMs =
        waitedBefore +
        (queuedSince === null || waitedUntil === null
          ? 0
          : waitedUntil - queuedSince);
      return { outcome, waitedMs };
    }
    queuedSince ??= outcome.queued.askedAt;
    waitedUntil = outcome.queued.askedAt + outcome.queued.sleepMs;
    // oxlint-disable-next-line no-await-in-loop -- one round after another
    await step.sleep(`${name}.queued.${waited + 1}`, outcome.queued.sleepMs);
    waited += 1;
  }
};

/** Runs the job's steps up to how it ends; throws when a step failed for good. */
const jobSteps = async (
  env: Env,
  input: JobInput,
  step: RunStep
): Promise<BuildJobEnd> => {
  const { outcome: checked, waitedMs } = await jobStep(
    step,
    "check",
    0,
    async (asking) =>
      await asJob(
        env,
        input,
        "build.job.check",
        asking,
        async (job) => await checkStep(env, job)
      )
  );
  if (!checked.ok) {
    return checked.end;
  }
  const { check, over } = checked.value;
  if (over === null) {
    return completed(check);
  }
  if (!check.passed) {
    return completed({
      version: null,
      check,
      review: null,
      reviewUnavailable: false,
    });
  }
  const { outcome: proposed } = await jobStep(
    step,
    "commit",
    waitedMs,
    async (asking) => {
      // Before it asks to be admitted: what it committed stays its receipt.
      await reconcileReceipt(env, input.workspaceId, input.chatId, input.jobId);
      return await asJob(
        env,
        input,
        "build.job.commit",
        asking,
        async (job) => await commitStep(env, job, { check, over })
      );
    }
  );
  return proposed.ok ? completed(proposed.value) : proposed.end;
};

/**
 * Runs (or resumes) a build job (dispatcher.ts): its steps, then a last
 * step that ends it, once. A job that completed is admitted and authorized
 * once more there, so one revoked meanwhile, or whose person can no longer
 * build its App, hands on nothing.
 */
export const runBuildJob = async (
  env: Env,
  payload: unknown,
  step: RunStep
): Promise<void> => {
  const input = buildJobInputSchema.parse(payload);
  // Null when a step failed for good, past its retries. Should the engine
  // have stopped this execution instead, the next step throws as well,
  // and the engine runs the job again from here.
  let end: BuildJobEnd | null;
  try {
    end = await jobSteps(env, input, step);
  } catch {
    end = null;
  }
  await step.do("finish", stepConfig, async () => {
    const chats = workspace(env, input.workspaceId);
    // Broken off: as one that committed, if it did, never as one to submit
    // again.
    let ending =
      end ??
      brokenOff(
        (await reconcileReceipt(
          env,
          input.workspaceId,
          input.chatId,
          input.jobId
        )) ?? null
      );
    if (ending.status === "completed") {
      const job = await chats.buildJob(input.chatId, input.jobId);
      try {
        if (job === undefined) {
          throw jobRefusal("cancelled");
        }
        const scope = scopeOf(input, job);
        await admitJob(env, scope, job.id);
        // Its person may have lost the App, or the chat turned restricted,
        // since its last step: what it came to isn't handed on then.
        await authorize(env, scope, job);
      } catch (error) {
        ending = endFor(error);
      }
    }
    await chats.endBuildJob(input.chatId, input.jobId, ending);
    return null;
  });
};
