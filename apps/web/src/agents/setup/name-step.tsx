import { agentNameMax } from "@grasp-os/shared/agents";
import { useLingui } from "@lingui/react/macro";

import { Field, FieldError } from "../../grasp/field/index.ts";
import { Input } from "../../grasp/input/index.ts";
import type { StepProps } from "./model.ts";
import { Question } from "./question.tsx";

// The first question: its name. Once typed, the title is the name itself.

export const NameStep = ({ setup, change, name, nameTaken }: StepProps) => {
  const { t } = useLingui();
  return (
    <Question title={name === "" ? t`What should we call your agent?` : name}>
      <Field invalid={nameTaken}>
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
