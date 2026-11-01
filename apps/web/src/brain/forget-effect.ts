import type {
  BrainForgetPreview,
  BrainForgetTarget,
  Workspace,
} from "@grasp-os/shared/brain";

import { buildBrain } from "./brain.ts";
import type { Brain } from "./brain.ts";

// What taking something out of the brain takes with it, to say before it
// is done: the prototype's `lib/brain-forget.ts`. Core says which
// statements go and which workflows lose their source
// (`brain.forgetPreview`); the notes resting on nothing else are the ones
// the brain, built again without them, no longer has.

/** What goes with it, to say before it is done. */
export interface ForgetEffect {
  /** How many things that were said go. */
  statements: number;
  /** The notes of the brain that rest on nothing else and go too, by title. */
  notes: string[];
  /** The workflows with numbers that rested on the source: they keep them, and say their source was removed. */
  workflows: string[];
}

/**
 * `workspace` as the brain will read it once `preview` is taken out: the
 * statements gone, and the source gone with them, as core keeps it. What
 * followed a statement up stands on its own.
 */
export const withoutPreviewed = (
  workspace: Workspace,
  preview: BrainForgetPreview
): Workspace => {
  const gone = new Set(preview.statements);
  return {
    ...workspace,
    statements: workspace.statements
      .filter(({ id }) => !gone.has(id))
      .map((statement) => {
        if (
          statement.followsUp === undefined ||
          !gone.has(statement.followsUp)
        ) {
          return statement;
        }
        const { followsUp: _gone, ...rest } = statement;
        return rest;
      }),
    sources: workspace.sources.map((source) =>
      source.id === preview.source
        ? {
            id: source.id,
            kind: source.kind,
            title: "",
            date: source.date,
            removedAt: source.date,
          }
        : source
    ),
  };
};

/** What taking `target` out of `workspace` takes with it, as core previewed it. */
export const forgetEffect = (
  workspace: Workspace,
  brain: Pick<Brain, "notes">,
  target: BrainForgetTarget,
  preview: BrainForgetPreview
): ForgetEffect => {
  const left = new Set(
    buildBrain(withoutPreviewed(workspace, preview)).notes.map(({ id }) => id)
  );
  const own = "source" in target ? target.source : undefined;
  const workflows = new Set(preview.workflows);
  return {
    statements: preview.statements.length,
    notes: brain.notes
      .filter(
        ({ id, kind }) => !left.has(id) && id !== own && kind !== "statement"
      )
      .map(({ title }) => title),
    workflows: workspace.workflows
      .filter(({ id }) => workflows.has(id))
      .map(({ name }) => name),
  };
};
