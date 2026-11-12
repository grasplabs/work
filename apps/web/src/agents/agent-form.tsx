import {
  agentInstructionsMax,
  agentJobMax,
  agentNameMax,
} from "@grasp-os/shared/agents";
import { Button } from "@grasp-os/ui/components/button";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { Trans, useLingui } from "@lingui/react/macro";
import { useId, useState } from "react";

// What an admin types of an agent: its name, what it is for and its
// instructions. The new agent's page asks for all three at once
// (new-agent.tsx); an agent's own page has its name and job on one card
// and its instructions on another (agent-page.tsx), each saved by itself.

/** What an admin types of an agent. */
export interface Typed {
  name: string;
  job: string;
  instructions: string;
}

/** Which of an agent's words a form asks for. */
type Part = keyof Typed;

/** A form for `parts` of an agent, saved together. */
export const AgentForm = ({
  initial,
  parts,
  submit,
  can,
  onSave,
}: {
  initial: Typed;
  parts: readonly Part[];
  submit: string;
  can: boolean;
  onSave: (typed: Typed) => Promise<void>;
}) => {
  const { t } = useLingui();
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
        void onSave({
          ...typed,
          name: typed.name.trim(),
          job: typed.job.trim(),
        });
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
