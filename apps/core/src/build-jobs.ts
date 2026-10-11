import { agentErrors } from "@grasp-os/shared/agent";
import { appErrors } from "@grasp-os/shared/apps";
import { internalErrors, isExpectedError } from "@grasp-os/shared/errors";
import { chatIdSchema, workspaceIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { permissionErrors } from "@grasp-os/shared/permissions";
import type { WorkflowStepConfig } from "cloudflare:workers";
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
  proposedByJob,
  versionTree,
} from "./apps.ts";
import type { Acting } from "./auth/identity.ts";
import { memberOf } from "./auth/identity.ts";
import type { BuildJobEnd } from "./build-job-records.ts";
import { workspace } from "./durable-objects.ts";
import { grantedPermissions } from "./permissions.ts";
import { keepTests, reviewVersion } from "./version-review.ts";
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
// - Exhaustion: a chat has at most three jobs running at once, and keeps
//   the records of its latest hundred (build-job-records.ts). A job whose
//   instance ended or is gone while its record says it runs is failed,
//   freeing its place (`env.build.submit` and `env.build.job`). The engine
//   bounds each one's steps, and keeps an ended instance as long as an
//   App's run.

/** What the dispatcher hands a job (`env.build.submit`). */
export const buildJobInputSchema = z.strictObject({
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
 * granted, which ends it as revoked. The slow read of revocations comes
 * first, the job's own check last.
 */
export const admitJob = async (
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
}

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
 * Runs one step of the job as its chat's person, once it is admitted
 * (`admitJob`) and the agent may still build the App for them, as a
 * build call checks it: recorded as `agent.call` however it ends.
 */
const asJob = async <T>(
  env: Env,
  input: JobInput,
  method: string,
  run: (step: JobStep) => Promise<T>
): Promise<StepOutcome<T>> => {
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
    await auditAgentCall(
      env,
      scope,
      { method, detail: { job: job.id } },
      { outcome: "refused", reason: isExpectedError(error) ? error.code : null }
    );
    return { ok: false, end };
  }
  try {
    const value = await auditedCall(
      env,
      { ...scope, runId: job.runId },
      { method, detail: { job: job.id, app: job.appId } },
      async () => {
        const { by, app } = await authorize(env, scope, job);
        return await run({ job, scope, app, by });
      }
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
      Object.fromEntries(files)
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
    Object.fromEntries(over.files)
  );
  const { tree } = await versionTree(over.files);
  await submittedDraft(env, step);
  return {
    check: { ...check, failedInARow: 0, maxFailedChecks },
    over: { parent: over.parent, tree },
  };
};

/**
 * Records, as the job's receipt, the version it recorded it was about to
 * commit and did commit, if it did, before anything else of a commit run
 * again: whether or not the job may still act, as what it committed stays.
 * The version, if there is one.
 */
const reconcileReceipt = async (
  env: Env,
  input: JobInput
): Promise<number | undefined> => {
  const chats = workspace(env, input.workspaceId);
  const job = await chats.buildJob(input.chatId, input.jobId);
  if (job?.version !== null) {
    return job?.version;
  }
  if (job.intendedTree === null) {
    return undefined;
  }
  const version = await proposedByJob(
    env,
    job.appId,
    { parent: job.intendedParent, tree: job.intendedTree },
    { chatId: job.chatId, jobId: job.id }
  );
  if (version !== undefined) {
    await chats.recordBuildReceipt(job.chatId, job.id, version);
  }
  return version;
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
      }
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

/** The job's end for a step that failed for good: internal, unexpected. */
const unexpected = (): BuildJobEnd => {
  const error = internalErrors.create("internal.unexpected");
  return {
    status: "failed",
    error: JSON.stringify({ code: error.code, message: error.message }),
  };
};

/**
 * Runs `run` as the engine's step `name` (`asJob`), journaled: run again
 * after a restart only when it never finished.
 */
const jobStep = async <T>(
  step: RunStep,
  name: string,
  run: () => Promise<StepOutcome<T>>
): Promise<StepOutcome<T>> => {
  const outcome = await step.do(name, stepConfig, run);
  // SAFETY: the engine hands back what `run` returned, as it stored it:
  // plain data, as `run` makes nothing else.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return outcome as StepOutcome<T>;
};

/** Runs the job's steps up to how it ends; throws when a step failed for good. */
const jobSteps = async (
  env: Env,
  input: JobInput,
  step: RunStep
): Promise<BuildJobEnd> => {
  const checked = await jobStep(
    step,
    "check",
    async () =>
      await asJob(
        env,
        input,
        "build.job.check",
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
  const proposed = await jobStep(step, "commit", async () => {
    await reconcileReceipt(env, input);
    return await asJob(
      env,
      input,
      "build.job.commit",
      async (job) => await commitStep(env, job, { check, over })
    );
  });
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
  let end: BuildJobEnd;
  try {
    end = await jobSteps(env, input, step);
  } catch {
    // A step failed for good, past its retries. Should the engine have
    // stopped this execution instead, the next step throws as well, and
    // the engine runs the job again from here.
    end = unexpected();
  }
  await step.do("finish", stepConfig, async () => {
    const chats = workspace(env, input.workspaceId);
    let ending = end;
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
