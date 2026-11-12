import { Trans, useLingui } from "@lingui/react/macro";
import { useNavigate } from "@tanstack/react-router";

import { ErrorText } from "../error-text.tsx";
import { Page, PageHeading } from "../frame/page.tsx";
import { SettingsSection } from "../settings/settings-parts.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { AgentForm } from "./agent-form.tsx";

// A new agent, for the company's admins: its name, what it is for, its
// picture, its model and its instructions, said once. Core makes it on, reaching nobody and with
// nothing it may do (agent-builder.ts), so the page it then opens is the
// agent's Access tab: an agent nobody may ask is not yet any use.

/** The page a new agent is made on; `models`, the ones the organization chose. */
export const NewAgent = ({ models }: { models: readonly string[] }) => {
  const { t } = useLingui();
  const navigate = useNavigate();
  const { busy, failure, run } = useCoreAction();
  return (
    <Page>
      <PageHeading
        description={
          <Trans>
            It starts on, reaching nobody and with nothing it may do. You say
            who may ask it right after.
          </Trans>
        }
        title={<Trans>New agent</Trans>}
      />
      <SettingsSection
        description={t`Its name, job and picture show where people pick an agent. Its instructions are for the agent alone.`}
        title={t`What it is`}
      >
        <AgentForm
          can={!busy}
          initial={{
            name: "",
            job: "",
            instructions: "",
            face: "stephen",
            model: null,
          }}
          models={models}
          onSave={async (typed) => {
            await run(async (session) => {
              const made = await session.connections.makeAgent({
                ...typed,
                modelRole: null,
              });
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
