import {
  declaredWorkflows,
  schemaFromDescriptor,
  workflowFingerprint,
  workflowFunctions,
} from "@grasp-os/runtime/host";
import type {
  BoundWorkflow,
  WorkflowMutationName,
} from "@grasp-os/runtime/host";
import { versionErrors } from "@grasp-os/shared/app-releases";
import type { AuditEntry } from "@grasp-os/shared/audit";
import {
  expectedMessageOf,
  isExpectedCode,
  isExpectedError,
} from "@grasp-os/shared/errors";
import { isAppErrorCode } from "@grasp-os/shared/function-limits";
import {
  categoryOf,
  isRetryableCode,
  functionErrors,
} from "@grasp-os/shared/functions";
import { appIdSchema, workflowResourceIdSchema } from "@grasp-os/shared/ids";
import type { AppId } from "@grasp-os/shared/ids";
import { canonicalText } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { permissionErrors } from "@grasp-os/shared/permissions";
import type { Authority } from "@grasp-os/shared/permissions";
import type { Identity } from "@grasp-os/shared/rpc";
import {
  idempotencyKeySchema,
  submissionErrors,
} from "@grasp-os/shared/submissions";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { workflowErrors } from "@grasp-os/shared/workflows";
import { and, eq, exists, inArray, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import { loadRelease } from "./app-releases.ts";
import type { Release } from "./app-releases.ts";
import { appStartFiles } from "./app-start-files.ts";
import { bindingNamesSql, startAppBinding } from "./app-workflow-bindings.ts";
import { usableApp } from "./apps.ts";
import { auditedBatch, outboxed, outboxedWhere } from "./audit-outbox.ts";
import {
  workflowDecisions,
  workflowResourceRunControlKeys,
  workflowResourceRunControls,
  workflowResourceRuns,
  workflowStartReceipts,
} from "./db/core/schema.ts";
import { isUniqueViolation } from "./db/d1.ts";
import {
  answerableByNow,
  resourceDecisionPending,
} from "./decisions/decisions.ts";
import { appHost } from "./durable-objects.ts";
import { requireNotRevoked } from "./release-runner.ts";
import { coreStartKey } from "./workflow-start-intents.ts";
import { appSendHoldsSql, appStartHoldsSql } from "./workflow-starts.ts";
import { aiWaitsOf } from "./workflows/ai-waits.ts";
import { runEngine } from "./workflows/engine.ts";
import {
  applyCancel,
  applyResourceControl,
  cancelRepairAfterMs,
  resultOf,
  runEntry,
  runOf,
  unended,
} from "./workflows/resource-runs.ts";
import type { ResourceControlRow, RunRow } from "./workflows/resource-runs.ts";
import { tellQueryFollowers } from "./workflows/run-changes.ts";
import { admitRunEvent, unlessAccepted } from "./workflows/run-events.ts";
import type { AdmittedEvent } from "./workflows/run-events.ts";
import { runWaits, withRespond } from "./workflows/run-waits.ts";

// What an App's page asks of the workflows its App binds, through each
// generated workflow reference's ordinary functions (spec 10.4;
// workflow-functions.ts in the SDK declares them, and `useWorkflow` is
// built on them): its mutations `start`, `pause`, `resume`, `cancel` and
// `send`, answered here as a page's calls (`answerWorkflowMutation`), and
// its queries `run` and `canStart`, read here as any of its queries is,
// live or not (`readRun`, `mayStartNow`, through
// workflow-reference-queries.ts). All of these are a person's page's
// alone (app-functions.ts, `FunctionCallOptions.page`): an agent's, a
// Code Mode run's or the App's own server code's call of them names no
// function (`function.not_found`), a visitor's is refused as not granted,
// and a preview's is its side effect (`app.preview_side_effect`). Threat
// model on GRA-626, and how each is closed:
//
// - A run started twice: by a render, a remount, a reconnect or a lost
//   answer. Only a `start` call starts one, under the client's key (one
//   of the App's mutations' keys, `submission.key_invalid` otherwise),
//   and the receipt is unique per App, person and key, so a call sent
//   again answers the run it started (`startAppBinding`), and the same key
//   with other input is refused (`workflow.start_conflict`). A query
//   starts and controls nothing.
// - A function made up, or of another workflow: it is a name, resolved in
//   the App's current release as the App's own functions are, against the
//   workflow that release declares under the alias it names
//   (`function.not_found` otherwise), its arguments checked by the
//   descriptors generated from that declaration. Only an alias the seal
//   binds to a workflow has anything to start or read. As with
//   the App's own functions, a page of an older release open across a
//   publish is answered by the current one's contract: it never names its
//   own, so nothing is refused as stale, and
//   the page's types may lag until it loads the new release.
// - A rebind since the seal running a workflow the reference's contract
//   wasn't made for: a start requires, in its admitting statement, that the
//   App's active binding still names the sealed workflow, whose live
//   version it starts; a run is seen only while it does. A version whose
//   contract differs from what an App binding it declares never goes live
//   (workflow-publish.ts).
// - Another person's run, or another App's: a run is seen only when its
//   start receipt says this App started it for the caller, and it acts for
//   them, of the sealed workflow, started by an App version that
//   declared the same contract; anything else, one that doesn't exist
//   included, is `workflow.run_unavailable`, which the `run` query answers
//   as null. No App role, owner or admin sees past that.
// - Controls by someone who may no longer use the App: what the page is
//   told it may do, and what a control requires as its receipt is written,
//   is the rule an App's start is admitted on now (`appStartHoldsSql`:
//   their role in the App, the release not revoked, the App's `start`
//   grant) and the binding in force: read in the statement that writes the
//   receipt, so a revocation between the two lets nothing through.
// - Status and capability from different moments: a run's snapshot is one
//   read, its status and what may be done with it together, read again
//   whole as the run changes (run-changes.ts) and as the App's grants do
//   (permissions.ts); a live query shows only its newest read.
// - What a run returned reaching anyone else: only the run's person sees
//   its snapshot, through the App that started it, under the run's
//   retention (`resultOf`). What it returned is projected by the `returns`
//   the App declares, which the version that started it declared alike,
//   refused if it doesn't fit;
//   why it failed, only as a code the platform defines, in the platform's
//   own words (`failureOf`): the engine's message, or a code of the
//   workflow's own, can be made of what the run read through grants the
//   App doesn't hold. A restricted run's result goes only through an App
//   in restricted mode itself.
// - An event sent to a run by someone, or through something, that may not
//   send it (spec 10.4.6). A send names a run the page sees (above), an
//   event the release declares for the workflow, by its alias, its type
//   the one the release resolved, and data that the event's declared
//   contract takes, extra fields refused.
//   It needs the App's own `send` grant on the workflow, which no `start`,
//   `read` or decision implies, held for the person now with their role in
//   the App and the binding in force; the run takes it only as its inbox
//   admits any event (workflows/run-events.ts): through an event binding
//   its start froze, its contract pinned, its authority read again, and
//   only while it hasn't ended (`workflow.run_ended`: a send starts no run).
//   An App in restricted mode sends only to a run restricted itself
//   (`permission.restricted`): its page's data may carry what it read.
//   The grant is read just before the inbox takes the event, in another
//   store, so a revocation landing between the two lets that one send in;
//   the next is refused.
// - A sender forging provenance, or another sender's event. A send carries
//   only the run, the event's alias, its data and the client's key: a call
//   with any other argument (an envelope's source, ID, time or subject) is
//   refused whole by its descriptor (`contract.invalid_args`). The host mints the
//   envelope: its source from the App, release and person the request is
//   authenticated as (`sourceOf`), its ID from the run, binding, source
//   and key, its time as the run accepts it.
// - One person's page filling a run's inbox for every other sender: each
//   App and person is one sender, whose events hold no more than their
//   share of the inbox (`senderOf`), refused before the send is answered
//   (`workflow.event_refused`), never accepted and dropped.
// - A send admitted twice, or lost: each `send` call is its own key, so two
//   calls are two events, however equal their data; a resend of one under
//   its key, its answer lost, is the same event, answered with the same ID
//   (the run's inbox keeps every key it took, consumed or not, for as long
//   as it keeps the event, and answers for it even once the run ended or
//   the grant it was sent on went), and a key reused for other data is
//   refused (`workflow.event_conflict`). A run restarted from an earlier
//   step forgets the events nothing had taken (@grasp-os/workerflow,
//   `forgetIn`), keys and all: a resend of one of those after the restart
//   is admitted again, as the event the restart forgot. A send
//   resumes no paused run (the event waits for the run's resume), and
//   answers no decision, which only `decide` does.
// - Controls that undo one another: a pause or resume delivered late
//   undoing a newer control, or one outliving a cancel. Each admitted
//   control takes the run's next control generation in the statement that
//   writes its receipt, and goes to the engine with it, which ignores one
//   older than the newest it took (engine.ts); a receipt settles from the
//   generation the engine says it took, never from a status alone
//   (resource-runs.ts, `settleResourceControls`). One pause or resume is
//   unresolved at a time: the same kind asked again, under any key, joins
//   it, its key kept with the receipt it joined, so a retry under it is
//   answered that receipt again, never decided anew to undo a control
//   admitted since (`workflow_resource_run_control_keys`); the other, or either while a cancel is asked, is a conflict
//   (`workflow.control_conflict`). A cancel has priority: one per run
//   whatever key asks for it, it takes the next generation, so a pause or
//   resume admitted before it can no longer reach the engine, and
//   terminate is final there. A
//   request the run is already past (pausing a paused run) is applied at
//   once, as the engine has it, not the row, which may lag behind it.
//   Every receipt is applied again by the repair while it stays admitted
//   (`repairResourceTerminations`), and settled once, by the run's end at
//   the latest.
// - Controls while the run rolls back: none is offered or admitted while
//   the engine says the run is rolling back (spec 10.7.3: during a
//   compensation nothing may be paused, resumed or cancelled from an App).

const mutationPath =
  /^workflows\.(?<alias>[A-Za-z][A-Za-z0-9_]{0,63})\.mutations\.(?<name>[A-Za-z]{1,32})$/u;

/**
 * Whether `contractId` names one of a workflow reference's mutations
 * (`workflows.<alias>.mutations.<name>`): core answers it itself, only
 * for a page (`answerWorkflowMutation`), never as an App's function.
 */
export const isWorkflowMutationPath = (contractId: string): boolean =>
  mutationPath.test(contractId);

/** Who asks, and through which App's current release. */
interface Asking {
  readonly by: { readonly userId: string; readonly staff?: boolean };
  readonly app: AppId;
  readonly version: number;
  readonly release: Release;
}

/** What an alias resolved to in the release. */
export interface Resolved {
  readonly alias: string;
  readonly declared: BoundWorkflow;
  /** The workflow the seal binds the alias to, if any. */
  readonly workflowId: string | undefined;
  readonly fingerprint: string;
}

/**
 * The App `app` as `by` may use it now, and its current release: none
 * for someone without a role in it, an archived App, a version not sealed
 * or revoked.
 */
const askingOf = async (
  env: Env,
  by: Pick<Identity, "userId" | "role" | "teams"> &
    Partial<Pick<Identity, "staff">>,
  app: unknown
): Promise<Asking> => {
  const found = await usableApp(env, by, app);
  if (found.currentVersion === null) {
    throw versionErrors.create("version.not_sealed");
  }
  const id = appIdSchema.parse(found.id);
  await requireNotRevoked(env, id, found.currentVersion);
  return {
    by,
    app: id,
    version: found.currentVersion,
    release: await loadRelease(env, id, found.currentVersion),
  };
};

/** The workflow `alias` declares in `release`, with its fingerprint. */
const declaredIn = async (
  release: Release,
  alias: string
): Promise<{ declared: BoundWorkflow; fingerprint: string } | undefined> => {
  const declared = declaredWorkflows(release.app, release.workflows).find(
    (workflow) => workflow.alias === alias
  );
  return declared === undefined
    ? undefined
    : { declared, fingerprint: await workflowFingerprint(declared) };
};

/**
 * What `alias` names in `release`: a workflow it declares, resolved by
 * name in the release that answers, as an App's functions are
 * (`function.not_found` otherwise). For an App's tests too, against the
 * release under test (fixture-runs.ts).
 */
export const resolvedIn = async (
  release: Release,
  alias: string
): Promise<Resolved> => {
  const found = await declaredIn(release, alias);
  if (found === undefined) {
    throw functionErrors.create("function.not_found");
  }
  return { alias, ...found, workflowId: found.declared.workflowId };
};

/**
 * `value` checked by `descriptor`, normalized: a call's arguments
 * (`contract.invalid_args` otherwise) or an answer about to leave, which
 * must already be in the form its descriptor gives it
 * (`contract.invalid_return`).
 */
export const checkedValue = (
  descriptor: unknown,
  value: unknown,
  code: "contract.invalid_args" | "contract.invalid_return"
): Json => {
  const schema = schemaFromDescriptor(JSON.stringify(descriptor));
  const result = schema["~standard"].validate(value);
  if (result instanceof Promise || result.issues !== undefined) {
    throw functionErrors.create(code);
  }
  // SAFETY: what a descriptor admits is JSON.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const normalized = result.value as Json;
  if (
    code === "contract.invalid_return" &&
    canonicalText(normalized) !== canonicalText(value)
  ) {
    throw functionErrors.create(code);
  }
  return normalized;
};

/** The workflow `resolved` binds: refused when the seal binds none. */
export const boundWorkflowOf = (resolved: Resolved): string => {
  if (resolved.workflowId === undefined) {
    throw workflowResourceErrors.create("workflow.app_binding_unavailable");
  }
  return resolved.workflowId;
};

/**
 * That the asking person may start workflow `workflowId` through the App's binding of
 * `alias` now, as SQL: an App's start's own rule, and the binding in force.
 */
const mayStartSql = (
  asking: Asking,
  alias: string,
  workflowId: string
): SQL => {
  const workflow = workflowResourceIdSchema.safeParse(workflowId);
  if (!workflow.success) {
    return sql`0`;
  }
  return sql`(${appStartHoldsSql(
    asking.app,
    asking.version,
    asking.by.userId,
    workflow.data
  )} AND ${bindingNamesSql(asking.app, alias, workflowId)})`;
};

/**
 * That the asking person may send events to their runs of `workflowId` through
 * the App's binding of `alias` now, as SQL: the App's `send` grant, by
 * `mayStartSql`'s rule otherwise.
 */
const maySendSql = (asking: Asking, alias: string, workflowId: string): SQL => {
  const workflow = workflowResourceIdSchema.safeParse(workflowId);
  if (!workflow.success) {
    return sql`0`;
  }
  return sql`(${appSendHoldsSql(
    asking.app,
    asking.version,
    asking.by.userId,
    workflow.data
  )} AND ${bindingNamesSql(asking.app, alias, workflowId)})`;
};

/** Whether `condition` holds now. */
const holds = async (env: Env, condition: SQL): Promise<boolean> => {
  const row = await drizzle(env.DB).get<{ holds: number }>(
    sql`SELECT ${condition} AS holds`
  );
  return row.holds === 1;
};

/** The App's authority for the asking person, at its current version. */
const authorityOf = (asking: Asking): Authority => ({
  subject: { type: "app", appId: asking.app },
  onBehalfOf: asking.by.userId,
  mode: "interactive",
  appVersion: asking.version,
});

/** A run the asking person sees, and the App version that started it. */
interface SeenRun {
  readonly row: RunRow;
  readonly originAppVersion: number | null;
}

/**
 * That a decision of the run in the statement asks `asking`'s person now,
 * as SQL: one still pending they may answer (`answerableByNow`), never for
 * staff, and only where the run's restricted mode is the App's
 * (`appRestricted`), as answering it requires (page-decisions.ts,
 * `appDecision`). What lets a reviewer watch the run they decide on.
 */
const askedNowSql = (env: Env, asking: Asking, appRestricted: boolean): SQL => {
  if (asking.by.staff === true) {
    return sql`0`;
  }
  const db = drizzle(env.DB);
  return (
    and(
      eq(workflowResourceRuns.restricted, appRestricted),
      exists(
        db
          .select({ one: sql`1` })
          .from(workflowDecisions)
          .where(
            and(
              eq(workflowDecisions.resourceRunId, workflowResourceRuns.id),
              resourceDecisionPending(new Date()),
              answerableByNow(db, asking.by.userId)
            )
          )
      )
    ) ?? sql`0`
  );
};

/**
 * Run `runId`, if the asking App started it for the asking person and it
 * acts for them, of workflow `workflowId`, whichever version it runs, while
 * the App's binding names that workflow:
 * `workflow.run_unavailable` for any other, one that doesn't exist alike.
 * With `watching`, for a snapshot alone, also a run of the App's that one
 * of its decisions asks the person to answer now (`askedNowSql`): never
 * to control it or send it events, which stay its own person's.
 */
const seenRun = async (
  env: Env,
  asking: Asking,
  alias: string,
  workflowId: string,
  runId: string,
  watching?: { readonly appRestricted: boolean }
): Promise<SeenRun> => {
  const own = and(
    eq(workflowStartReceipts.principalId, asking.by.userId),
    eq(workflowResourceRuns.principalId, asking.by.userId)
  );
  const found = await drizzle(env.DB)
    .select({
      id: workflowResourceRuns.id,
      originAppVersion: workflowStartReceipts.originAppVersion,
    })
    .from(workflowResourceRuns)
    .innerJoin(
      workflowStartReceipts,
      eq(workflowStartReceipts.id, workflowResourceRuns.id)
    )
    .where(
      and(
        eq(workflowResourceRuns.id, runId),
        eq(workflowStartReceipts.invokerType, "app"),
        eq(workflowStartReceipts.invokerId, asking.app),
        watching === undefined
          ? own
          : or(own, askedNowSql(env, asking, watching.appRestricted)),
        eq(workflowResourceRuns.workflowResourceId, workflowId),
        bindingNamesSql(asking.app, alias, workflowId)
      )
    )
    .get();
  const row = found === undefined ? undefined : await runOf(env, found.id);
  if (found === undefined || row === undefined) {
    throw workflowResourceErrors.create("workflow.run_unavailable");
  }
  return { row, originAppVersion: found.originAppVersion };
};

/** Whether a run in `status` has ended. */
const isEnded = (status: RunRow["status"]): boolean =>
  !unended.includes(status);

/**
 * Run `row` as it is now, and the control a page sees applying on it:
 * its cancel if one is asked, which has priority, otherwise the pause or
 * resume unresolved; none once it has ended. Read in one batch, so both
 * are of one moment.
 */
const runAndPending = async (
  env: Env,
  row: RunRow
): Promise<[RunRow, ResourceControlRow["kind"] | undefined]> => {
  const db = drizzle(env.DB);
  const [rows, admitted] = await db.batch([
    db
      .select()
      .from(workflowResourceRuns)
      .where(eq(workflowResourceRuns.id, row.id)),
    db
      .select({ kind: workflowResourceRunControls.kind })
      .from(workflowResourceRunControls)
      .where(
        and(
          eq(workflowResourceRunControls.runId, row.id),
          eq(workflowResourceRunControls.state, "admitted")
        )
      ),
  ]);
  const now = rows[0] ?? row;
  if (isEnded(now.status)) {
    return [now, undefined];
  }
  const kinds = admitted.map(({ kind }) => kind);
  return [
    now,
    kinds.includes("cancel")
      ? "cancel"
      : kinds.find((kind) => kind !== "cancel"),
  ];
};

/** Why a run compensates, as its row keeps it (resource-runs.ts). */
const compensationSchema = z.object({
  cause: z.enum(["failure", "cancellation"]),
  code: z.string().nullable(),
});

/**
 * Run `row`'s compensation while the engine rolls it back (spec 10.7.3):
 * why, from its row; none once it ended, or while it doesn't.
 */
const compensationOf = (
  row: RunRow
): z.infer<typeof compensationSchema> | undefined =>
  row.status === "running" && row.compensation !== null
    ? compensationSchema.safeParse(JSON.parse(row.compensation)).data
    : undefined;

/** A run's status, as a page sees it. */
const statusOf = {
  starting: "queued",
  running: "running",
  paused: "paused",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
} as const;

/**
 * The release of App `app`'s `version` that started a run: one no longer
 * readable (retention removed it, or it was revoked or no longer matches
 * what was sealed) leaves the run as one this page can't see
 * (`workflow.run_unavailable`), never a `version.*` refusal, which the
 * page would take for its own release having changed.
 */
const originRelease = async (
  env: Env,
  app: AppId,
  version: number
): Promise<Release> => {
  try {
    return await loadRelease(env, app, version);
  } catch (error) {
    if (versionErrors.codeOf(error) !== undefined) {
      throw workflowResourceErrors.create("workflow.run_unavailable");
    }
    throw error;
  }
};

/**
 * That the App version that started a run declared `alias` under the
 * contract the asking release does (`workflow.run_unavailable`
 * otherwise): a run of another contract is never shown through this
 * one's `run` query, whose output, waits and events it would not fit.
 */
const requireSameContract = async (
  env: Env,
  asking: Asking,
  resolved: Resolved,
  originAppVersion: number | null
): Promise<void> => {
  if (originAppVersion === null) {
    throw workflowResourceErrors.create("workflow.run_unavailable");
  }
  const started =
    originAppVersion === asking.version
      ? resolved
      : await declaredIn(
          await originRelease(env, asking.app, originAppVersion),
          resolved.alias
        );
  if (started?.fingerprint !== resolved.fingerprint) {
    throw workflowResourceErrors.create("workflow.run_unavailable");
  }
};

/**
 * Which of `versions`, versions of App `app` that started runs of `alias`,
 * a page of `release` can follow such a run of: one whose release still
 * loads and declares `alias` under the contract `release` declares it
 * with. A run any other version started is not shown
 * (`requireSameContract`).
 */
export const followableOrigins = async (
  env: Env,
  app: AppId,
  release: Release,
  alias: string,
  versions: ReadonlySet<number>
): Promise<ReadonlySet<number>> => {
  const current = await declaredIn(release, alias);
  if (current === undefined) {
    return new Set();
  }
  const fingerprintOf = async (
    version: number
  ): Promise<string | undefined> => {
    if (version === release.manifest.resourceVersion) {
      return current.fingerprint;
    }
    try {
      const origin = await originRelease(env, app, version);
      const started = await declaredIn(origin, alias);
      return started?.fingerprint;
    } catch (error) {
      if (workflowResourceErrors.codeOf(error) === undefined) {
        throw error;
      }
      return undefined;
    }
  };
  // One read per App version on a page: a handful at most.
  const checked = await Promise.all(
    [...versions].map(async (version) => ({
      version,
      fingerprint: await fingerprintOf(version),
    }))
  );
  return new Set(
    checked
      .filter(({ fingerprint }) => fingerprint === current.fingerprint)
      .map(({ version }) => version)
  );
};

/** What a step's failure reads as when its own words can't be shown. */
const stepFailed = workflowErrors.create("workflow.step_failed");

/**
 * What a failed run's snapshot says of why: a code the platform defines,
 * with the platform's own words for it; a raise's code (an `AppError`
 * code, outside the platform's namespaces), with its words, since a run
 * fails with such a code only as a raise its build seals, with that
 * raise's sealed message (sealed-run.ts, `runFailure`): text the
 * workflow's builder wrote, never what the run read; any other as
 * `workflow.step_failed`. Neither the engine's message for anything else
 * nor a code merely in a platform namespace leaves: either can be made of
 * what the run read through grants the App doesn't hold.
 */
export const failureOf = (
  error: { code: string | null; message?: string } | undefined
) => {
  const given = error?.code ?? undefined;
  const raised =
    given !== undefined &&
    isAppErrorCode(given) &&
    typeof error?.message === "string";
  let code: string = stepFailed.code;
  if (given !== undefined && (raised || isExpectedCode(given))) {
    code = given;
  }
  return {
    code,
    message:
      expectedMessageOf(code) ??
      (raised ? (error?.message ?? stepFailed.message) : stepFailed.message),
    category: categoryOf(code),
    retryable: isRetryableCode(code),
    requestId: null,
  };
};

/**
 * A compensating run's snapshot's compensation (spec 10.7.3): its cause,
 * its cleanup's activity (the engine reports it running), and, after a
 * failure, what it failed with, as a failed run says it; none otherwise.
 */
const compensationShown = (
  compensation: z.infer<typeof compensationSchema> | undefined
): { compensation?: Json } =>
  compensation === undefined
    ? {}
    : {
        compensation: {
          cause: compensation.cause,
          activity: "running",
          ...(compensation.cause === "failure"
            ? { originalError: failureOf({ code: compensation.code }) }
            : {}),
        },
      };

/**
 * What a completed run returned, projected by the `returns` the App declared:
 * `contract.invalid_return` for anything else, `workflow.run_details_removed`
 * past its retention.
 */
export const resultAsDeclared = (declared: unknown, result: unknown): Json => {
  if (result === undefined) {
    // The contract has a completed run's result, always: past its
    // retention, there is none to show.
    throw workflowResourceErrors.create("workflow.run_details_removed");
  }
  const checked = schemaFromDescriptor(JSON.stringify(declared))[
    "~standard"
  ].validate(result);
  if (checked instanceof Promise || checked.issues !== undefined) {
    throw functionErrors.create("contract.invalid_return");
  }
  const projected = z.json().safeParse(checked.value);
  if (!projected.success) {
    throw functionErrors.create("contract.invalid_return");
  }
  return projected.data;
};

/**
 * What run `row` waits on now, while it runs or is paused (run-waits.ts),
 * as the release's binding of its workflow (`resolved`) names it, events
 * the person may send it now (`canSend`) sendable.
 */
const waitsOf = async (
  env: Env,
  row: RunRow,
  resolved: Resolved,
  canSend: boolean
): Promise<Json[]> =>
  row.status === "running" || row.status === "paused"
    ? await runWaits(
        env,
        {
          id: row.id,
          workflowId: row.workflowResourceId,
          version: row.version,
          manifestHash: row.manifestHash,
        },
        resolved.declared,
        canSend
      )
    : [];

/** A decision wait the viewer may answer, as `withRespond` marks one. */
const answerableDecision = z.looseObject({
  kind: z.literal("decision"),
  canRespond: z.literal(true),
});

/** Whether `wait` is a decision the viewer may answer (`withRespond`). */
const isAnswerableDecision = (wait: Json): boolean =>
  answerableDecision.safeParse(wait).success;

/**
 * A run's status as its snapshot shows it: a running run held for its AI
 * provider (ai-waits.ts) shows queued, as its summary does, since it goes
 * on by itself once calls work; never with a wait open (`openWaits`),
 * which a queued run has none of.
 */
const shownStatus = async (
  env: Env,
  row: RunRow,
  openWaits: number
): Promise<(typeof statusOf)[keyof typeof statusOf]> => {
  if (row.status !== "running" || openWaits > 0) {
    return statusOf[row.status];
  }
  const held = await aiWaitsOf(drizzle(env.DB), [row.id]);
  return held.has(row.id) ? "queued" : "running";
};

/**
 * What run `row` waits on, as `asking` is shown it in its snapshot: its
 * events sendable while they may send it one, and never from a restricted
 * App into a run that isn't restricted itself, as a send refuses it
 * (`permission.restricted`); its decisions answerable as they may answer
 * them there (`withRespond`).
 */
const snapshotWaits = async (
  env: Env,
  asking: Asking,
  resolved: Resolved,
  row: RunRow,
  appRestricted: boolean
): Promise<Json[]> => {
  const own = row.principalId === asking.by.userId;
  const canSend =
    own &&
    !isEnded(row.status) &&
    !(appRestricted && !row.restricted) &&
    (await holds(
      env,
      maySendSql(asking, resolved.alias, boundWorkflowOf(resolved))
    ));
  const waits = await withRespond(
    env,
    row.id,
    await waitsOf(env, row, resolved, canSend),
    {
      userId: asking.by.userId,
      ...(asking.by.staff === true ? { staff: true } : {}),
      sameRestriction: row.restricted === appRestricted,
    }
  );
  // A reviewer watching a run they decide on (`seenRun`'s `watching`)
  // sees only the decisions asking them: nothing else it waits on.
  return own ? waits : waits.filter(isAnswerableDecision);
};

/**
 * What a page may ask of run `row` now: nothing that pauses, resumes or
 * cuts its compensation short (spec 10.7.3), nor what the person may no
 * longer start (`mayStart`), nor anything past a control applying.
 */
const controlOf = (
  row: RunRow,
  {
    pending,
    mayStart,
    compensating,
  }: {
    pending: ResourceControlRow["kind"] | undefined;
    mayStart: boolean;
    compensating: boolean;
  }
): Json => {
  const free = mayStart && !compensating;
  return {
    canPause:
      free &&
      pending === undefined &&
      (row.status === "starting" || row.status === "running"),
    canResume: free && pending === undefined && row.status === "paused",
    canCancel: free && !isEnded(row.status) && pending !== "cancel",
    pendingControl:
      pending === undefined ? null : { kind: pending, stage: "applying" },
  };
};

/**
 * Refuses (`workflow.run_unavailable`) run `row` to a reviewer once it has
 * ended: they watch it only while a decision of it asks them, which a run
 * that goes on has, so one that ended since `seenRun` admitted them never
 * hands them its output or its error.
 */
const requireWatchable = (row: RunRow, asking: Asking): void => {
  if (isEnded(row.status) && row.principalId !== asking.by.userId) {
    throw workflowResourceErrors.create("workflow.run_unavailable");
  }
};

/**
 * What a reviewer watching run `row` sees (`seenRun`'s widened access,
 * while a decision of it asks them): who the run is, its status as its row
 * says, when it started, the waits they may see and no control. Named
 * field by field, so nothing a snapshot says of the run's outcome (what
 * it returned, why it failed, what it rolls back after and why) reaches
 * them, now or as the snapshot grows: that is its own person's alone.
 */
const watchedSnapshot = (
  row: RunRow,
  waits: Json[],
  pending: ResourceControlRow["kind"] | undefined
): Json => {
  const status = statusOf[row.status];
  return {
    runId: row.id,
    workflowId: row.workflowResourceId,
    workflowVersion: row.version,
    manifestHash: row.manifestHash,
    status,
    startedAt: status === "queued" ? null : row.createdAt.getTime(),
    finishedAt: null,
    waits,
    control: {
      canPause: false,
      canResume: false,
      canCancel: false,
      pendingControl:
        pending === undefined ? null : { kind: pending, stage: "applying" },
    },
  };
};

/**
 * Run `runId`'s snapshot for the asking person: one read of the run, its
 * status and what they may do with it together.
 */
const runSnapshot = async (
  env: Env,
  asking: Asking,
  resolved: Resolved,
  runId: string
): Promise<Json> => {
  const workflowId = boundWorkflowOf(resolved);
  const appRestricted = await appHost(env, asking.app).isRestricted();
  const seen = await seenRun(env, asking, resolved.alias, workflowId, runId, {
    appRestricted,
  });
  await requireSameContract(env, asking, resolved, seen.originAppVersion);
  // The run and the control it has applying, read together: one moment
  // of it.
  const [row, pending] = await runAndPending(env, seen.row);
  requireWatchable(row, asking);
  const compensation = compensationOf(row);
  const waits = await snapshotWaits(env, asking, resolved, row, appRestricted);
  const status =
    compensation === undefined
      ? await shownStatus(env, row, waits.length)
      : "compensating";
  if (row.principalId !== asking.by.userId) {
    return watchedSnapshot(row, waits, pending);
  }
  const mayStart = await holds(
    env,
    mayStartSql(asking, resolved.alias, workflowId)
  );
  const returned =
    row.status === "completed" ||
    row.status === "failed" ||
    compensation?.cause === "failure";
  if (returned && row.restricted && !appRestricted) {
    // What a restricted run returned, or why it failed, only to an App in
    // restricted mode itself: never out through one that isn't.
    throw permissionErrors.create("permission.restricted");
  }
  const result = returned ? await resultOf(env, row) : {};
  const completed =
    row.status === "completed"
      ? resultAsDeclared(resolved.declared.returns, result.result)
      : undefined;
  return {
    runId: row.id,
    workflowId: row.workflowResourceId,
    workflowVersion: row.version,
    manifestHash: row.manifestHash,
    status,
    startedAt: row.status === "starting" ? null : row.createdAt.getTime(),
    finishedAt: row.endedAt === null ? null : row.endedAt.getTime(),
    waits,
    control: controlOf(row, {
      pending,
      mayStart,
      compensating: compensation !== undefined,
    }),
    ...(completed === undefined ? {} : { result: completed }),
    ...(row.status === "failed" ? { error: failureOf(result.error) } : {}),
    // Compensating after a failure: what it failed with, as a failed run
    // says it; its cleanup's activity, which the engine reports as running.
    ...compensationShown(compensation),
  };
};

/** A start of `resolved` with `args` under `key`, admitted: its run's handle. */
const started = async (
  env: Env,
  asking: Asking,
  resolved: Resolved,
  args: Json,
  key: string
): Promise<Json> => {
  const workflowId = boundWorkflowOf(resolved);
  const start = await startAppBinding(
    env,
    authorityOf(asking),
    resolved.alias,
    { args, key: coreStartKey("page", key) },
    undefined,
    // The binding still names the workflow the release's seal binds.
    bindingNamesSql(asking.app, resolved.alias, workflowId),
    undefined,
    null,
    // The App's files the person may read now, which its run gets copies of.
    appStartFiles(env, asking.by.userId, asking.app, asking.release, {
      kind: "page",
      agent: null,
    })
  );
  return {
    runId: start.id,
    workflowId: start.workflowId,
    workflowVersion: start.version,
    manifestHash: start.manifestHash,
  };
};

/** Run `runId`'s control receipts, settled or not. */
const receiptsOf = async (
  env: Env,
  runId: string
): Promise<ResourceControlRow[]> =>
  await drizzle(env.DB)
    .select()
    .from(workflowResourceRunControls)
    .where(eq(workflowResourceRunControls.runId, runId));

/** A key a pause or resume of a run was asked under, and its receipt. */
type ControlKey = typeof workflowResourceRunControlKeys.$inferSelect;

/** The keys run `runId`'s pauses and resumes were asked under. */
const keysOf = async (env: Env, runId: string): Promise<ControlKey[]> =>
  await drizzle(env.DB)
    .select()
    .from(workflowResourceRunControlKeys)
    .where(eq(workflowResourceRunControlKeys.runId, runId));

/**
 * The receipt a request for `kind` under `key` was answered before, if
 * any: a cancel's, whatever its key; a pause's or resume's, its own or the
 * one it joined, as its key has it.
 */
const answeredBefore = (
  receipts: readonly ResourceControlRow[],
  keys: readonly ControlKey[],
  kind: ResourceControlRow["kind"],
  key: string
): ResourceControlRow | undefined => {
  if (kind === "cancel") {
    return receipts.find((receipt) => receipt.kind === "cancel");
  }
  const keyed = keys.find((each) => each.kind === kind && each.key === key);
  return keyed === undefined
    ? receipts.find((receipt) => receipt.kind === kind && receipt.key === key)
    : receipts.find(({ id }) => id === keyed.receiptId);
};

/**
 * Keeps `key` of a pause or resume that joined `receipt`, unresolved, of
 * run `runId`, and answers the receipt the key has: `receipt`, or the one
 * a request under the same key was given first, by the key's uniqueness.
 */
const joinKey = async (
  env: Env,
  runId: string,
  kind: "pause" | "resume",
  key: string,
  receipt: ResourceControlRow
): Promise<ResourceControlRow> => {
  try {
    await drizzle(env.DB)
      .insert(workflowResourceRunControlKeys)
      .values({ runId, kind, key, receiptId: receipt.id });
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
  }
  const [receipts, keys] = await Promise.all([
    receiptsOf(env, runId),
    keysOf(env, runId),
  ]);
  return answeredBefore(receipts, keys, kind, key) ?? receipt;
};

/** Where the engine has a run as its controls are decided. */
type Live = Awaited<ReturnType<ReturnType<typeof runEngine>["status"]>>;

/** Engine statuses of a run that has ended. */
const endedLive = new Set(["complete", "errored", "terminated"]);

/** What a page's request for a control of a run comes to. */
type Admission =
  | { type: "admit" }
  | { type: "done" }
  | { type: "answer"; receipt: ResourceControlRow }
  | { type: "join"; receipt: ResourceControlRow }
  | {
      type: "refused";
      code:
        | "workflow.control_conflict"
        | "workflow.control_refused"
        | "workflow.control_rolling_back";
    };

/**
 * What a request for `kind` of run `row` under `key` comes to, with the
 * run's receipts and the keys they were asked under, and where the engine
 * has it (`live`; nothing when it has no record yet, or couldn't say for a
 * cancel). See the header.
 */
const admissionOf = (
  row: RunRow,
  receipts: readonly ResourceControlRow[],
  keys: readonly ControlKey[],
  kind: ResourceControlRow["kind"],
  key: string,
  live: Live
): Admission => {
  // The same request again (a cancel under any key), settled or not: what
  // it was answered first, the receipt it joined included.
  const same = answeredBefore(receipts, keys, kind, key);
  if (same !== undefined) {
    return { type: "answer", receipt: same };
  }
  const unresolved = receipts.filter(({ state }) => state === "admitted");
  const joined = unresolved.find((receipt) => receipt.kind === kind);
  if (joined !== undefined) {
    return { type: "join", receipt: joined };
  }
  if (live?.status === "rollingBack") {
    return { type: "refused", code: "workflow.control_rolling_back" };
  }
  if (kind === "cancel") {
    if (!isEnded(row.status)) {
      return { type: "admit" };
    }
    // Nothing to stop: a cancelled run's cancel is done; any other end
    // can't be undone.
    return row.status === "cancelled"
      ? { type: "done" }
      : { type: "refused", code: "workflow.control_refused" };
  }
  if (
    isEnded(row.status) ||
    (live !== undefined && endedLive.has(live.status))
  ) {
    return { type: "refused", code: "workflow.control_refused" };
  }
  if (unresolved.length > 0) {
    // A cancel asked, or the other of pause and resume unresolved.
    return { type: "refused", code: "workflow.control_conflict" };
  }
  const paused =
    live?.status === "paused" || live?.status === "waitingForPause";
  const already = kind === "pause" ? live?.status === "paused" : !paused;
  return already ? { type: "done" } : { type: "admit" };
};

/** What a page's pause or resume is audited as. */
const requestedAction = {
  pause: "workflow.run.pause_requested",
  resume: "workflow.run.resume_requested",
} as const;

/**
 * Writes the receipt for `kind` of run `row` under `key`, only while the
 * person may still start the workflow through the binding and nobody
 * admitted a control of the run since `row` was read, read in the
 * statements that write it: admitted under the run's next control
 * generation, the run's pages read again (`tellQueryFollowers`); or, for a request the run is
 * already past (`done`), applied at once under the current one. A cancel
 * takes the next generation too, so a pause or resume admitted before it
 * is superseded unsent (resource-runs.ts, `applyResourceControl`), or by
 * the run's end at the latest. A pause or resume is audited as asked, under the App's page, naming the
 * person (a cancel's stop is, as it is first asked: `applyCancel`).
 * Whether it was written.
 */
const writeReceipt = async (
  env: Env,
  asking: Asking,
  may: SQL,
  row: RunRow,
  kind: ResourceControlRow["kind"],
  key: string,
  done: boolean
): Promise<string | undefined> => {
  const db = drizzle(env.DB);
  const id = crypto.randomUUID();
  const now = Date.now();
  const generation = done ? row.controlGeneration : row.controlGeneration + 1;
  // Every column by its name, in the table's order: drizzle refuses a
  // select that doesn't match the table, so a column the table gains (or
  // one moved) fails here, never takes a value meant for another.
  const insert = (condition: SQL) =>
    db.insert(workflowResourceRunControls).select(
      db
        .select({
          id: sql<string>`${id}`.as("id"),
          runId: workflowResourceRuns.id,
          appId: sql<string>`${asking.app}`.as("app_id"),
          principalId: sql<string>`${asking.by.userId}`.as("principal_id"),
          key: sql<string>`${key}`.as("key"),
          kind: sql<ResourceControlRow["kind"]>`${kind}`.as("kind"),
          state: sql<
            ResourceControlRow["state"]
          >`${done ? "applied" : "admitted"}`.as("state"),
          createdAt: sql<Date>`${now}`.as("created_at"),
          settledAt: sql<Date | null>`${done ? now : null}`.as("settled_at"),
          attempts: sql<number>`0`.as("attempts"),
          nextAt: sql<Date>`${now + cancelRepairAfterMs}`.as("next_at"),
          stopRequestedAt: sql<Date | null>`NULL`.as("stop_requested_at"),
          generation: sql<number>`${generation}`.as("generation"),
        })
        .from(workflowResourceRuns)
        .where(and(eq(workflowResourceRuns.id, row.id), condition))
    );
  const written = sql`EXISTS (SELECT 1 FROM ${workflowResourceRunControls} WHERE ${workflowResourceRunControls.id} = ${id})`;
  // A pause's or resume's key, with its receipt, in the same batch: a key
  // another request took first (one that joined) fails the whole write.
  const keyed =
    kind === "cancel"
      ? []
      : [
          db.insert(workflowResourceRunControlKeys).select(
            db
              .select({
                runId: workflowResourceRunControls.runId,
                kind: sql<"pause" | "resume">`${kind}`.as("kind"),
                key: sql<string>`${key}`.as("key"),
                receiptId: workflowResourceRunControls.id,
              })
              .from(workflowResourceRunControls)
              .where(eq(workflowResourceRunControls.id, id))
          ),
        ];
  const entry: AuditEntry | undefined =
    kind === "cancel"
      ? undefined
      : {
          ...runEntry(row, requestedAction[kind]),
          actor: { type: "app", appId: asking.app, part: "page" },
          detail: {
            ...runEntry(row, requestedAction[kind]).detail,
            onBehalfOf: asking.by.userId,
            control: id,
            // The run already where it asked: applied as it was written.
            ...(done ? { already: true } : {}),
          },
        };
  const unchanged = and(
    eq(workflowResourceRuns.id, row.id),
    eq(workflowResourceRuns.controlGeneration, row.controlGeneration),
    inArray(workflowResourceRuns.status, unended)
  );
  try {
    await (done
      ? auditedBatch(env, db, [
          insert(
            sql`${may} AND EXISTS (SELECT 1 FROM ${workflowResourceRuns} WHERE ${and(eq(workflowResourceRuns.id, row.id), eq(workflowResourceRuns.controlGeneration, row.controlGeneration))})`
          ),
          ...keyed,
          ...(entry === undefined ? [] : [outboxedWhere(db, entry, written)]),
        ])
      : auditedBatch(env, db, [
          db
            .update(workflowResourceRuns)
            .set({
              controlGeneration: generation,
              summaryRevision: sql`${workflowResourceRuns.summaryRevision} + 1`,
            })
            .where(and(unchanged, may)),
          insert(sql`changes() > 0`),
          ...keyed,
          ...(entry === undefined ? [] : [outboxedWhere(db, entry, written)]),
        ]));
  } catch (error) {
    // A twin written first (a cancel under any key, a pause or resume
    // under this one, its own or joined to another): answered by the caller, its audit with it unwritten.
    // The unique indexes are the guard, as the generation is none for a
    // request the run is already past.
    if (!isUniqueViolation(error)) {
      throw error;
    }
  }
  const found = await db
    .select({ id: workflowResourceRunControls.id })
    .from(workflowResourceRunControls)
    .where(eq(workflowResourceRunControls.id, id))
    .get();
  return found?.id;
};

/** A control a page asks of a run, under the call's key. */
interface Control {
  readonly kind: ResourceControlRow["kind"];
  readonly runId: string;
  readonly key: string;
}

/** What deciding a control comes to: a receipt, done at once, or refused. */
type Decided =
  | { type: "receipt"; receipt: ResourceControlRow }
  | { type: "applied" }
  | {
      type: "refused";
      code:
        | "workflow.control_conflict"
        | "workflow.control_refused"
        | "workflow.control_rolling_back"
        | "workflow.start_denied";
    };

/**
 * Decides `command` of run `row` as it is (see the header): the receipt
 * it is answered, written now or found; a cancel of a cancelled run done;
 * or why it is refused.
 */
const decide = async (
  env: Env,
  asking: Asking,
  may: SQL,
  row: RunRow,
  command: Control
): Promise<Decided> => {
  const { kind } = command;
  // The receipts before the engine, both after `row`: a control admitted
  // since `row` moved the run's generation on, so the write below fails;
  // one admitted before it is either unresolved here (joined or a
  // conflict) or settled, which only happens once the engine took it, so
  // the status read after shows it. Read the other way round, a control
  // settling between the two reads would make the run look already past
  // a request it isn't, and that request be applied at once unsent.
  const [receipts, keys] = await Promise.all([
    receiptsOf(env, row.id),
    keysOf(env, row.id),
  ]);
  let live: Live;
  if (!isEnded(row.status)) {
    try {
      live = await runEngine(env).status(row.id);
    } catch (error) {
      // A cancel goes ahead without the engine's word, as it always has;
      // a pause or resume needs it to know what the run is past.
      if (kind !== "cancel") {
        throw error;
      }
    }
  }
  const admission = admissionOf(row, receipts, keys, kind, command.key, live);
  if (admission.type === "refused") {
    return admission;
  }
  if (admission.type === "answer") {
    return { type: "receipt", receipt: admission.receipt };
  }
  if (admission.type === "join" && kind !== "cancel") {
    return {
      type: "receipt",
      receipt: await joinKey(env, row.id, kind, command.key, admission.receipt),
    };
  }
  if (admission.type === "done" && kind === "cancel") {
    return { type: "applied" };
  }
  const written = await writeReceipt(
    env,
    asking,
    may,
    row,
    kind,
    command.key,
    admission.type === "done"
  );
  const [after, afterKeys] = await Promise.all([
    receiptsOf(env, row.id),
    keysOf(env, row.id),
  ]);
  // Its own; or a twin written first, under this key (its own or joined
  // to another) or, a cancel's, another; or one of its kind admitted
  // meanwhile under another key, which it joins, keeping its key.
  let receipt =
    after.find(({ id }) => id === written) ??
    answeredBefore(after, afterKeys, kind, command.key);
  const unresolved = after.find(
    (each) => each.kind === kind && each.state === "admitted"
  );
  if (receipt === undefined && unresolved !== undefined) {
    receipt =
      kind === "cancel"
        ? unresolved
        : await joinKey(env, row.id, kind, command.key, unresolved);
  }
  if (receipt === undefined) {
    // Another control admitted meanwhile, or the person may no longer.
    const stillMay = await holds(env, may);
    return {
      type: "refused",
      code: stillMay ? "workflow.control_conflict" : "workflow.start_denied",
    };
  }
  if (receipt.id === written) {
    await tellQueryFollowers(env, row.id);
  }
  return { type: "receipt", receipt };
};

/** Audits a page's control of run `row` refused for `code`. */
const auditRefused = async (
  env: Env,
  asking: Asking,
  row: RunRow,
  kind: ResourceControlRow["kind"],
  code: string
): Promise<void> => {
  const db = drizzle(env.DB);
  const entry = runEntry(row, "workflow.run.control_refused");
  await auditedBatch(env, db, [
    outboxed(db, {
      ...entry,
      actor: { type: "app", appId: asking.app, part: "page" },
      detail: { ...entry.detail, kind, code, onBehalfOf: asking.by.userId },
    }),
  ]);
};

/**
 * The control `command` asks of a run, decided (see the header): its
 * receipt, admitted and applied at once, or answered again; a refusal
 * throws.
 */
const controlled = async (
  env: Env,
  asking: Asking,
  resolved: Resolved,
  command: Control
): Promise<Json> => {
  const workflowId = boundWorkflowOf(resolved);
  const { row } = await seenRun(
    env,
    asking,
    resolved.alias,
    workflowId,
    command.runId
  );
  const { kind } = command;
  const may = mayStartSql(asking, resolved.alias, workflowId);
  let receipt: ResourceControlRow | undefined;
  // A cancel that lost its write to a control admitted at once is decided
  // again, once, against the run as it is then: a cancel always wins.
  for (let attempt = 0; receipt === undefined; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- once more at most
    const current = attempt === 0 ? row : ((await runOf(env, row.id)) ?? row);
    // oxlint-disable-next-line no-await-in-loop -- once more at most
    const decided = await decide(env, asking, may, current, command);
    if (decided.type === "applied") {
      return { kind, state: "applied" };
    }
    if (decided.type === "receipt") {
      ({ receipt } = decided);
    } else if (
      kind !== "cancel" ||
      attempt > 0 ||
      decided.code !== "workflow.control_conflict"
    ) {
      // oxlint-disable-next-line no-await-in-loop -- refused: the last turn
      await auditRefused(env, asking, current, kind, decided.code);
      throw decided.code === "workflow.start_denied"
        ? workflowResourceErrors.create(decided.code)
        : workflowErrors.create(decided.code);
    }
  }
  if (receipt.state === "admitted") {
    try {
      await (receipt.kind === "cancel"
        ? applyCancel(env, receipt, row.id)
        : applyResourceControl(env, receipt));
      const settled = await receiptsOf(env, row.id);
      const { id: asked } = receipt;
      receipt = settled.find(({ id }) => id === asked) ?? receipt;
    } catch (error) {
      // Admitted all the same, which is what the page is answered: the
      // repair applies it again (resource-runs.ts, `repairAdmittedCancels`).
      log.error("workflow.resource_run_control_failed", {
        runId: row.id,
        kind: receipt.kind,
        ...errorFields(error),
      });
    }
  }
  return { kind: receipt.kind, state: receipt.state };
};

/**
 * Who a page's send comes from, as its event's source: the App, the
 * release and the person the request is authenticated as, never anything
 * the request says.
 */
const sourceOf = (asking: Asking): string =>
  `urn:grasp:app:${asking.app}:version:${asking.version}:person:${encodeURIComponent(asking.by.userId)}`;

/**
 * Who a page's send counts against in a run's inbox: the App and the
 * person, whatever release, so a new release is no fresh share.
 */
const senderOf = (asking: Asking): string =>
  `app:${asking.app}:person:${asking.by.userId}`;

/**
 * The event `send` sends to the asking person's run, admitted to its
 * inbox (see the header): its ID, the same for the same key. Its
 * arguments were checked by the `send` mutation's descriptor: one of the
 * workflow's events, by alias, with the data that event declares.
 */
const sent = async (
  env: Env,
  asking: Asking,
  resolved: Resolved,
  send: {
    readonly runId: string;
    readonly event: string;
    readonly data: Json;
    readonly key: string;
  }
): Promise<Json> => {
  const workflowId = boundWorkflowOf(resolved);
  const alias = send.event;
  const declared = Object.hasOwn(resolved.declared.events, alias)
    ? resolved.declared.events[alias]
    : undefined;
  if (declared === undefined) {
    throw functionErrors.create("contract.invalid_args");
  }
  const { type } = declared;
  const { row } = await seenRun(
    env,
    asking,
    resolved.alias,
    workflowId,
    send.runId
  );
  const delivery = {
    workflowId,
    runId: row.id,
    binding: alias,
    type,
    data: send.data,
    key: send.key,
    source: sourceOf(asking),
    sender: senderOf(asking),
  };
  // Refused only once it is known the run didn't take this send already:
  // one sent again, its answer lost, is answered with its event whatever
  // changed since (`unlessAccepted`); the same key with other data is a
  // conflict.
  const refuse = async (refusal: Error) =>
    await unlessAccepted(env, delivery, refusal);
  const db = drizzle(env.DB);
  /** What a send names of the run, the workflow and the event, audited. */
  const detail = {
    workflow: workflowId,
    // The run's own: a binding follows the live version, a run keeps its.
    version: row.version,
    binding: alias,
    type,
    app: asking.app,
    appVersion: asking.version,
    via: "page",
  };
  let admitted: AdmittedEvent;
  try {
    if (!(await holds(env, maySendSql(asking, resolved.alias, workflowId)))) {
      admitted = await refuse(
        workflowResourceErrors.create("workflow.event_denied")
      );
    } else if (
      !row.restricted &&
      (await appHost(env, asking.app).isRestricted())
    ) {
      // What a restricted App's page sends may carry what it read: never
      // into a run that isn't restricted itself (restricted.ts).
      admitted = await refuse(permissionErrors.create("permission.restricted"));
    } else {
      admitted = await admitRunEvent(env, delivery, true);
    }
  } catch (error) {
    // Every send refused, the grant's, restricted mode's or the run's
    // inbox's, is recorded with why, as every send taken is; one the host
    // couldn't decide (no code it defines) is the caller's to send again.
    const code = isExpectedError(error) ? error.code : undefined;
    if (code !== undefined) {
      await auditedBatch(env, db, [
        outboxed(db, {
          actor: { type: "person", userId: asking.by.userId },
          action: "workflow.event.refused",
          target: { type: "workflow_run", id: row.id },
          detail: { ...detail, code },
        }),
      ]);
    }
    throw error;
  }
  // Every send the run took, a resend of one too: a resend may follow a
  // first answer lost before it was recorded here.
  await auditedBatch(env, db, [
    outboxed(db, {
      // The person, whose click on the App's page sent it.
      actor: { type: "person", userId: asking.by.userId },
      action: "workflow.event.sent",
      target: { type: "workflow_run", id: row.id },
      detail: {
        ...detail,
        event: admitted.id,
        redelivered: !admitted.accepted,
      },
    }),
  ]);
  return { eventId: admitted.id };
};

/** A call of a workflow mutation, as `readFunctionRequest` reads one. */
interface MutationCall {
  readonly reference: { readonly name: string; readonly kind: string };
  readonly args: unknown;
  readonly idempotencyKey?: string | undefined;
}

const mutationNames: ReadonlySet<string> = new Set<WorkflowMutationName>([
  "start",
  "pause",
  "resume",
  "cancel",
  "send",
]);

/** Whether `name` names one of a workflow reference's mutations. */
const isMutationName = (name: string): name is WorkflowMutationName =>
  mutationNames.has(name);

const startArgs = z.object({ args: z.json() });
const controlArgs = z.object({ runId: z.string() });
const sendArgs = z.object({
  runId: z.string(),
  event: z.string(),
  data: z.json(),
});

/**
 * `args`, which a mutation's descriptor already checked, read by
 * `schema`: `contract.invalid_args` for anything it doesn't take.
 */
const argsOf = <Args>(schema: z.ZodType<Args>, args: Json): Args => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    throw functionErrors.create("contract.invalid_args");
  }
  return parsed.data;
};

/**
 * Answers a page's call `call` of one of a workflow reference's mutations
 * (`workflows.<alias>.mutations.<name>`) for `by` through App `app`, as
 * the App's own mutations are answered: resolved by name in the App's
 * current release (`function.not_found`, `function.kind_mismatch`), its
 * arguments checked by the mutation's own descriptor, and kept under the
 * call's key, so a call sent again answers what the first did. A start
 * answers its run's handle, a control its receipt, a send its event's ID;
 * a refusal throws. The answer names the release it was decided under.
 */
export const answerWorkflowMutation = async (
  env: Env,
  by: Pick<Identity, "userId" | "role" | "teams"> &
    Partial<Pick<Identity, "staff">>,
  app: unknown,
  call: MutationCall
): Promise<{ value: Json; manifestHash: string }> => {
  const path = mutationPath.exec(call.reference.name)?.groups;
  const asking = await askingOf(env, by, app);
  const resolved = await resolvedIn(asking.release, path?.alias ?? "");
  const { mutations } = workflowFunctions(resolved.declared);
  const name = path?.name ?? "";
  const fn = isMutationName(name) ? mutations[name] : undefined;
  if (fn === undefined) {
    throw functionErrors.create("function.not_found");
  }
  if (call.reference.kind !== fn.kind) {
    throw functionErrors.create("function.kind_mismatch");
  }
  const args = checkedValue(fn.args, call.args, "contract.invalid_args");
  // Keyed as the App's own mutations are (function-host.ts): the client
  // sends each under one, the caller's or its own.
  const key =
    call.idempotencyKey === undefined
      ? crypto.randomUUID()
      : submissionErrors.parse(
          "submission.key_invalid",
          idempotencyKeySchema,
          call.idempotencyKey
        );
  let value: Json;
  if (name === "start") {
    value = await started(
      env,
      asking,
      resolved,
      argsOf(startArgs, args).args,
      key
    );
  } else if (name === "send") {
    value = await sent(env, asking, resolved, {
      ...argsOf(sendArgs, args),
      key,
    });
  } else if (name === "pause" || name === "resume" || name === "cancel") {
    value = await controlled(env, asking, resolved, {
      kind: name,
      runId: argsOf(controlArgs, args).runId,
      key,
    });
  } else {
    throw functionErrors.create("function.not_found");
  }
  return {
    value: checkedValue(fn.returns, value, "contract.invalid_return"),
    manifestHash: asking.release.manifestHash,
  };
};

const startCallSchema = z.strictObject({
  reference: z.strictObject({ name: z.string(), kind: z.literal("mutation") }),
  args: z.unknown(),
});

/**
 * The workflow `request` starts in `release`, and its args, checked: a
 * call's JSON text of a workflow reference's `start` mutation, as an App's
 * tests send it (fixture-runs.ts); `contract.invalid_request` for any
 * other.
 */
export const startCallIn = async (
  release: Release,
  request: unknown
): Promise<{ readonly resolved: Resolved; readonly args: Json }> => {
  let parsed: unknown;
  try {
    parsed = typeof request === "string" ? JSON.parse(request) : undefined;
  } catch {
    parsed = undefined;
  }
  const call = startCallSchema.safeParse(parsed);
  const path = call.success
    ? mutationPath.exec(call.data.reference.name)?.groups
    : undefined;
  if (!call.success || path?.alias === undefined || path.name !== "start") {
    throw functionErrors.create("contract.invalid_request");
  }
  const resolved = await resolvedIn(release, path.alias);
  const { start } = workflowFunctions(resolved.declared).mutations;
  if (start === undefined) {
    throw functionErrors.create("function.not_found");
  }
  const args = checkedValue(
    start.args,
    call.data.args,
    "contract.invalid_args"
  );
  return { resolved, args: argsOf(startArgs, args).args };
};

/** Who reads a workflow reference's query, and through which App. */
export interface WorkflowCaller {
  readonly app: string;
  readonly userId: string;
  /** Grasp staff: asked no client's decision. */
  readonly staff?: boolean;
}

/** `caller` asking through `release`, the App's current one. */
const askingFor = (caller: WorkflowCaller, release: Release): Asking => ({
  by: {
    userId: caller.userId,
    ...(caller.staff === true ? { staff: true } : {}),
  },
  app: appIdSchema.parse(caller.app),
  version: release.manifest.resourceVersion,
  release,
});

/**
 * Run `runId` of `alias` as `caller` may see it now, for the reference's
 * `run` query: its snapshot, or null for a run they may not see, one that
 * doesn't exist alike (`seenRun`), so a run's ID is no oracle. The caller
 * passed the gate a call core answers itself passes (app-functions.ts).
 */
export const readRun = async (
  env: Env,
  caller: WorkflowCaller,
  release: Release,
  alias: string,
  runId: string
): Promise<Json> => {
  const asking = askingFor(caller, release);
  try {
    return await runSnapshot(
      env,
      asking,
      await resolvedIn(release, alias),
      runId
    );
  } catch (error) {
    if (workflowResourceErrors.codeOf(error) === "workflow.run_unavailable") {
      return null;
    }
    throw error;
  }
};

/**
 * Whether `caller` may start a run of `alias` through the App's binding
 * now, for the reference's `canStart` query: an App's start's own rule,
 * and the binding in force naming the workflow the seal binds.
 */
export const mayStartNow = async (
  env: Env,
  caller: WorkflowCaller,
  release: Release,
  alias: string
): Promise<boolean> => {
  const { workflowId } = await resolvedIn(release, alias);
  return (
    workflowId !== undefined &&
    (await holds(
      env,
      mayStartSql(askingFor(caller, release), alias, workflowId)
    ))
  );
};
