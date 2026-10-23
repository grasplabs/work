import { createFileRoute } from "@tanstack/react-router";

import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { WorkList } from "../onboarding/work-list.tsx";
import { readWorks, workViewOf } from "../onboarding/work-words.ts";
import { SettingsError } from "../settings/settings-parts.tsx";

// The work in Grasp's onboarding area (GRA-377, prototype
// `org-workflows.tsx`): every piece of work as drawn from what its people
// agreed to, how far each is known under the organization's own rules,
// and how much each still lacks. From core's staff reads, each on record
// in the audit log: where everyone stands, and the work drawn from it.

const Workflows = () => {
  const loaded = Route.useLoaderData();
  if (loaded.state !== "ready") {
    return (
      <div className="bg-card overflow-hidden rounded-xl border">
        <NotLoadedState heading="h2" page={loaded} />
      </div>
    );
  }
  return <WorkList view={workViewOf(loaded.data)} works={loaded.data.works} />;
};

export const Route = createFileRoute("/_shell/onboarding/workflows/")({
  loader: async ({ context: { core } }) => await loadFromCore(core, readWorks),
  errorComponent: SettingsError,
  component: Workflows,
});
