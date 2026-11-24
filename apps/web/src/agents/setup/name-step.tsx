import { agentNameMax } from "@grasp-os/shared/agents";
import { Field, FieldError } from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import type { StepProps } from "./model.ts";
import { Question } from "./question.tsx";

// The first question: its name. Once typed, the title is the name itself.
// The field is as wide as a name needs, in the middle (Ruben, 21 November:
// a field the page's width for one word had no taste).

const styles = stylex.create({
  field: {
    width: "100%",
    maxWidth: "22rem",
    justifySelf: "center",
  },
});

export const NameStep = ({ setup, change, name, nameTaken }: StepProps) => {
  const { t } = useLingui();
  return (
    <Question title={name === "" ? t`What should we call your agent?` : name}>
      <Field data-invalid={nameTaken} style={styles.field}>
        <Input
          aria-label={t`Name`}
          autoComplete="off"
          autoFocus
          maxLength={agentNameMax}
          onValueChange={(value) => {
            change({ name: value });
          }}
          placeholder={t`Invoice chaser`}
          size="lg"
          value={setup.name}
        />
        {nameTaken ? (
          <FieldError>{t`Another agent has this name.`}</FieldError>
        ) : null}
      </Field>
    </Question>
  );
};
