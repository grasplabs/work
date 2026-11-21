import { agentNameMax } from "@grasp-os/shared/agents";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { Field, FieldError } from "../../grasp/field/index.ts";
import { Input } from "../../grasp/input/index.ts";
import type { StepProps } from "./model.ts";
import { Question } from "./question.tsx";

// The first question: its name. Once typed, the title is the name itself.
// The field is as wide as a name needs, in the middle (Ruben, 21 November:
// a field the page's width for one word had no taste).

const styles = stylex.create({
  field: { width: "100%", maxWidth: "22rem", justifySelf: "center" },
});

export const NameStep = ({ setup, change, name, nameTaken }: StepProps) => {
  const { t } = useLingui();
  return (
    <Question title={name === "" ? t`What should we call your agent?` : name}>
      <Field invalid={nameTaken} layout={styles.field}>
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
