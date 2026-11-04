import type { Brain } from "@grasp-os/brain/brain";
import { brainErrors } from "@grasp-os/brain/contract";
import type { BrainSourceRef } from "@grasp-os/brain/contract";
import {
  entitiesWithSources,
  entitySourcesRead,
} from "@grasp-os/brain/entities";
import { recall } from "@grasp-os/brain/recall";
import { d1BrainStore } from "@grasp-os/brain/recall-store";
import type { VersionRef } from "@grasp-os/brain/recall-store";
import { relationsExplain, relationsFor } from "@grasp-os/brain/relations";
import { readSkill, selectSkill } from "@grasp-os/brain/skills";
import { runActorOf } from "@grasp-os/shared/audit";
import type { AuditEntry } from "@grasp-os/shared/audit";
import { decidersSchema } from "@grasp-os/shared/decisions";
import { sha256Hex } from "@grasp-os/shared/encoding";
import { isExpectedError } from "@grasp-os/shared/errors";
import { identifierSchema } from "@grasp-os/shared/ids";
import type { AppId, PermissionId, WorkflowId } from "@grasp-os/shared/ids";
import { canonicalJson } from "@grasp-os/shared/json";
import { errorFields, log } from "@grasp-os/shared/log";
import { modelErrors } from "@grasp-os/shared/models";
import { resourceAliasPattern } from "@grasp-os/shared/operation-limits";
import type { OperationResult } from "@grasp-os/shared/operations";
import { permissionErrors } from "@grasp-os/shared/permissions";
import {
  callReviewed,
  executionErrors,
  inboundEmailIndexSchema,
  modelReviewed,
  reviewerChosenAtRun,
  stepIdempotencyKey,
  stepReviewed,
  stepRunsAs,
  storedEmailSchema,
  workflowErrors,
} from "@grasp-os/shared/workflows";
import type { StepUse, WorkflowCalls } from "@grasp-os/shared/workflows";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { z } from "zod";

import type { RunCaller } from "../app-functions.ts";
import { auditedBatch, outboxed, outboxedWhere } from "../audit-outbox.ts";
import { requireStepKey, runStubCall } from "../bindings.ts";
import type { ConnectionGrant } from "../bindings.ts";
import { workflowRuns } from "../db/core/schema.ts";
import { decisionRecipients, openDecision } from "../decisions/decisions.ts";
import type { DecisionRecipient } from "../decisions/decisions.ts";
import type { Reader } from "../knowledge/access.ts";
import { readAsDelegate } from "../knowledge/binding.ts";
import type { CollectionBinding } from "../knowledge/binding.ts";
import { brainOf } from "../knowledge/ports.ts";
import { models } from "../models.ts";
import { authorize, requireActivePerson } from "../permissions.ts";
import type { StepModel } from "../resource-bindings.ts";
import { tokensOfBound } from "../resource-model.ts";
import { commitStepStatistics } from "../statistic-steps.ts";
import { AttemptHost } from "./attempt-host.ts";
import type { Settled } from "./code.ts";
import {
  aiWaitOf,
  checked,
  milliseconds,
  settle,
  stepNameSchema,
} from "./host.ts";
import type { HostControls, HostedRun, RunKind, StepAttempt } from "./host.ts";
import { attachmentOf, keptMessage } from "./kept-email.ts";
import { modelWaitRecorded } from "./model-waits.ts";
import type { AttemptAdmission } from "./quotas.ts";
import {
  citedVersions,
  recordRunEvidence,
  requireRunEvidenceReadable,
} from "./run-evidence.ts";

// What an App's run may do on the host (host.ts, `RunHost`): run the steps
// the review of its version shows, as it shows them, and from inside them
// call only the bindings that review shows each step calling, the model
// each AI step names, its App's own functions, its decisions and its kept
// mail, for the person it acts for while they are there.

/**
 * What a run may call of a collection it may read (`CollectionBinding`):
 * the isolate's stub of each has these methods, each a call through the
 * host (`callCollection`).
 */
export const collectionMethods = [
  "listDocuments",
  "getDocument",
  "history",
  "backlinks",
  "search",
  "read",
  "follow",
] as const satisfies readonly (keyof CollectionBinding)[];

const collectionMethodSchema = z.enum(collectionMethods);

/** The code a held side effect answers a run's call with (connect). */
const heldCode = "connect.held";

/** The code a side effect of unknown outcome answers a run's call with. */
const unknownCode = "connect.outcome_unknown";

/**
 * The most held keys of one attempt a held marker keeps. Past it, the
 * step waits for those it kept; run again, it is held again by any still
 * waiting, and waits for those: never runs on while one waits.
 */
const heldKeysKept = 32;

/**
 * The largest output schema a model call takes, as JSON text. Its regular
 * expressions (Zod writes them for `z.email()`, `z.iso.date()` and the
 * like) run on the model's answer; one that backtracks badly is bounded by
 * the Worker's CPU limit, like any other expensive request.
 */
const maxSchemaLength = 32 * 1024;

/** What the host takes from the gateway's answer to an AI step. */
const modelAnswerSchema = z.object({ output: z.unknown() });

const modelRequestSchema = z.object({
  step: stepNameSchema,
  binding: z.string().regex(resourceAliasPattern),
  instructions: z.string(),
  input: z.json(),
  outputSchema: z
    .record(z.string(), z.unknown())
    .refine((schema) => JSON.stringify(schema).length <= maxSchemaLength),
});

const decisionSchema = z.object({
  step: stepNameSchema,
  from: decidersSchema,
  description: z.string().min(1),
  timeout: milliseconds,
});

/** The Brain operations a run's Brain binding calls (`#callBrain`). */
const brainCallSchema = z.enum([
  "recall",
  "skillsSelect",
  "skillsRead",
  "entitiesList",
  "entitySources",
  "relationsGet",
  "relationsExplain",
]);

/** The document versions of `refs`, once each, as `pinsOf` takes them. */
const documentVersionsOf = (refs: readonly BrainSourceRef[]): VersionRef[] => [
  ...new Map(
    refs.flatMap((ref) =>
      ref.kind === "document"
        ? [
            [
              `${ref.documentId}:${ref.version}`,
              {
                documentId: ref.documentId,
                collectionId: ref.collectionId,
                version: ref.version,
              },
            ] as const,
          ]
        : []
    )
  ).values(),
];

/**
 * Each, as the Brain serves every caller: a recall, a skill's selection,
 * a pinned skill's read, an entity listing, an entity's sources, an
 * entity's relations or the paths out from it; the same service and checks. With what each hands
 * over cites (`cited`): the document versions the run's evidence pins
 * (`#callBrain`), so every way out of the run stays gated by them.
 */
const brainCalls: Record<
  z.infer<typeof brainCallSchema>,
  (
    brain: Brain<Reader>,
    reader: Reader,
    request: unknown
  ) => Promise<{ value: unknown; cited: readonly VersionRef[] }>
> = {
  recall: async (brain, reader, request) => {
    const pack = await recall(brain, reader, request);
    return { value: pack, cited: citedVersions(pack) };
  },
  skillsSelect: async (brain, reader, request) => ({
    value: await selectSkill(brain, reader, request),
    cited: [],
  }),
  skillsRead: async (brain, reader, request) => ({
    value: await readSkill(brain, reader, request),
    cited: [],
  }),
  entitiesList: async (brain, reader, request) => {
    const { entities, sources, truncated } = await entitiesWithSources(
      brain,
      reader,
      request
    );
    return { value: { entities, truncated }, cited: sources.documents };
  },
  entitySources: async (brain, reader, request) => {
    const answer = await entitySourcesRead(brain, reader, request);
    return { value: answer, cited: documentVersionsOf(answer.sources) };
  },
  // Each relation's passage is handed over: its source version is pinned.
  // Only the answered relations' are: a claim weighed for `conflicting`
  // alone isn't (up to 5000, past the run's evidence cap), so a revoke of
  // its collection may leave a recorded answer's `conflicting` as it was.
  // One bit, no content: a chat labels those collections too.
  relationsGet: async (brain, reader, request) => {
    const answer = await relationsFor(brain, reader, request);
    return {
      value: answer,
      cited: documentVersionsOf(
        answer.relations.map(({ sourceRef }) => sourceRef)
      ),
    };
  },
  // Each path's relations, each with its passage: their source versions
  // are pinned.
  relationsExplain: async (brain, reader, request) => {
    const explanation = await relationsExplain(brain, reader, request);
    return {
      value: explanation,
      cited: documentVersionsOf(
        explanation.paths.flatMap(({ relations }) =>
          relations.map(({ sourceRef }) => sourceRef)
        )
      ),
    };
  },
};

/**
 * Whether `attempt` may have kept statistics points to add up as it
 * completes its step: it called its App's sealed functions. Then the step
 * gets its marker as it completes, whether or not a point was kept, so a
 * run of the step the engine makes again after that adds up nothing, also
 * when the first recorded nothing (`commitStepStatistics`).
 */
const keptStatistics = (attempt: StepAttempt): boolean =>
  attempt.recorded || attempt.functionCalls > 0;

/**
 * Fails a call of an attempt that had a call refused, with that refusal:
 * every later call of a refused attempt fails at once, whatever it calls.
 */
const requireUnrefused = (attempt: StepAttempt): void => {
  if (attempt.refused !== undefined) {
    throw attempt.refused;
  }
};

/**
 * Whether connect said an unknown outcome waits for its person's word
 * (`awaitsResolution`): a native connector's lost answer. A Composio
 * tool's error, which its person can't yet see, fails the step instead.
 */
const awaitsResolution = (error: object): boolean => {
  const details: unknown = Reflect.get(error, "details");
  return (
    typeof details === "object" &&
    details !== null &&
    Reflect.get(details, "awaitsResolution") === true
  );
};

/**
 * Runs `call` for the step attempt `attempt`, noting when it answered that
 * a side effect was held, whatever the workflow code does with the error.
 * With `unknownHolds`, for a call under the step's own key, an outcome
 * nobody can tell (`connect.outcome_unknown`) that connect says waits for
 * its person (`awaitsResolution`) holds the step too: it waits until
 * connect can recover the call or its person resolved it (connect's
 * `anyPending` says so), then runs again under the same key, rather than
 * spend its retries on the same answer or fail the run.
 */
const heldNoted = async <T>(
  attempt: { held: boolean; unknown?: boolean },
  call: () => Promise<T>,
  unknownHolds = false
): Promise<T> => {
  try {
    return await call();
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      if (error.code === heldCode) {
        attempt.held = true;
      } else if (
        unknownHolds &&
        error.code === unknownCode &&
        awaitsResolution(error)
      ) {
        attempt.held = true;
        attempt.unknown = true;
      }
    }
    throw error;
  }
};

/** An App's run, as the dispatcher loaded it (dispatcher.ts). */
export interface HostedAppRun extends HostedRun {
  app: AppId;
  workflow: WorkflowId;
  version: number;
  /** Its collections' stubs, by binding name (`runBindingsFor`). */
  collections: Record<string, Fetcher<CollectionBinding>>;
  /** Its connection permissions, by binding name (`runBindingsFor`). */
  connections: Record<string, ConnectionGrant>;
  /**
   * The names its `brain` permissions bind the Brain by, each with its
   * permission (`runBindingsFor`).
   */
  brains: Readonly<Record<string, PermissionId>>;
  /**
   * The bindings its workflow calls, by step, as the review of its version
   * shows them (`app_versions.workflow_calls`).
   */
  calls: WorkflowCalls;
}

/** How an App's run reaches back into the dispatcher (dispatcher.ts). */
export interface AppRunCalls {
  /**
   * The App's model binding of `alias` an AI step goes through, as it
   * serves now (`stepModelBinding`): `resource.unavailable` when none
   * does.
   */
  modelBinding: (alias: string) => Promise<StepModel>;
  /**
   * Calls a public function of the run's App's release, for `caller`, a
   * step of the run, under `idempotencyKey` (`callRunFunction`).
   */
  callFunction: (
    caller: RunCaller,
    reference: unknown,
    input: unknown,
    idempotencyKey: string
  ) => Promise<OperationResult>;
}

class AppRun implements RunKind {
  readonly #env: Env;
  readonly #calls: AppRunCalls;
  readonly #host: HostControls;
  readonly run: HostedAppRun;
  readonly audit: RunKind["audit"];
  readonly decisionRun: HostedAppRun;
  readonly aiWaitRun: RunKind["aiWaitRun"];

  constructor(
    env: Env,
    run: HostedAppRun,
    calls: AppRunCalls,
    host: HostControls
  ) {
    this.#env = env;
    this.#calls = calls;
    this.#host = host;
    this.run = run;
    const { app, workflow, version, runId } = run;
    this.audit = {
      actor: runActorOf(run),
      target: { type: "workflow_run", id: runId },
      detail: { app, workflow, version },
    };
    this.decisionRun = run;
    this.aiWaitRun = { kind: "app", runId };
  }

  /**
   * The person the run acts for must still be there: checked before every
   * step, and inside one (a model call, an App call). One who has
   * left fails the step, and with it the run.
   */
  async requirePerson(): Promise<void> {
    await requireActivePerson(this.#env, this.run.authority);
  }

  /**
   * Refuses a step whose name the version's review doesn't show, or shows
   * running another way. When the review couldn't read the steps, every
   * name may run (`stepReviewed`), and the run's history names none of
   * them.
   */
  stepRefusal(step: string, use: StepUse): Error | undefined {
    if (!stepReviewed(this.run.calls, step)) {
      const error = workflowErrors.create("workflow.step_not_reviewed");
      error.message = `Step "${step}" isn't one the review of this version shows: run steps only as the workflow's function writes them.`;
      return error;
    }
    if (!stepRunsAs(this.run.calls, step, use)) {
      const error = workflowErrors.create("workflow.step_not_reviewed");
      error.message = `Step "${step}" isn't one the review of this version shows running that way: run steps only as the workflow's function writes them.`;
      return error;
    }
    return undefined;
  }

  /**
   * The statistics points `attempt`'s App calls recorded, added up as it
   * completes its step: once (a step run again after this adds nothing),
   * and no other attempt's.
   */
  async stepCompleted(attempt: StepAttempt): Promise<void> {
    if (keptStatistics(attempt)) {
      await commitStepStatistics(
        this.#env,
        this.run.runId,
        stepIdempotencyKey(this.run.runId, attempt.step),
        attempt.leaseId
      );
    }
  }

  attemptHost(attempt: StepAttempt, admission: AttemptAdmission): AttemptHost {
    return new AttemptHost(
      {
        callModel: async (request) => await this.#callModel(attempt, request),
        callCollection: async (binding, method, args) =>
          await this.#callCollection(attempt, binding, method, args),
        callConnection: async (binding, call) =>
          await this.#callConnection(attempt, binding, call),
        callBrain: async (binding, operation, request) =>
          await this.#callBrain(attempt, binding, operation, request),
        callFunction: async (reference, input) =>
          await this.#callFunction(attempt, reference, input),
        openDecision: async (request) =>
          await this.#openDecision(attempt, request),
        decisionRecipients: async (decision, reminder) =>
          await this.#decisionRecipients(attempt, decision, reminder),
        readAttachment: async (stored, index) =>
          await this.#readAttachment(attempt, stored, index),
      },
      async (call) => await this.#host.leaseRefusal(attempt, call),
      async (call) => await this.#host.hostCallRefusal(attempt, admission, call)
    );
  }

  /**
   * Asks the model gateway for an AI step, from inside the step only: the
   * model must be one the deployment allows and its rules let this call
   * use (model-rules.ts), and its answer must match the step's schema (a JSON Schema from the SDK, checked here as Zod, and
   * again by the SDK). The audit log records the call under this run.
   */
  async #callModel(
    attempt: StepAttempt,
    request: unknown
  ): Promise<Settled<unknown>> {
    return await settle(async () => {
      this.#host.requireUntampered();
      await this.#host.requireCurrent(attempt, "model");
      requireUnrefused(attempt);
      await this.#requireEvidenceReadable();
      await this.#requireKindIn(attempt, "model", "model");
      await this.requirePerson();
      const { binding, instructions, input, outputSchema } = checked(
        modelRequestSchema,
        request
      );
      await this.#requireModelReviewed(attempt, binding);
      let schema: z.ZodType;
      try {
        schema = z.fromJSONSchema(outputSchema);
      } catch {
        throw modelErrors.create("model.invalid_call");
      }
      const { output } = modelAnswerSchema.parse(
        await this.#host.askingOnce(
          attempt,
          JSON.stringify([binding, instructions, input, outputSchema]),
          async () => {
            // The App's binding of the alias, as it serves now: read again
            // for every attempt, so one revoked or changed meanwhile stops
            // the next.
            const bound = await this.#calls.modelBinding(binding);
            // This call of the step, whose notes of its wait are its own.
            const owner = crypto.randomUUID();
            // Last, after every read: an attempt the engine gave up on
            // meanwhile asks the gateway nothing.
            await this.#host.requireCurrent(attempt, "model");
            try {
              return await models(this.#env).call({
                model: bound.model,
                // Its caps count each attempt as a request of its own.
                binding: bound.binding,
                ...tokensOfBound(bound.maxOutputTokens, true),
                system: instructions,
                input,
                schema,
                purpose: "workflow.step",
                trigger: this.audit.actor,
                // Whose share it takes: who started the run, never the
                // owner it acts for when nobody did.
                shareSubject: this.run.shareSubject,
                // The run's restricted mode, which is its App's.
                work: {
                  authority: this.run.authority,
                  context: {
                    type: "run",
                    appId: this.run.app,
                    runId: this.run.runId,
                  },
                },
                // After the ledger admitted each provider request, with
                // nothing awaited before it is sent.
                beforeSend: () => {
                  if (!this.#host.holds(attempt)) {
                    throw executionErrors.create("execution.stale_attempt");
                  }
                },
                // While its call waits for a share of the model requests
                // in flight, the run shows queued (model-waits.ts).
                onQueued: async (queued) => {
                  await modelWaitRecorded(
                    drizzle(this.#env.DB),
                    this.run.runId,
                    attempt.step,
                    owner,
                    queued
                  );
                },
              });
            } catch (error) {
              // Stopped before it was sent, as the engine gave up on the
              // attempt: said so, whatever the gateway made of the stop.
              await this.#host.requireCurrent(attempt, "model");
              attempt.aiTrouble = aiWaitOf(error) ?? attempt.aiTrouble;
              throw error;
            }
          },
          async () => {
            await this.#calls.modelBinding(binding);
          }
        )
      );
      return output;
    });
  }

  /**
   * The idempotency key of `attempt`'s step. Core holds the key to a run's
   * side effects: its connection calls, and those of its App's methods it
   * calls, take this key or none (`requireStepKey`).
   */
  #stepKeyOf(attempt: StepAttempt): string {
    return stepIdempotencyKey(this.run.runId, attempt.step);
  }

  /**
   * Refuses a call of `attempt` as `use` unless both it and the attempt
   * running now (a step nested in it may borrow its host) run as `use`
   * (`stepRunsAs`), as `#requireReviewed` holds both to their calls.
   * Refused, both fail (`StepAttempt.refused`), so a step that catches the
   * refusal and returns still fails, never completes.
   */
  async #requireKindIn(
    attempt: StepAttempt,
    use: StepUse,
    call: string
  ): Promise<void> {
    const running = this.#host.running(attempt);
    const other = [running, attempt].find(
      ({ step }) => !stepRunsAs(this.run.calls, step, use)
    );
    if (other !== undefined) {
      const error = workflowErrors.create("workflow.step_not_reviewed");
      error.message = `Step "${other.step}" isn't one the review of this version shows running that way: run steps only as the workflow's function writes them.`;
      await this.#host.refuseIn(attempt, error, call, other.step);
    }
  }

  /**
   * Refuses a model call of `attempt` naming a binding its review doesn't
   * show its AI step calling (`modelReviewed`), for both it and the
   * attempt running now (a step nested in it may borrow its host), as
   * `#requireKindIn` holds both: code past the SDK asking another of the
   * App's models from a reviewed AI step. Tampering, as a kind refusal is:
   * both fail, caught or not, and the run ends.
   */
  async #requireModelReviewed(
    attempt: StepAttempt,
    binding: string
  ): Promise<void> {
    const running = this.#host.running(attempt);
    const other = [running, attempt].find(
      ({ step }) => !modelReviewed(this.run.calls, step, binding)
    );
    if (other !== undefined) {
      const error = workflowErrors.create("workflow.step_not_reviewed");
      error.message = `Step "${other.step}" asked model ${binding}, which the review of this version doesn't show it asking: ask each AI step's model only as its \`step.llm\` names it.`;
      await this.#host.refuseIn(attempt, error, "model", other.step, binding);
    }
  }

  /**
   * Refuses a call of `binding` (`APP` for the App's own server) that the
   * review of the run's version doesn't show: the step running now, and
   * the step whose attempt's host the call came through, must both be
   * ones whose code, as the review reads it, calls that binding. What the
   * review reads is only what the source says, and code can move a call
   * as it runs: a binding kept when a module loads, or a stub made in one
   * step and called in another, or code one step hands another. Each
   * refusal is audited, and fails both attempts (`StepAttempt.refused`).
   */
  async #requireReviewed(attempt: StepAttempt, binding: string): Promise<void> {
    const running = this.#host.running(attempt);
    // Once an attempt had a call refused, every later call of it fails
    // at once, allowed or not, and none is audited again: a loop of
    // refused calls can't flood the audit log.
    requireUnrefused(running);
    requireUnrefused(attempt);
    const unreviewed = [running, attempt].find(
      ({ step }) => !callReviewed(this.run.calls, step, binding)
    );
    if (unreviewed === undefined) {
      return;
    }
    const error = workflowErrors.create("workflow.call_not_reviewed");
    error.message = `Step "${unreviewed.step}" called ${binding}, which the review of this version doesn't show it calling: call each binding only in the step's own function, where the review shows it.`;
    running.refused = error;
    attempt.refused = error;
    await this.#host.auditRefusal({
      step: unreviewed.step,
      call: binding,
      errorCode: "workflow.call_not_reviewed",
    });
    throw error;
  }

  /**
   * Calls `method` of a collection the run may read (`binding`, e.g.
   * `env.HANDBOOK.search(query)`) with `args`, only inside a step whose
   * code its review shows calling it (`#requireReviewed`). The collection's
   * stub checks and records the read as it does for any reader.
   */
  async #callCollection(
    attempt: StepAttempt,
    binding: unknown,
    method: unknown,
    args: unknown
  ): Promise<Settled<unknown>> {
    return await settle(async () => {
      this.#host.requireUntampered();
      await this.#host.requireCurrent(attempt, "collection");
      const { collections } = this.run;
      const name = checked(z.string(), binding);
      const stub = Object.hasOwn(collections, name)
        ? collections[name]
        : undefined;
      if (stub === undefined) {
        throw workflowErrors.create("workflow.invalid");
      }
      const read = checked(collectionMethodSchema, method);
      const [first, second] = checked(z.array(z.unknown()).max(2), args);
      await this.#requireReviewed(attempt, name);
      await this.#host.requireCurrent(attempt, name);
      // The stub checks every argument, as it does one from an App.
      switch (read) {
        case "listDocuments": {
          return await stub.listDocuments(first);
        }
        case "getDocument": {
          return await stub.getDocument(first, second);
        }
        case "history": {
          return await stub.history(first, second);
        }
        case "backlinks": {
          return await stub.backlinks(first, second);
        }
        case "search": {
          return await stub.search(first, second);
        }
        case "read": {
          return await stub.read(first, second);
        }
        case "follow": {
          return await stub.follow(first);
        }
        default: {
          throw workflowErrors.create("workflow.invalid");
        }
      }
    });
  }

  /**
   * Calls the Brain through the run's Brain binding (`binding`): a recall
   * (`brain(env.BRAIN).recall(request)`), a skill's selection or pinned
   * read (`.skills.select`, `.skills.read`, GRA-310), or an entity
   * listing, an entity's sources, its relations or the paths out from it
   * (`.entities.list`, `.entities.sources`, `.relations.get`,
   * `.relations.explain`), only inside a step whose code its
   * review shows calling it (`#requireReviewed`), as the run: its App on
   * behalf of its person, under the App's collection grants and `brain`
   * permission as they are now (GRA-1067; the threat model is on the
   * issue). The same service and checks as every caller's recall: the
   * Brain refuses without the `brain` grant (`brain.denied`), and a filter
   * naming a collection the run may not read (`brain.not_found`); what it
   * read is recorded with the run (knowledge/access.ts, `noteProvenance`).
   */
  async #callBrain(
    attempt: StepAttempt,
    binding: unknown,
    operation: unknown,
    request: unknown
  ): Promise<Settled<unknown>> {
    return await settle(async () => {
      this.#host.requireUntampered();
      const call = checked(brainCallSchema, operation);
      await this.#host.requireCurrent(attempt, "brain");
      const { brains, authority } = this.run;
      const name = checked(z.string(), binding);
      const permissionId = Object.hasOwn(brains, name)
        ? brains[name]
        : undefined;
      if (permissionId === undefined) {
        throw workflowErrors.create("workflow.invalid");
      }
      await this.#requireReviewed(attempt, name);
      await this.#host.requireCurrent(attempt, name);
      const context = {
        type: "run",
        appId: this.run.app,
        runId: this.run.runId,
      } as const;
      // Under this binding's own permission, read now: one revoked stops
      // its name, though another `brain` permission of the App's holds.
      try {
        await authorize(
          this.#env,
          authority,
          { type: "platform" },
          "brain",
          permissionId,
          context
        );
      } catch (error) {
        if (permissionErrors.codeOf(error) === "permission.denied") {
          throw brainErrors.create("brain.denied");
        }
        throw error;
      }
      const { value, pins } = await readAsDelegate(
        this.#env,
        authority,
        context,
        undefined,
        async (reader) => {
          const brain = brainOf(this.#env);
          const read = await brainCalls[call](brain, reader, request);
          return {
            value: read.value,
            pins: await d1BrainStore(brain).pinsOf(reader, read.cited),
          };
        }
      );
      // What it cites, pinned as it was, added to the run's evidence
      // (run-evidence.ts): checked before anything leaves the run from now
      // on. Each of these reads needs the Brain's admission, so the run
      // stays held to it too (`recalled`). A step replayed returns its
      // recorded answer and records nothing.
      await recordRunEvidence(this.#env, this.run, permissionId, pins, {
        recalled: true,
      });
      return value;
    });
  }

  /**
   * Refuses, as `brain.revoked`, anything leaving this run once it may no
   * longer read what it recalled (run-evidence.ts).
   */
  async #requireEvidenceReadable(): Promise<void> {
    await requireRunEvidenceReadable(this.#env, this.run);
  }

  /**
   * Calls an action on one of the run's connections (`binding`), with
   * `call` as a connection stub takes it: `[action, input, options]`, for
   * `attempt`'s step, with that step's key or none, from a step whose code
   * its review shows calling it (`#requireReviewed`).
   */
  async #callConnection(
    attempt: StepAttempt,
    binding: unknown,
    call: unknown
  ): Promise<Settled<unknown>> {
    return await settle(async () => {
      this.#host.requireUntampered();
      await this.#host.requireCurrent(attempt, "connection");
      await this.#requireEvidenceReadable();
      const stepKey = this.#stepKeyOf(attempt);
      const { connections, authority } = this.run;
      const name = checked(z.string(), binding);
      const grant = Object.hasOwn(connections, name)
        ? connections[name]
        : undefined;
      if (grant === undefined) {
        throw workflowErrors.create("workflow.invalid");
      }
      await this.#requireReviewed(attempt, name);
      await this.#host.requireCurrent(attempt, name);
      return await heldNoted(
        attempt,
        async () =>
          await runStubCall(
            this.#env,
            async (key) => {
              requireStepKey(key, stepKey);
              return await Promise.resolve({
                authority,
                // The capability expires with the attempt, and the call
                // goes to connect only if the attempt still holds then,
                // after the permission check and the signing.
                notAfter: attempt.deadline,
                stillAllowed: async () => {
                  await this.#host.requireCurrent(attempt, name);
                },
                // Its mail to the deployment's domain is stamped with
                // this run (mail-stamps.ts).
                stamping: { run: this.run.runId, stepKey },
              });
            },
            grant,
            checked(z.array(z.unknown()), call)
          ),
        // Its key is the step's: an unknown outcome holds the step.
        true
      );
    });
  }

  /**
   * Calls a public function of the run's own App's sealed release
   * (`env.APP.callFunction(reference, input)`), at the version the run is
   * pinned to, for the person the run acts for, as the run, only inside a
   * step whose code its review shows calling `APP` (`#requireReviewed`).
   * Its key is the step's key and the call's place among the attempt's
   * function calls (`StepAttempt.functionCalls`), counted as each call
   * comes in: two calls of one step never share a key, and a rerun of the
   * step (a retry, a replay, the run after a held side effect was
   * decided) whose code calls in the same order makes the same calls, so
   * its mutations' receipts and its resource requests' keys are the same.
   * As for an action's own requests (`runAction`), calls made at once
   * count in the order they come. Its every protected step (its start,
   * each commit, each resource request) is admitted only while `attempt`
   * still holds its lease (`runInvocationFor`). A side effect connect
   * held for the person holds the step, whatever App code makes of the
   * refusal. Answers what the function answered or why it failed, as data
   * (`OperationResult`).
   */
  async #callFunction(
    attempt: StepAttempt,
    reference: unknown,
    input: unknown
  ): Promise<Settled<unknown>> {
    // Counted before anything is awaited, in the order calls come.
    attempt.functionCalls += 1;
    const place = attempt.functionCalls;
    return await settle(async () => {
      this.#host.requireUntampered();
      await this.#host.requireCurrent(attempt, "APP");
      await this.#requireEvidenceReadable();
      await this.#requireReviewed(attempt, "APP");
      await this.requirePerson();
      const stepKey = this.#stepKeyOf(attempt);
      return await this.#calls.callFunction(
        {
          run: this.run,
          requestId: crypto.randomUUID(),
          deadline: attempt.deadline,
          stillCurrent: async () => {
            await this.#host.requireCurrent(attempt, "APP");
          },
          requireHolds: () => {
            if (!this.#host.holds(attempt)) {
              // Audited once per attempt, as any stale call is; the call
              // is refused here, with nothing awaited.
              void this.#host.leaseRefusal(attempt, "APP");
              throw executionErrors.create("execution.stale_attempt");
            }
          },
          held: (key) => {
            attempt.held = true;
            if (
              attempt.heldKeys.length < heldKeysKept &&
              !attempt.heldKeys.includes(key)
            ) {
              attempt.heldKeys.push(key);
            }
          },
          step: {
            key: stepKey,
            attempt: attempt.leaseId,
            recording: () => {
              attempt.recorded = true;
            },
          },
        },
        reference,
        input,
        // Within what a submission key may be, whatever the step's name.
        `step:${await sha256Hex(canonicalJson([stepKey, place]))}`
      );
    });
  }

  /**
   * Opens this run's decision for a step, inside that step, and answers
   * its ID and deadline; the same step gets the same decision again, so
   * opening it again opens nothing new (src/decisions/).
   */
  async #openDecision(
    attempt: StepAttempt,
    request: unknown
  ): Promise<Settled<{ decision: string; deadline: number }>> {
    return await settle(async () => {
      this.#host.requireUntampered();
      await this.#host.requireCurrent(attempt, "decision");
      requireUnrefused(attempt);
      // Its text goes to people other than the run's person.
      await this.#requireEvidenceReadable();
      await this.#requireKindIn(attempt, "decision", "decision");
      const { step, from, description, timeout } = checked(
        decisionSchema,
        request
      );
      // A decision is its own step's, as the SDK opens it: one opened
      // under another step's name would be held to that step's review,
      // its reviewer read as that step's (`reviewerChosenAtRun`).
      if (step !== attempt.step) {
        const error = workflowErrors.create("workflow.invalid");
        error.message = `A decision opens only in the step that asks it: step "${attempt.step}" can't open one for "${step}".`;
        await this.#host.refuseIn(attempt, error, "decision");
      }
      return await openDecision(this.#env, this.run, {
        step,
        from,
        description,
        timeout,
        // A reviewer the run's input chose may be its starter's choice of
        // themselves: they never answer it (R8).
        starterExcluded: reviewerChosenAtRun(this.run.calls, step),
      });
    });
  }

  /**
   * The people one of this run's open decisions asks now, each with the
   * decision's link, inside a step (the one that asks them).
   */
  async #decisionRecipients(
    attempt: StepAttempt,
    decision: unknown,
    reminder: unknown
  ): Promise<Settled<DecisionRecipient[]>> {
    return await settle(async () => {
      this.#host.requireUntampered();
      await this.#host.requireCurrent(attempt, "decision");
      requireUnrefused(attempt);
      await this.#requireKindIn(attempt, "recipients", "decision");
      return await decisionRecipients(
        this.#env,
        this.run,
        checked(identifierSchema, decision),
        checked(z.boolean(), reminder),
        async () => {
          await this.#host.requireCurrent(attempt, "decision");
        }
      );
    });
  }

  /**
   * The content of attachment `index` of a message an email trigger kept
   * for the run's App (`stored`, as the run's input names it), only inside
   * a step, for a person who is still there (kept-email.ts). Checked
   * against the run's own App, never one the isolate names: another App's
   * message is found as none. Every call is audited as a read, whatever
   * refuses it (outside a step, a name or index that isn't
   * one), with the name and index as sent. An attachment is handed on,
   * and a refusal answered, only once it's recorded: one that can't be
   * recorded fails as `internal.unexpected`, to be tried again. A step
   * attempt parses each message it reads once, however many of its
   * attachments it reads; a fetch that fails is tried again on its next
   * read. `stored: null` (a message that isn't kept) is refused with
   * `workflow.attachment_not_found`.
   */
  async #readAttachment(
    attempt: StepAttempt,
    stored: unknown,
    index: unknown
  ): Promise<Settled<Uint8Array>> {
    return await settle(async () => {
      const { step } = attempt;
      const sent = {
        step,
        message: typeof stored === "string" ? stored.slice(0, 256) : null,
        index:
          typeof index === "number" && Number.isFinite(index) ? index : null,
      };
      let content: Uint8Array;
      try {
        this.#host.requireUntampered();
        await this.#host.requireCurrent(attempt, "attachment");
        requireUnrefused(attempt);
        await this.requirePerson();
        // A message that isn't kept names nothing to read.
        if (stored === null) {
          throw workflowErrors.create("workflow.attachment_not_found");
        }
        const message = checked(storedEmailSchema, stored);
        const at = checked(inboundEmailIndexSchema, index);
        // Only a message read and parsed is kept for the attempt's next
        // read: a fetch that failed is tried again.
        attempt.keptMessages ??= new Map();
        let kept = attempt.keptMessages.get(message);
        if (kept === undefined) {
          kept = await keptMessage(this.#env, this.run.app, message);
          attempt.keptMessages.set(message, kept);
        }
        content = attachmentOf(kept, at);
        await this.#host.requireCurrent(attempt, "attachment");
      } catch (error) {
        const errorCode = isExpectedError(error)
          ? error.code
          : "internal.unexpected";
        // A stale attempt's refusal is audited once per attempt, as a
        // refused call (`HostControls.requireCurrent`): a loop of late reads can't
        // flood the audit log.
        if (errorCode === "execution.stale_attempt") {
          throw error;
        }
        try {
          await this.#auditRead({ ...sent, errorCode });
        } catch (auditError) {
          // No refusal goes unrecorded: the call fails as one that can be
          // tried again, and the refusal it would have been is logged.
          log.error("workflow.email.audit_failed", {
            runId: this.run.runId,
            refusedWith: errorCode,
            ...errorFields(auditError),
          });
          throw auditError;
        }
        throw error;
      }
      // Recorded, and handed on, only while its run goes on: one cancelled
      // meanwhile gets nothing (`AttemptHost` checks the attempt again as
      // the call returns).
      if (!(await this.#auditRead({ ...sent, bytes: content.byteLength }))) {
        throw executionErrors.create("execution.stale_attempt");
      }
      return content;
    });
  }

  /**
   * Records a read of a kept message's attachment, through the outbox. A
   * read that hands the attachment on (`bytes`) is recorded only while the
   * run is neither cancelled nor ended, as the write finds it; whether it
   * was. A refusal is always recorded.
   */
  async #auditRead(read: {
    step: string | null;
    message: string | null;
    index: number | null;
    bytes?: number;
    errorCode?: string;
  }): Promise<boolean> {
    const { app, workflow, version, runId } = this.run;
    const db = drizzle(this.#env.DB);
    const entry: AuditEntry = {
      actor: this.audit.actor,
      action: "workflow.email.read",
      target: { type: "workflow_run", id: runId },
      detail: {
        app,
        workflow,
        version,
        step: read.step,
        message: read.message,
        attachment: read.index,
        ...(read.bytes === undefined ? {} : { bytes: read.bytes }),
        ...(read.errorCode === undefined ? {} : { errorCode: read.errorCode }),
      },
    };
    if (read.bytes === undefined) {
      await auditedBatch(this.#env, db, [outboxed(db, entry)]);
      return true;
    }
    const live = sql`EXISTS (SELECT 1 FROM ${workflowRuns} WHERE ${workflowRuns.id} = ${runId} AND ${workflowRuns.cancelRequestedAt} IS NULL AND ${workflowRuns.endedAt} IS NULL)`;
    const [, still] = await auditedBatch(this.#env, db, [
      outboxedWhere(db, entry, live),
      db
        .select({ id: workflowRuns.id })
        .from(workflowRuns)
        .where(and(eq(workflowRuns.id, runId), live)),
    ]);
    return still.length > 0;
  }
}

/** The kind of run an App's run is, for the host (`RunHost`) to serve. */
export const appRun =
  (env: Env, run: HostedAppRun, calls: AppRunCalls) =>
  (host: HostControls): RunKind =>
    new AppRun(env, run, calls, host);
