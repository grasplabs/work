import { isAdmin } from "@grasp-os/shared/roles";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { InstructionFileEditor } from "../settings/instruction-file.tsx";
import {
  SettingsBody,
  SettingsError,
  SettingsLoading,
  SettingsSection,
} from "../settings/settings-parts.tsx";

// Settings → Instructions: what every chat starts with (core's
// instruction-files.ts). Everyone writes their own, which only their own
// chats have; an admin also writes the company's instructions and its
// lasting facts, which every chat has. Core refuses anyone else.

const companyInstructions = { scope: "company", name: "instructions" } as const;
const companyFacts = { scope: "company", name: "facts" } as const;

const Instructions = () => {
  const { t } = useLingui();
  const { own, company } = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  return (
    <>
      <SettingsSection
        description={t`What your chats with Grasp start with, and only yours: how you like to work, what you are responsible for.`}
        title={t`Your instructions`}
      >
        <SettingsBody>
          {own.state === "ready" ? (
            <InstructionFileEditor
              description={t`Only you and your own chats read it, never a chat others share.`}
              file={{ scope: "person", personId: identity.userId }}
              label={t`Your instructions`}
              saved={own.data}
            />
          ) : (
            <NotLoadedState heading="h3" page={own} />
          )}
        </SettingsBody>
      </SettingsSection>
      {company === undefined ? null : (
        <SettingsSection
          description={t`What every chat in the company starts with. Only admins change them.`}
          title={t`Company instructions`}
        >
          <SettingsBody>
            {company.state === "ready" ? (
              <div className="flex flex-col gap-6">
                <InstructionFileEditor
                  description={t`The company’s rules for every agent.`}
                  file={companyInstructions}
                  label={t`Instructions`}
                  saved={company.data.instructions}
                />
                <InstructionFileEditor
                  description={t`What every agent should know about the company.`}
                  file={companyFacts}
                  label={t`Lasting facts`}
                  saved={company.data.facts}
                />
              </div>
            ) : (
              <NotLoadedState heading="h3" page={company} />
            )}
          </SettingsBody>
        </SettingsSection>
      )}
    </>
  );
};

export const Route = createFileRoute("/_shell/settings/instructions")({
  pendingComponent: SettingsLoading,
  errorComponent: SettingsError,
  component: Instructions,
  loader: async ({ context: { core, identity } }) => {
    // The company's are for admins only: nobody else is asked.
    const [own, company] = await Promise.all([
      loadFromCore(
        core,
        async (session) =>
          await session.instructions.read({
            scope: "person",
            personId: identity.userId,
          })
      ),
      isAdmin(identity.role) && !identity.staff
        ? loadFromCore(core, async (session) => {
            const [instructions, facts] = await Promise.all([
              session.instructions.read(companyInstructions),
              session.instructions.read(companyFacts),
            ]);
            return { instructions, facts };
          })
        : undefined,
    ]);
    return { own, company };
  },
});
