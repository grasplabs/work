import {
  agentFaces,
  agentInstructionsMax,
  agentJobMax,
  agentNameMax,
} from "@grasp-os/shared/agents";
import type { AgentFace } from "@grasp-os/shared/agents";
import { Button } from "@grasp-os/ui/components/button";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useId, useState } from "react";

import { modelName } from "../chat/composer.tsx";
import { AgentAvatar, faceOf } from "./agent-avatar.tsx";

// What an admin says of an agent: its name, what it is for, the picture
// it is drawn with, the model its turns use and its instructions. The
// new agent's page asks for all at once (new-agent.tsx); an agent's own
// page has them on cards of their own (agent-page.tsx), each saved by
// itself.

/** What an admin says of an agent. */
export interface Typed {
  name: string;
  job: string;
  instructions: string;
  /** The figure it is drawn with, by name. */
  face: string;
  /** The model its turns use; null for the one its asker picks. */
  model: string | null;
}

/** Each picture, as a screen reader names it. */
const faceNames = {
  stephen: msg`Head`,
  brain: msg`Brain`,
  pen: msg`Pen`,
  lines: msg`Lines`,
  flow: msg`Flow`,
  check: msg`Check mark`,
} as const satisfies Record<AgentFace, unknown>;

/** No models to give an agent: a form that doesn't ask for one. */
const noModels: readonly string[] = [];

/** The value of "the asker's own model" in the model's select. */
const askersOwn = "";

/** Which of an agent's words a form asks for. */
type Part = keyof Typed;

/** A form for `parts` of an agent, saved together. */
export const AgentForm = ({
  initial,
  parts,
  submit,
  can,
  models = noModels,
  onSave,
}: {
  initial: Typed;
  parts: readonly Part[];
  submit: string;
  can: boolean;
  /** The models the organization chose, which an agent can be given. */
  models?: readonly string[];
  /** What the form's own `parts` now say: nothing of the rest of the agent. */
  onSave: (said: Partial<Typed>) => Promise<void>;
}) => {
  const { t, i18n } = useLingui();
  const faceId = useId();
  const modelId = useId();
  const nameId = useId();
  const jobId = useId();
  const instructionsId = useId();
  const [typed, setTyped] = useState<Typed>(initial);
  const changed = parts.some((part) => typed[part] !== initial[part]);
  return (
    <form
      className="flex flex-col gap-4 px-5 pb-5"
      onSubmit={(event) => {
        event.preventDefault();
        // Only this form's parts: another card may have saved the rest
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
        <Field>
          <FieldLabel htmlFor={nameId}>
            <Trans>Name</Trans>
          </FieldLabel>
          <Input
            autoComplete="off"
            disabled={!can}
            id={nameId}
            maxLength={agentNameMax}
            onChange={(event) => {
              setTyped({ ...typed, name: event.target.value });
            }}
            value={typed.name}
          />
        </Field>
      ) : null}
      {parts.includes("job") ? (
        <Field>
          <FieldLabel htmlFor={jobId}>
            <Trans>What it is for</Trans>
          </FieldLabel>
          <Input
            autoComplete="off"
            disabled={!can}
            id={jobId}
            maxLength={agentJobMax}
            onChange={(event) => {
              setTyped({ ...typed, job: event.target.value });
            }}
            placeholder={t`One line, such as: chases unpaid invoices.`}
            value={typed.job}
          />
        </Field>
      ) : null}
      {parts.includes("face") ? (
        <Field>
          <span className="text-sm font-medium">
            <Trans>Picture</Trans>
          </span>
          <div
            aria-label={t`Picture`}
            className="flex flex-wrap gap-2"
            role="radiogroup"
          >
            {agentFaces.map((face) => (
              <label className="cursor-pointer" key={face}>
                <input
                  aria-label={i18n._(faceNames[face])}
                  checked={faceOf(typed.face) === face}
                  className="peer sr-only"
                  disabled={!can}
                  name={faceId}
                  onChange={() => {
                    setTyped({ ...typed, face });
                  }}
                  type="radio"
                />
                <span className="peer-checked:ring-ring peer-focus-visible:ring-ring/50 block rounded-full opacity-70 ring-offset-2 peer-checked:opacity-100 peer-checked:ring-2 peer-focus-visible:ring-2 hover:opacity-100">
                  <AgentAvatar face={face} />
                </span>
              </label>
            ))}
          </div>
        </Field>
      ) : null}
      {parts.includes("model") ? (
        <Field>
          <FieldLabel htmlFor={modelId}>
            <Trans>Model</Trans>
          </FieldLabel>
          <NativeSelect
            disabled={!can}
            id={modelId}
            onChange={(event) => {
              const { value } = event.target;
              setTyped({ ...typed, model: value === askersOwn ? null : value });
            }}
            value={typed.model ?? askersOwn}
          >
            <NativeSelectOption value={askersOwn}>
              {t`The one the person asking picks`}
            </NativeSelectOption>
            {/* Its own model stays offered while it has one the organization no longer chose. */}
            {[
              ...models,
              ...(typed.model === null || models.includes(typed.model)
                ? []
                : [typed.model]),
            ].map((model) => (
              <NativeSelectOption key={model} value={model}>
                {modelName(model)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <p className="text-muted-foreground text-sm">
            <Trans>
              With a model of its own, it answers with that one whatever the
              person picked. If your organization stops using that model, it
              answers with theirs again.
            </Trans>
          </p>
        </Field>
      ) : null}
      {parts.includes("instructions") ? (
        <Field>
          <FieldLabel htmlFor={instructionsId}>
            <Trans>Instructions</Trans>
          </FieldLabel>
          <Textarea
            disabled={!can}
            id={instructionsId}
            maxLength={agentInstructionsMax}
            onChange={(event) => {
              setTyped({ ...typed, instructions: event.target.value });
            }}
            placeholder={t`What it should know and how it should work. Grasp's own rules always hold over these.`}
            rows={parts.length === 1 ? 14 : 8}
            value={typed.instructions}
          />
        </Field>
      ) : null}
      <div className="flex justify-end">
        <Button
          disabled={!can || typed.name.trim() === "" || !changed}
          type="submit"
        >
          {submit}
        </Button>
      </div>
    </form>
  );
};
