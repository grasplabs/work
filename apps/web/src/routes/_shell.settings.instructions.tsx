import { isAdmin } from "@grasp-os/shared/roles";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { NotLoadedState } from "../frame/page-states.tsx";
import { PageSkeletonSettings } from "../grasp/blocks/page-skeleton-settings/page-skeleton-settings.tsx";
import { SectionCard } from "../grasp/section-card/index.ts";
import { loadFromCore } from "../load-from-core.tsx";
import { InstructionFileEditor } from "../settings/instruction-file.tsx";
import { SettingsError, SettingsStack } from "../settings/section.tsx";

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
        density="compact"
        description={t`What your own chats with Grasp start with. Only you read them.`}
        title={t`Your instructions`}
        variant="grouped"
      >
        {own.state === "ready" ? (
          <InstructionFileEditor
            file={{ scope: "person", personId: identity.userId }}
            label={t`Your instructions`}
            labelHidden
            saved={own.data}
          />
        ) : (
          <NotLoadedState heading="h3" page={own} />
        )}
      </SectionCard>
      {company === undefined ? null : (
        <SectionCard
          density="compact"
          description={t`What every chat in the company starts with. Only admins change them.`}
          title={t`Company instructions`}
          variant="grouped"
        >
          {company.state === "ready" ? (
            <SettingsStack>
              <InstructionFileEditor
                file={companyInstructions}
                label={t`Company instructions`}
                labelHidden
                saved={company.data.instructions}
              />
              <InstructionFileEditor
                file={companyFacts}
                label={t`Lasting facts`}
                saved={company.data.facts}
              />
            </SettingsStack>
          ) : (
            <NotLoadedState heading="h3" page={company} />
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
