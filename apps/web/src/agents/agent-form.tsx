import {
  agentInstructionsMax,
  agentJobMax,
  agentNameMax,
} from "@grasp-os/shared/agents";
import { useLingui } from "@lingui/react/macro";
import { useState } from "react";

import { modelName } from "../chat/model-names.tsx";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "../grasp/field/index.ts";
import { Form } from "../grasp/form/index.ts";
import { Input } from "../grasp/input/index.ts";
import { Select } from "../grasp/select/index.ts";
import { Textarea } from "../grasp/textarea/index.ts";

// What an admin says of an agent: its name, what it is for, the model its
// turns use and its instructions. Its face is the Agent mark, drawn from
// its name, so a new name gives it a new face. A form of Grasp UI's
// fields, without its own button: the dialog or card it stands in has
// the submit button, tied to it by `id` (`<Button form={id} type="submit">`). A new agent asks for all at once
// (new-agent.tsx); an agent's page asks for some of them at a time
// (agent-page.tsx), and saves only those.

/** What an admin says of an agent. */
export interface Typed {
  name: string;
  job: string;
  instructions: string;
  /**
   * The figure core keeps for it, passed back unchanged: it is drawn with
   * Grasp UI's Agent mark, from its name, so nobody picks a figure now.
   */
  face: string;
  /** The model its turns use; null for the one its asker picks. */
  model: string | null;
}

/** No models to give an agent: a form that doesn't ask for one. */
const noModels: readonly string[] = [];

/** The value of "the asker's own model" in the model's select. */
const askersOwn = "asker";

/** Which of an agent's words a form asks for. */
export type Part = Exclude<keyof Typed, "face">;

/** A form for `parts` of an agent, saved together by the button tied to `id`. */
export const AgentForm = ({
  id,
  initial,
  parts,
  can,
  models = noModels,
  onSave,
}: {
  /** The form's id, which its submit button names. */
  id: string;
  initial: Typed;
  parts: readonly Part[];
  can: boolean;
  /** The models the organization chose, which an agent can be given. */
  models?: readonly string[];
  /** What the form's own `parts` now say: nothing of the rest of the agent. */
  onSave: (said: Partial<Typed>) => Promise<void>;
}) => {
  const { t } = useLingui();
  const [typed, setTyped] = useState<Typed>(initial);
  // Its own model stays offered while it has one the organization no longer chose.
  const offered = [
    ...models,
    ...(typed.model === null || models.includes(typed.model)
      ? []
      : [typed.model]),
  ];
  return (
    <Form
      id={id}
      onSubmit={(event) => {
        event.preventDefault();
        // Only this form's parts: another form may have saved the rest
        // since this one was shown, and what it holds of them is old.
        const trimmed: Typed = {
          ...typed,
          name: typed.name.trim(),
          job: typed.job.trim(),
        };
        void onSave(
          Object.fromEntries(parts.map((part) => [part, trimmed[part]]))
        );
      }}
    >
      {parts.includes("name") ? (
        <Field disabled={!can}>
          <FieldLabel>{t`Name`}</FieldLabel>
          <Input
            autoComplete="off"
            maxLength={agentNameMax}
            onValueChange={(name) => {
              setTyped({ ...typed, name });
            }}
            required
            value={typed.name}
          />
          <FieldError match="valueMissing">{t`Give it a name.`}</FieldError>
        </Field>
      ) : null}
      {parts.includes("job") ? (
        <Field disabled={!can}>
          <FieldLabel>{t`What it is for`}</FieldLabel>
          <Input
            autoComplete="off"
            maxLength={agentJobMax}
            onValueChange={(job) => {
              setTyped({ ...typed, job });
            }}
            placeholder={t`Chases unpaid invoices`}
            value={typed.job}
          />
        </Field>
      ) : null}
      {parts.includes("model") ? (
        <Field disabled={!can}>
          <FieldLabel>{t`Model`}</FieldLabel>
          <Select
            disabled={!can}
            items={[
              { value: askersOwn, label: t`The one the person asking picks` },
              ...offered.map((model) => ({
                value: model,
                label: modelName(model),
              })),
            ]}
            onValueChange={(value) => {
              setTyped({
                ...typed,
                model: value === null || value === askersOwn ? null : value,
              });
            }}
            value={typed.model ?? askersOwn}
          />
          <FieldDescription>
            {t`If your organization stops using its model, it answers with the asker's.`}
          </FieldDescription>
        </Field>
      ) : null}
      {parts.includes("instructions") ? (
        <Field disabled={!can}>
          <FieldLabel>{t`Instructions`}</FieldLabel>
          <Textarea
            maxLength={agentInstructionsMax}
            onValueChange={(instructions) => {
              setTyped({ ...typed, instructions });
            }}
            placeholder={t`What it should know and how it should work.`}
            rows={parts.length === 1 ? 16 : 6}
            value={typed.instructions}
          />
          <FieldDescription>
            {t`Grasp's own rules always hold over these.`}
          </FieldDescription>
        </Field>
      ) : null}
    </Form>
  );
};
