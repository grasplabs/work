import { isAdmin } from "@grasp-os/shared/roles";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { PageSkeletonSettings } from "../grasp/blocks/page-skeleton-settings/page-skeleton-settings.tsx";
import { SectionCard } from "../grasp/section-card/index.ts";
import { loadFromCore } from "../load-from-core.tsx";
import { InstructionFileEditor } from "../settings/instruction-file.tsx";
import {
  SectionNotLoaded,
  SettingsError,
  SettingsStack,
} from "../settings/section.tsx";

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
      <SectionCard
        description={t`What your chats with Grasp start with, and only yours: how you like to work, what you are responsible for.`}
        title={t`Your instructions`}
      >
        {own.state === "ready" ? (
          <InstructionFileEditor
            description={t`Only you and your own chats read it, never a chat others share.`}
            file={{ scope: "person", personId: identity.userId }}
            label={t`Your instructions`}
            saved={own.data}
          />
        ) : (
          <SectionNotLoaded page={own} />
        )}
      </SectionCard>
      {company === undefined ? null : (
        <SectionCard
          description={t`What every chat in the company starts with. Only admins change them.`}
          title={t`Company instructions`}
        >
          {company.state === "ready" ? (
            <SettingsStack>
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
            </SettingsStack>
          ) : (
            <SectionNotLoaded page={company} />
          )}
        </SectionCard>
      )}
    </>
  );
};

const InstructionsPending = () => (
  <PageSkeletonSettings header={false} help={false} sections={[1, 2]} />
);

export const Route = createFileRoute("/_shell/settings/instructions")({
  pendingComponent: InstructionsPending,
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
