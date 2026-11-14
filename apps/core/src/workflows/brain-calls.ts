import { delegateActorOf } from "@grasp-os/shared/audit";
import { permissionIdSchema } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { permissionErrors } from "@grasp-os/shared/permissions";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import type { BrainAction } from "@grasp-os/workflow-schema/format";

import { readableByEveryMember, sourcesOfWorkflow } from "../app-provenance.ts";
import {
  brainCardSchema,
  brainCorrectedSchema,
  brainEntitiesSchema,
  brainPackSchema,
  brainRememberedSchema,
  brainSkillsSelectedSchema,
  brainSkillTextSchema,
  skillReadSchema,
  skillsSelectSchema,
} from "../brain-pack.ts";
import {
  isBrainRecall,
  isMemoriesRequest,
  memoriesCallFor,
  recallFor,
  skillsCallFor,
} from "../brain-recall.ts";
import type { MemoriesOperation } from "../brain-recall.ts";
import { runAuthority, runContext } from "./resource-authority.ts";
import type { CallingRun, FrozenCatalogBinding } from "./resource-authority.ts";
import { requireNoChatReads } from "./resource-reads.ts";
import { recordRunVersions } from "./run-evidence.ts";

// A run's recall of the Brain (`ctx.brain.<alias>.recall`), and its
// skills (`ctx.brain.<alias>.skills.select` and `.read`), one of its
// named calls (resource-calls.ts, `makeCall`): its binding frozen at the
// start, its authority decided again first, its receipts kept. The
// binding names the workflow's own `{ type: "platform" }` permission to
// read the Brain, which `recallFor` checks again as it recalls, for the
// person the run acts for (who started it, or the workflow's owner for a
// trigger's or a schedule's run), still a member, and of only what
// everyone in the company may read: the same request, checks and pack as
// an App's action (threat model on GRA-1731). What it hands the run is pinned with the run
// (run-evidence.ts). Its memories and entities (`remember`, `forget`,
// `correct`, `entities.get`, `entities.find`) are an App's too (threat
// model on GRA-1837): written in the workflow's own word, under the
// change its step's key makes, so a step replayed writes once; and only
// while every member may read everything the run may have read: its pins,
// checked again before the call (resource-calls.ts `handsOut`), no read of
// the chat that started it (one person's reach), and the workflow's
// sources (app-provenance.ts).

/** A brain call, as a run's step asks it. */
export interface BrainCall {
  readonly operation: BrainAction;
  readonly arguments: Json;
}

/** What each action's request is, and what a test run says when it isn't. */
const requests: Readonly<
  Record<BrainAction, { valid: (input: unknown) => boolean; issue: string }>
> = {
  recall: {
    valid: isBrainRecall,
    issue:
      "arguments: Give a question of at most 2,000 characters, a budget of 1 to 32,000 tokens, and an ISO 8601 date-time with its offset as asOf if any.",
  },
  "skills.select": {
    valid: (input) => skillsSelectSchema.safeParse(input).success,
    issue: "arguments: Give a task of at most 2,000 characters.",
  },
  "skills.read": {
    valid: (input) => skillReadSchema.safeParse(input).success,
    issue:
      "arguments: Give a skill as a selection gave it: its scope, name and version.",
  },
  remember: {
    valid: (input) => isMemoriesRequest("remember", input),
    issue:
      "arguments: Give what it is about (its kind, and its id or names and identifiers), an attribute and value if any, and a statement of at most 1,000 characters.",
  },
  forget: {
    valid: (input) => isMemoriesRequest("forget", input),
    issue: "arguments: Give the memory's id.",
  },
  correct: {
    valid: (input) => isMemoriesRequest("correct", input),
    issue:
      "arguments: Give the memory's id, its new value if its attribute holds one, and a statement of at most 1,000 characters.",
  },
  "entities.get": {
    valid: (input) => isMemoriesRequest("entities.get", input),
    issue:
      "arguments: Give the entity's id, and asOf (an ISO 8601 date-time with its offset) and after (a page's next) if any.",
  },
  "entities.find": {
    valid: (input) => isMemoriesRequest("entities.find", input),
    issue:
      "arguments: Give a kind, a name or an identifier, and after (a page's next) if any.",
  },
};

/** What each action answers, and what a test run says when it doesn't. */
const answers: Readonly<
  Record<BrainAction, { valid: (answer: unknown) => boolean; issue: string }>
> = {
  recall: {
    valid: (answer) => brainPackSchema.safeParse(answer).success,
    issue:
      "output: Answer a pack: items (each its source, version, position, text, whole and found), notFound and truncated.",
  },
  "skills.select": {
    valid: (answer) => brainSkillsSelectedSchema.safeParse(answer).success,
    issue:
      "output: Answer skills: each its scope, name, version and description.",
  },
  "skills.read": {
    valid: (answer) => brainSkillTextSchema.safeParse(answer).success,
    issue: "output: Answer a skill: its scope, name, version and text.",
  },
  remember: {
    valid: (answer) => brainRememberedSchema.safeParse(answer).success,
    issue: "output: Answer the memory's id and its entity's.",
  },
  forget: {
    valid: (answer) => typeof answer === "boolean",
    issue: "output: Answer true or false.",
  },
  correct: {
    valid: (answer) => brainCorrectedSchema.safeParse(answer).success,
    issue: "output: Answer the fix's memory id, or null.",
  },
  "entities.get": {
    valid: (answer) => brainCardSchema.nullable().safeParse(answer).success,
    issue:
      "output: Answer a card (its entity, attributes, relations, notes and next), or null.",
  },
  "entities.find": {
    valid: (answer) => brainEntitiesSchema.safeParse(answer).success,
    issue: "output: Answer entities (each its id, kind and name) and next.",
  },
};

/** The Brain's operations on memories and entities, as `memoriesCallFor` takes them. */
const memoriesActions: ReadonlySet<BrainAction> = new Set<MemoriesOperation>([
  "remember",
  "forget",
  "correct",
  "entities.get",
  "entities.find",
]);

/** Whether `action` is one of them. */
const isMemoriesAction = (action: BrainAction): action is MemoriesOperation =>
  memoriesActions.has(action);

/** Whether `action` writes to the Brain. */
export const isBrainWrite = (action: BrainAction): boolean =>
  action === "remember" || action === "forget" || action === "correct";

/**
 * Refuses, as `workflow.call_invalid`, a call that isn't one of the
 * Brain's actions with its request: what a test run checks before it
 * answers from its fixtures.
 */
export const requireBrainRequest = (call: BrainCall): void => {
  const request = Object.hasOwn(requests, call.operation)
    ? requests[call.operation]
    : undefined;
  if (request === undefined || !request.valid(call.arguments)) {
    throw workflowResourceErrors.create("workflow.call_invalid", {
      issues: [request?.issue ?? "operation: The Brain has no such action."],
    });
  }
};

/**
 * Refuses, as `workflow.call_invalid`, a test run's fixture answer to a
 * call of the Brain that isn't what its action answers.
 */
export const requireBrainAnswer = (call: BrainCall, answer: unknown): void => {
  const { valid, issue } = answers[call.operation];
  if (!valid(answer)) {
    throw workflowResourceErrors.create("workflow.call_invalid", {
      issues: [issue],
    });
  }
};

/**
 * Makes call `call` of `run`, under its step's key `key`, through
 * `binding`, its authority already decided again (`makeCall`): what the
 * Brain answers, as JSON.
 */
export const callBrain = async (
  env: Env,
  run: CallingRun,
  binding: FrozenCatalogBinding,
  call: BrainCall,
  key: string
): Promise<Json> => {
  const { target } = binding;
  if (target.kind !== "brain") {
    throw workflowResourceErrors.create("workflow.call_denied");
  }
  const authority = runAuthority(run);
  const permissionId = permissionIdSchema.parse(target.permissionId);
  if (isMemoriesAction(call.operation)) {
    return await memoriesCallFor(
      env,
      {
        authority,
        context: runContext(run),
        permissionId,
        actor: delegateActorOf(authority),
        target: { type: "workflow_run", id: run.runId },
        writer: `workflow:${run.workflowId}`,
        // The step's key, the same in every attempt and replay of it.
        change: `run:${run.runId}:${key}`,
        mayWrite: async () => {
          await requireNoChatReads(env, run.runId);
          if (
            !readableByEveryMember(await sourcesOfWorkflow(env, run.workflowId))
          ) {
            throw permissionErrors.create("permission.denied", {
              action: "brain.write",
            });
          }
        },
        // Pinned with the run before it gets them, as a recall's pack.
        keep: async (versions) => {
          await recordRunVersions(env, run.runId, permissionId, versions);
        },
      },
      call.operation,
      call.arguments
    );
  }
  if (call.operation !== "recall") {
    const answered = await skillsCallFor(
      env,
      {
        authority,
        context: runContext(run),
        permissionId,
        actor: delegateActorOf(authority),
        target: { type: "workflow_run", id: run.runId },
        // Pinned with the run as a recall's pack is, so the skills are
        // checked again before anything leaves the run.
        keep: async (versions) => {
          await recordRunVersions(env, run.runId, permissionId, versions);
        },
      },
      call.operation,
      call.arguments
    );
    // As JSON, which the run's journal keeps.
    return "skills" in answered
      ? { skills: answered.skills.map((skill) => ({ ...skill })) }
      : { ...answered };
  }
  const pack = await recallFor(
    env,
    {
      authority,
      context: runContext(run),
      permissionId,
      actor: delegateActorOf(authority),
      target: { type: "workflow_run", id: run.runId },
      // Pinned with the run before the run gets it, so what it recalled
      // is checked again before anything leaves the run
      // (resource-reads.ts).
      keep: async ({ items }) => {
        await recordRunVersions(env, run.runId, permissionId, items);
      },
    },
    call.arguments
  );
  // As JSON, which the run's journal keeps.
  return {
    items: pack.items.map(({ source, ...item }) => ({
      ...item,
      source: { ...source },
    })),
    notFound: [...pack.notFound],
    truncated: pack.truncated,
  };
};
