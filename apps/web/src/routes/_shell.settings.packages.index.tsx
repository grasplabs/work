import type { DependencySubjectsInForce } from "@grasp-os/shared/dependencies";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import {
  SettingsError,
  SettingsLoading,
  SettingsSection,
} from "../settings/settings-parts.tsx";
import { useCoreAction } from "../use-core-action.ts";

// Settings → Packages: every App and workflow holding approved npm
// packages, for someone who may approve packages, each leading to where
// its approvals are retired or revoked: an App's own page, or the
// workflow's approvals here, since a workflow has no page of its own.
// Core lists nothing to anyone else; it checks the permission on every
// call. A page at a time, each next page asked for: every App and
// workflow is there however many there are.

const Subjects = ({ listed }: { listed: DependencySubjectsInForce }) => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  // The pages read so far, from the first the route read.
  const [shown, setShown] = useState(listed);
  const [read, setRead] = useState(listed);
  if (listed !== read) {
    setRead(listed);
    setShown(listed);
  }
  const more = async (next: string): Promise<void> => {
    const page = await run(
      async (session) => await session.dependencies.inForce(next)
    );
    if (page !== undefined) {
      // A page refused (the permission was taken away since) replaces the
      // list, which then says why; any other adds to it.
      setShown((before) =>
        page.decides
          ? { ...page, subjects: [...before.subjects, ...page.subjects] }
          : page
      );
    }
  };
  if (!shown.decides) {
    return (
      <p className="text-muted-foreground border-t px-5 py-4">
        <Trans>
          Only people who may approve packages see what is approved across the
          workspace.
        </Trans>
      </p>
    );
  }
  if (shown.subjects.length === 0) {
    return (
      <p className="text-muted-foreground border-t px-5 py-4">
        <Trans>No App or workflow has approved packages.</Trans>
      </p>
    );
  }
  return (
    <div className="border-t">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>
              <Trans>Name</Trans>
            </TableHead>
            <TableHead>
              <Trans>Kind</Trans>
            </TableHead>
            <TableHead>
              <Trans>Approvals</Trans>
            </TableHead>
            <TableHead>
              <Trans>Last decided</Trans>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.subjects.map(({ subject, approvals, decidedAt }) => (
            <TableRow key={`${subject.type}:${subject.id}`}>
              <TableCell>
                {subject.type === "app" ? (
                  <Link
                    className="hover:underline focus-visible:underline"
                    params={{ engine: subject.id }}
                    to="/domains/$engine"
                  >
                    {subject.name}
                  </Link>
                ) : (
                  <Link
                    className="hover:underline focus-visible:underline"
                    params={{ workflow: subject.id }}
                    to="/settings/packages/workflows/$workflow"
                  >
                    {subject.name}
                  </Link>
                )}
              </TableCell>
              <TableCell>
                <Badge variant="outline">
                  {subject.type === "workflow" ? t`Workflow` : t`App`}
                </Badge>
              </TableCell>
              <TableCell>
                <Plural
                  value={approvals}
                  one="# approval"
                  other="# approvals"
                />
              </TableCell>
              <TableCell>
                <time dateTime={decidedAt}>{formatDateTime(decidedAt)}</time>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {shown.next === null ? null : (
        <div className="flex flex-col items-start gap-1 border-t px-5 py-3">
          <Button
            disabled={busy}
            onClick={() => {
              if (shown.next !== null) {
                void more(shown.next);
              }
            }}
            size="sm"
            variant="outline"
          >
            <Trans>Show more</Trans>
          </Button>
          <ErrorText>{failure}</ErrorText>
        </div>
      )}
    </div>
  );
};

const Packages = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  return (
    <SettingsSection
      description={
        <Trans>
          The Apps and workflows that may use approved npm packages. Open one to
          retire or revoke what was approved for it.
        </Trans>
      }
      title={t`Packages`}
    >
      {page.state === "ready" ? (
        <Subjects listed={page.data} />
      ) : (
        <div className="border-t">
          <NotLoadedState heading="h3" page={page} />
        </div>
      )}
    </SettingsSection>
  );
};

export const Route = createFileRoute("/_shell/settings/packages/")({
  pendingComponent: SettingsLoading,
  errorComponent: SettingsError,
  component: Packages,
  loader: async ({ context: { core } }) =>
    await loadFromCore(
      core,
      async (session) => await session.dependencies.inForce()
    ),
});
