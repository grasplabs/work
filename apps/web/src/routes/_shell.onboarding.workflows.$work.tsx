import { recordOf } from "@grasp-os/shared/admin/onboarding-admin-record";
import { Button } from "@grasp-os/ui/components/button";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";

import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { WorkRecord } from "../onboarding/work-record.tsx";
import { readWorks, workViewOf } from "../onboarding/work-words.ts";
import { SettingsError } from "../settings/settings-parts.tsx";

// One piece of work in Grasp's onboarding area (GRA-377, prototype
// `work-record.tsx`): how far it is known, its canvas as it runs today,
// its record with each person's own numbers, and what is still missing.
// The piece of work is in the address.

const Workflow = () => {
  const { t } = useLingui();
  const loaded = Route.useLoaderData();
  const { work } = Route.useParams();
  if (loaded.state !== "ready") {
    return (
      <div className="bg-card overflow-hidden rounded-xl border">
        <NotLoadedState heading="h2" page={loaded} />
      </div>
    );
  }
  const view = workViewOf(loaded.data);
  const record = recordOf(view, work);
  const kept = loaded.data.works.works.find(({ id }) => id === work);
  if (record === null || kept === undefined) {
    return (
      <div className="flex flex-col items-start gap-3">
        <Button
          render={<Link to="/onboarding/workflows" />}
          size="sm"
          variant="ghost"
        >
          <ArrowLeftIcon data-icon="inline-start" />
          <Trans>All workflows</Trans>
        </Button>
        <p className="text-muted-foreground">
          {t`There is no workflow here by that name any more. A team's map may have been drawn again.`}
        </p>
      </div>
    );
  }
  return (
    <WorkRecord
      drawn={kept.drawn}
      record={record}
      stale={kept.stale}
      view={view}
    />
  );
};

export const Route = createFileRoute("/_shell/onboarding/workflows/$work")({
  loader: async ({ context: { core } }) => await loadFromCore(core, readWorks),
  errorComponent: SettingsError,
  component: Workflow,
});
