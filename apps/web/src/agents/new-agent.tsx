import { failureText } from "@grasp-os/shared/errors";
import {
  instructionFileErrors,
  instructionsMaxLength,
  instructionsTooLong,
} from "@grasp-os/shared/instruction-files";
import { Trans, useLingui } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";

import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { Page, PageHeading } from "../frame/page.tsx";
import { SettingsSection } from "../settings/settings-parts.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { workOutQuietly } from "./agent-apps-card.tsx";
import { AgentForm } from "./agent-form.tsx";
import type { Typed } from "./agent-form.tsx";
import { keepUnsaved } from "./unsaved-instructions.ts";

// A new agent: one of the company's, for its own admins, or one of the
// person's own, for anyone (core's agents.ts). Its name, what it is for, its
// picture, its model and its instructions, said once. Core makes it on, reaching nobody and with
// nothing it may do (agent-builder.ts), so the page it then opens is the
// agent's Access tab: an agent nobody may ask is not yet any use. One of
// a person's own is theirs to ask at once, so its page opens as it is.
// Its instructions are measured as their save measures them first, so
// ones it would refuse make nothing; then they are saved as its
// instruction file's first version. Should that save fail all the same,
// the agent is made, and its page opens on Instructions with what was
// typed as an unsaved draft and why it wasn't saved
// (unsaved-instructions.ts).

/** A new agent before anything is said of it. */
const blank: Typed = {
  name: "",
  job: "",
  instructions: "",
  face: "stephen",
  model: null,
};

/**
 * Saves `instructions` as the new agent `agentId`'s instruction file, and
 * then works out the apps they call for: whether they were saved. Not
 * saved, they are kept for its page with why (`keepUnsaved`).
 */
const saveFirstInstructions = async (
  session: Session,
  agentId: string,
  instructions: string
): Promise<boolean> => {
  const change = crypto.randomUUID();
  try {
    await session.instructions.save({
      file: { scope: "agent", agentId },
      change,
      text: instructions,
      after: 0,
    });
  } catch (error) {
    keepUnsaved(agentId, {
      text: instructions,
      change,
      failure: failureText(error),
    });
    return false;
  }
  await workOutQuietly(session, agentId);
  return true;
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
  own = true,
}: {
  models: readonly string[];
  company: boolean;
  /** Whether the company lets people have agents of their own. */
  own?: boolean;
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
      {company && own ? (
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
            const { instructions = "", ...typed } = {
              ...blank,
              ...said,
              modelRole: null,
            };
            await run(async (session) => {
              // Refused before anything is made, as their save would be.
              if (instructionsTooLong(instructions)) {
                throw instructionFileErrors.create("instructions.too_large", {
                  maxLength: instructionsMaxLength,
                });
              }
              const made =
                whose === "own"
                  ? await session.connections.makeOwnAgent(typed)
                  : await session.connections.makeAgent(typed);
              const told =
                instructions.trim() === "" ||
                (await saveFirstInstructions(session, made.id, instructions));
              if (!told) {
                await navigate({
                  to: "/agents/$agent",
                  params: { agent: made.id },
                  search: { tab: "instructions" },
                });
                return;
              }
              if (whose === "own") {
                await navigate({
                  to: "/agents/$agent",
                  params: { agent: made.id },
                });
                return;
              }
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
