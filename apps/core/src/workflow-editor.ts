import { draftErrors } from "@grasp-os/shared/drafts";
import {
  workflowDraftEditSchema,
  workflowStepEditSchema,
  workflowResourceErrors,
} from "@grasp-os/shared/workflow-resources";
import type {
  WorkflowDefinitionProblem,
  WorkflowDraft,
} from "@grasp-os/shared/workflow-resources";
import { workflowSchemaUrl } from "@grasp-os/workflow-schema/format";

import type { Acting } from "./auth/identity.ts";
import { draftOf, filesOf, saveDraft } from "./drafts.ts";
import type { DraftState, DraftWriter } from "./drafts.ts";
import { requireNotStaff } from "./sharing.ts";
import { withCurrentFunctionNames } from "./workflow-app-functions.ts";
import { workflowDiagram } from "./workflow-diagram.ts";
import {
  definitionProblems,
  requireWorkflowRole,
  workflowDraftKind,
  workflowFile,
} from "./workflow-resources.ts";
import { applyStepEdit } from "./workflow-steps.ts";

// A workflow's draft as its editor and its builders' agents write it
// (platform specification 13.10 and 22.7): one file, `workflow.json`, in
// the draft every subject shares (drafts.ts), whose revisions, conflicts,
// checkpoints and audit are drafts.ts's. Nothing runs a draft but a test
// run of an exact revision (workflows/candidate-runs.ts); a person
// publishes it (publish.ts, workflow-publish.ts).
//
// Threat model, and how each is closed:
//
// - Two editors, or an editor and an agent, at once: every edit names the
//   revision it read, and the second of two made from one read is
//   refused (`draft.conflict`), never merged (drafts.ts).
// - Text that doesn't pass: saved all the same, as a draft may be
//   incomplete, with what the profile and the catalog say of it, read
//   afresh each time (`definitionProblems`), and drawn as a diagram only
//   while it has no problems. A publish or a test run checks it again.
// - Disclosure: a definition can hold a sensitive parameter's default,
//   so only the workflow's builders read or edit its draft, as only they
//   read its published definitions. Grasp staff don't edit it.
// - Growth: an edit is bounded as a definition is (1 MiB), and its
//   problems as below.

/**
 * The most a draft's problems take as JSON: a problem's pointer escapes
 * characters of the text as two (`/` as `~1`), so a single one can
 * outgrow the text. Past this, they are answered as one short one.
 */
const maxProblemBytes = 256 * 1024;

/** `problems` within `maxProblemBytes`. */
const boundedProblems = (
  problems: WorkflowDefinitionProblem[]
): WorkflowDefinitionProblem[] => {
  const bytes = new TextEncoder().encode(JSON.stringify(problems)).byteLength;
  if (bytes <= maxProblemBytes) {
    return problems;
  }
  return [
    {
      code: "definition.problems_too_large",
      message: `The definition has ${problems.length} problems, too long together to show.`,
      pointer: "/",
      remedy:
        "Look for very long keys or values, shorten them, and check again.",
    },
  ];
};

/**
 * The draft of a workflow with no version that nobody wrote yet: one that
 * passes, with no steps.
 */
const starterDefinition = `${JSON.stringify(
  { $schema: workflowSchemaUrl, steps: [] },
  null,
  2
)}\n`;

/** The text of workflow `id`'s `draft`: its `workflow.json`. */
const textOf = async (
  env: Env,
  id: string,
  draft: DraftState
): Promise<string> => {
  const files = await filesOf(env, workflowDraftKind, id, draft);
  return files.get(workflowFile) ?? starterDefinition;
};

/** `source`, at `revision`, as the editor shows it. */
const shown = async (
  env: Env,
  by: Acting,
  id: string,
  revision: number,
  source: string
): Promise<WorkflowDraft> => {
  const problems = boundedProblems(
    await definitionProblems(env, by, source, id)
  );
  return {
    revision,
    source,
    problems,
    diagram: problems.length === 0 ? workflowDiagram(source) : null,
  };
};

/**
 * The text of workflow `id`'s draft at exactly `revision`, for a test run
 * of it (workflows/candidate-runs.ts): `draft.conflict` once the draft
 * moved past it. Whether it passes is the run's to check.
 */
export const draftText = async (
  env: Env,
  id: string,
  revision: number
): Promise<string> => {
  const draft = await draftOf(env, workflowDraftKind, id);
  if (draft.revision !== revision) {
    throw draftErrors.create("draft.conflict");
  }
  return await textOf(env, id, draft);
};

/** Workflow `id`'s draft, for `by`, who must build it (`WorkflowDraft`). */
export const workflowDraft = async (
  env: Env,
  by: Acting,
  id: unknown
): Promise<WorkflowDraft> => {
  const workflow = await requireWorkflowRole(env, by, id, "builder");
  const draft = await draftOf(env, workflowDraftKind, workflow.id);
  return await shown(
    env,
    by,
    workflow.id,
    draft.revision,
    await textOf(env, workflow.id, draft)
  );
};

/** The chat whose agent writes a draft: in which turn and code step. */
export interface ChatWriter {
  chatId: string;
  turnId: string | null;
  callId: string | null;
}

/**
 * Saves `input` (`workflowDraftEditSchema`) as workflow `id`'s draft for
 * `by`, who must build it and isn't Grasp staff, over the revision they
 * read (`draft.conflict` otherwise): as their own checkpoint, or the turn
 * of `chat`'s agent's. The text is kept as written, problems and all; a
 * text that is the live version's again is no change. `step` names the
 * step edited on the canvas, which its audit event names. `admit`, if
 * given, admits the write right before it commits. Answers the draft as
 * saved.
 */
export const editWorkflowDraft = async (
  env: Env,
  by: Acting,
  id: unknown,
  input: unknown,
  {
    chat,
    admit,
    step,
  }: {
    chat?: ChatWriter;
    admit?: () => Promise<void>;
    step?: { kind: "change" | "insert"; pointer: string };
  } = {}
): Promise<WorkflowDraft> => {
  requireNotStaff(by);
  const workflow = await requireWorkflowRole(env, by, id, "builder");
  const { revision, source: given } = workflowResourceErrors.parse(
    "workflow.resource_invalid",
    workflowDraftEditSchema,
    input
  );
  // Each App function it calls named as its App names it now: the hint
  // its code's member is named by (workflow-app-functions.ts).
  const source = await withCurrentFunctionNames(env, by, given);
  const draft = await draftOf(env, workflowDraftKind, workflow.id);
  if (draft.revision !== revision) {
    throw draftErrors.create("draft.conflict");
  }
  const live = await filesOf(env, workflowDraftKind, workflow.id, {
    base: draft.base,
    changes: {},
  });
  const after = await shown(env, by, workflow.id, revision + 1, source);
  const writer: DraftWriter =
    chat === undefined
      ? {
          by,
          detail: {
            problems: after.problems.length,
            ...(step === undefined
              ? {}
              : { step: step.kind, stepPointer: step.pointer }),
          },
        }
      : { by, chat };
  await saveDraft(
    env,
    workflowDraftKind,
    workflow.id,
    draft,
    live.get(workflowFile) === source
      ? { changes: {}, unchanged: [workflowFile] }
      : { changes: { [workflowFile]: source } },
    writer,
    admit
  );
  return after;
};

/**
 * Inserts or changes one step of workflow `id`'s draft for `by`, who must
 * build it (`workflowStepEditSchema`, workflow-steps.ts): applied to the
 * draft as it is at the revision they read, and saved exactly as
 * `editWorkflowDraft` saves an edit. The canvas and a chat's agent both
 * edit a step through this.
 */
export const editWorkflowStep = async (
  env: Env,
  by: Acting,
  id: unknown,
  input: unknown,
  writer: { chat?: ChatWriter; admit?: () => Promise<void> } = {}
): Promise<WorkflowDraft> => {
  requireNotStaff(by);
  const workflow = await requireWorkflowRole(env, by, id, "builder");
  const { revision, edit } = workflowResourceErrors.parse(
    "workflow.resource_invalid",
    workflowStepEditSchema,
    input
  );
  const source = await draftText(env, workflow.id, revision);
  return await editWorkflowDraft(
    env,
    by,
    workflow.id,
    { revision, source: applyStepEdit(source, edit) },
    {
      ...writer,
      step: {
        kind: edit.kind,
        pointer:
          edit.kind === "change"
            ? edit.pointer
            : `${edit.list}/${String(edit.index)}`,
      },
    }
  );
};
