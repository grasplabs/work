import type { BrainPack } from "@grasp-os/runtime/app";
import { delegateActorOf } from "@grasp-os/shared/audit";
import { permissionIdSchema } from "@grasp-os/shared/ids";
import type { Json } from "@grasp-os/shared/json";
import { workflowResourceErrors } from "@grasp-os/shared/workflow-resources";
import { z } from "zod";

import { isBrainRecall, recallFor } from "../brain-recall.ts";
import { runAuthority, runContext } from "./resource-authority.ts";
import type { CallingRun, FrozenCatalogBinding } from "./resource-authority.ts";
import { recordRunVersions } from "./run-evidence.ts";

// A run's recall of the Brain (`ctx.brain.<alias>.recall`), one of its
// named calls (resource-calls.ts, `makeCall`): its binding frozen at the
// start, its authority decided again first, its receipts kept. The
// binding names the workflow's own `{ type: "platform" }` permission to
// read the Brain, which `recallFor` checks again as it recalls, as the
// person the run acts for (who started it, or the workflow's owner for a
// trigger's or a schedule's run), never more: the same request, checks
// and pack as an App's action and a chat's code (threat model on
// GRA-1731). What it hands the run is pinned with the run
// (run-evidence.ts).

/** A brain call, as a run's step asks it. */
export interface BrainCall {
  readonly operation: "recall";
  readonly arguments: Json;
}

/**
 * Refuses, as `workflow.call_invalid`, a call that isn't a recall of a
 * request: what a test run checks before it answers from its fixtures.
 */
export const requireBrainRequest = (call: BrainCall): void => {
  if (call.operation !== "recall" || !isBrainRecall(call.arguments)) {
    throw workflowResourceErrors.create("workflow.call_invalid", {
      issues: [
        "arguments: Give a question of at most 2,000 characters, a budget of 1 to 32,000 tokens, and an ISO 8601 date-time with its offset as asOf if any.",
      ],
    });
  }
};

/**
 * A pack, as a test run's fixture answers a recall: what a real recall
 * answers (`BrainPack`), and nothing else.
 */
const brainPackSchema: z.ZodType<BrainPack> = z.strictObject({
  items: z.array(
    z.strictObject({
      source: z.strictObject({
        producer: z.enum(["upload", "chat", "run"]),
        id: z.string().min(1),
      }),
      version: z.int().positive(),
      position: z.int().nonnegative(),
      text: z.string(),
      whole: z.boolean(),
      found: z.enum(["exact", "words", "stop words", "meaning"]),
    })
  ),
  notFound: z.array(z.string()),
  truncated: z.boolean(),
});

/**
 * Refuses, as `workflow.call_invalid`, a test run's fixture answer to a
 * recall that isn't a pack.
 */
export const requireBrainAnswer = (answer: unknown): void => {
  if (!brainPackSchema.safeParse(answer).success) {
    throw workflowResourceErrors.create("workflow.call_invalid", {
      issues: [
        "output: Answer a pack: items (each its source, version, position, text, whole and found), notFound and truncated.",
      ],
    });
  }
};

/**
 * Recalls for call `call` of `run` through `binding`, its authority already
 * decided again (`makeCall`): the pack.
 */
export const callBrain = async (
  env: Env,
  run: CallingRun,
  binding: FrozenCatalogBinding,
  call: BrainCall
): Promise<Json> => {
  const { target } = binding;
  if (target.kind !== "brain") {
    throw workflowResourceErrors.create("workflow.call_denied");
  }
  const authority = runAuthority(run);
  const permissionId = permissionIdSchema.parse(target.permissionId);
  const pack = await recallFor(
    env,
    {
      authority,
      context: runContext(run),
      permissionId,
      actor: delegateActorOf(authority),
      target: { type: "workflow_run", id: run.runId },
    },
    call.arguments
  );
  // Pinned with the run before the run gets it, so what it recalled is
  // checked again before anything leaves the run (resource-reads.ts).
  await recordRunVersions(env, run.runId, permissionId, pack.items);
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
