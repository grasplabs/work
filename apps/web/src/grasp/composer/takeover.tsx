// ComposerTakeover, now QuestionTool's row of buttons (`<QuestionTool embedded kind="single"
// variant="buttons">`, given as the composer's `takeover`): a thin wrapper for one step, so nothing
// breaks. It draws the same line and row of choices. The codemod moves each use:
//
//   <ComposerTakeover prompt="Pick a project to continue." choices={projects} onChoose={choose} />
//   becomes <QuestionTool embedded kind="single" variant="buttons" question="Pick a project to continue."
//     options={projects} onSubmit={(answer) => choose(answer[0] ?? "")} />
"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 3: Composer takeover stays a wrapper over QuestionTool's buttons until step 9 removes it (handover/audit/RELEASE.md §7). */
import { QuestionTool } from "../question-tool";
import type { QuestionOption } from "../question-tool";

/** @deprecated Use `QuestionOption`, from `@/components/grasp/question-tool`. */
export type ComposerChoice = Pick<QuestionOption, "value" | "label">;

/** @deprecated Use `QuestionToolProps`, from `@/components/grasp/question-tool`, with `variant="buttons"`. */
export interface ComposerTakeoverProps {
  /** The line that says what is needed ("Pick a project to continue."). It names the choices. */
  prompt: string;
  /** The choices, as buttons in a row. */
  choices: ComposerChoice[];
  /** Runs with the chosen value. */
  onChoose: (value: string) => unknown;
}

/** @deprecated Use `QuestionTool`, from `@/components/grasp/question-tool`, with `embedded`, `kind="single"` and `variant="buttons"`. */
export const ComposerTakeover = ({
  prompt,
  choices,
  onChoose,
}: ComposerTakeoverProps) => (
  <QuestionTool
    embedded
    kind="single"
    variant="buttons"
    question={prompt}
    options={choices}
    onSubmit={(answer) => {
      onChoose(answer[0] ?? "");
    }}
  />
);
