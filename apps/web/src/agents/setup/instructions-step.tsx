import { instructionsMaxLength } from "@grasp-os/shared/instruction-files";
import { Field } from "@grasp-os/ui/components/field";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import type { StepProps } from "./model.ts";
import { Question } from "./question.tsx";

// How it works: its instructions as one document, in the five parts of
// agent-brief.ts, a heading each, as Grasp proposed them. It never makes
// the page scroll (Ruben): the field has a fixed height and scrolls in
// itself. The library's document editor takes its place once it ships
// (the UI orchestrator, build/document-editor), with Configure with agent;
// it reads this same Markdown.

/** How many lines the document shows before it scrolls in itself. */
const shownLines = 12;

const styles = stylex.create({
  // A fixed height: the document scrolls inside, the page never.
  document: { maxHeight: "22rem" },
});

export const InstructionsStep = ({ setup, change, name }: StepProps) => {
  const { t } = useLingui();
  return (
    <Question
      line={t`We wrote these for you. Change what you like.`}
      title={t`How should ${name} work?`}
    >
      <Field>
        <Textarea
          aria-label={t`Instructions`}
          style={styles.document}
          maxLength={instructionsMaxLength}
          onValueChange={(value) => {
            change({ instructions: value, instructionsTouched: true });
          }}
          rows={shownLines}
          value={setup.instructions}
        />
      </Field>
    </Question>
  );
};
