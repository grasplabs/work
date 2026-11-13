import { Trans, useLingui } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { Page, PageHeading } from "../frame/page.tsx";
import { SettingsSection } from "../settings/settings-parts.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { AgentForm } from "./agent-form.tsx";
import type { Typed } from "./agent-form.tsx";

// A new agent: one of the company's, for its own admins, or one of the
// person's own, for anyone (core's agents.ts). Its name, what it is for, its
// picture, its model and its instructions, said once. Core makes it on, reaching nobody and with
// nothing it may do (agent-builder.ts), so the page it then opens is the
// agent's Access tab: an agent nobody may ask is not yet any use. One of
// a person's own is theirs to ask at once, so its page opens as it is.

/** A new agent before anything is said of it. */
const blank: Typed = {
  name: "",
  job: "",
  instructions: "",
  face: "stephen",
  model: null,
};

/** Whose a new agent is: the company's, or the person's own. */
type Whose = "company" | "own";

/**
 * The page a new agent is made on; `models`, the ones the organization
 * chose. `company`: whether the person may make one for the company, its
 * own admins alone; anyone makes one of their own.
 */
export const NewAgent = ({
  models,
  company,
}: {
  models: readonly string[];
  company: boolean;
}) => {
  const { t } = useLingui();
  const navigate = useNavigate();
  const { busy, failure, run } = useCoreAction();
  const choiceId = useId();
  const [whose, setWhose] = useState<Whose>(company ? "company" : "own");
  const choices: { value: Whose; label: string; line: string }[] = [
    {
      value: "company",
      label: t`For the company`,
      line: t`You choose who may ask it and what it may do.`,
    },
    {
      value: "own",
      label: t`Just for me`,
      line: t`Only you see and ask it. It does at most what Grasp may do for you.`,
    },
  ];
  return (
    <Page>
      <PageHeading
        description={
          whose === "company" ? (
            <Trans>
              It starts on, reaching nobody and with nothing it may do. You say
              who may ask it right after.
            </Trans>
          ) : (
            <Trans>
              An agent of your own, for a job you do often. Only you see and ask
              it, in Grasp&apos;s chat.
            </Trans>
          )
        }
        title={<Trans>New agent</Trans>}
      />
      {company ? (
        <SettingsSection
          description={t`An agent for the company, or one only you use.`}
          title={t`Who it is for`}
        >
          <fieldset className="flex flex-col gap-3">
            <legend className="sr-only">{t`Who it is for`}</legend>
            {choices.map(({ value, label, line }) => (
              <div className="flex items-start gap-3" key={value}>
                <input
                  aria-describedby={`${choiceId}-${value}-line`}
                  checked={whose === value}
                  className="mt-1"
                  disabled={busy}
                  id={`${choiceId}-${value}`}
                  name="whose"
                  onChange={() => {
                    setWhose(value);
                  }}
                  type="radio"
                  value={value}
                />
                <span className="flex flex-col gap-0.5">
                  <label htmlFor={`${choiceId}-${value}`}>{label}</label>
                  <span
                    className="text-muted-foreground"
                    id={`${choiceId}-${value}-line`}
                  >
                    {line}
                  </span>
                </span>
              </div>
            ))}
          </fieldset>
        </SettingsSection>
      ) : null}
      <SettingsSection
        description={
          whose === "company"
            ? t`Its name, job and picture show where people pick an agent. Its instructions are for the agent alone.`
            : t`Its name, job and picture show where you pick an agent. Its instructions are for the agent alone.`
        }
        title={t`What it is`}
      >
        <AgentForm
          can={!busy}
          initial={blank}
          models={models}
          onSave={async (said) => {
            // Every part is this form's, so all are said.
            const typed = { ...blank, ...said, modelRole: null };
            await run(async (session) => {
              if (whose === "own") {
                const made = await session.connections.makeOwnAgent(typed);
                await navigate({
                  to: "/agents/$agent",
                  params: { agent: made.id },
                });
                return;
              }
              const made = await session.connections.makeAgent(typed);
              await navigate({
                to: "/agents/$agent",
                params: { agent: made.id },
                search: { tab: "access" },
              });
            });
          }}
          parts={["name", "job", "face", "model", "instructions"]}
          submit={t`Make agent`}
        />
      </SettingsSection>
      <ErrorText>{failure}</ErrorText>
    </Page>
  );
};
