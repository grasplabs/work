import { Button } from "@grasp-os/ui/components/button";
import { Input } from "@grasp-os/ui/components/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { createFileRoute, Link } from "@tanstack/react-router";

import { AdminPage } from "../../../admin/page.tsx";
import { Panel } from "../../../admin/panel.tsx";
import { PlatformNav, platformCrumb } from "../../../admin/platform-nav.tsx";
import { Quiet } from "../../../admin/release-parts.tsx";
import { formatTime } from "../../../releases/format.ts";
import { fetchReleases } from "../../../releases/functions.ts";
import type { ReleaseSummary } from "../../../releases/queries.ts";
import {
  releaseName,
  releaseTitle,
  versionWords,
} from "../../../releases/version.ts";

/** Any two releases, compared: a plain GET form, so it needs no script. */
const Compare = ({ releases }: { releases: ReleaseSummary[] }) => (
  <Panel
    description="What changed between any two releases, with the notes of those in between."
    title="Compare two releases"
  >
    <form
      action="/platform/releases/diff"
      className="flex flex-wrap items-center gap-2 border-t px-5 py-4"
      method="get"
    >
      <Input
        aria-label="From release"
        className="w-44"
        list="release-ids"
        name="from"
        placeholder="From release"
        required
      />
      <Input
        aria-label="To release"
        className="w-44"
        list="release-ids"
        name="to"
        placeholder="To release"
        required
      />
      <datalist id="release-ids">
        {releases.map((release) => (
          <option key={release.id} value={release.id}>
            {releaseName(release)}
          </option>
        ))}
      </datalist>
      <Button size="sm" type="submit" variant="outline">
        Compare
      </Button>
    </form>
  </Panel>
);

/** Every release, the newest first, each with what changed since the one before. */
const EveryRelease = ({
  releases,
  older,
}: {
  releases: ReleaseSummary[];
  older: ReleaseSummary | null;
}) => (
  <Panel
    description={
      older === null
        ? "As CI made them, the newest first. A release opens what it holds."
        : `The newest ${releases.length} releases.`
    }
    title="Every release"
  >
    {releases.length === 0 ? (
      <Quiet>
        No releases yet. Every merge to main publishes one, and the admin
        imports it within five minutes.
      </Quiet>
    ) : (
      <div className="@container border-t">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead variant="card">Version</TableHead>
              <TableHead variant="card">Release</TableHead>
              <TableHead className="hidden @xl:table-cell" variant="card">
                Built (UTC)
              </TableHead>
              <TableHead className="hidden @3xl:table-cell" variant="card">
                Changes
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {releases.map((release, index) => {
              const previous = releases[index + 1] ?? older;
              return (
                <TableRow key={release.id}>
                  <TableCell variant="card">
                    <span className="font-medium tabular-nums">
                      {versionWords(release) ?? "–"}
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-normal" variant="card">
                    <div className="flex flex-col gap-0.5">
                      <Link
                        className="underline-offset-4 hover:underline"
                        params={{ releaseId: release.id }}
                        to="/platform/releases/$releaseId"
                      >
                        {releaseTitle(release.notes) || release.id}
                      </Link>
                      {/* The commit next to the id: the id says when, the commit what. */}
                      <span className="text-muted-foreground font-mono text-xs">
                        {`${release.id} · ${release.commitSha.slice(0, 7)}`}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="hidden @xl:table-cell" variant="card">
                    <span className="text-muted-foreground tabular-nums">
                      {formatTime(release.builtAt)}
                    </span>
                  </TableCell>
                  <TableCell className="hidden @3xl:table-cell" variant="card">
                    {previous === null ? null : (
                      <Link
                        className="text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
                        search={{ from: previous.id, to: release.id }}
                        to="/platform/releases/diff"
                      >
                        {`Since ${versionWords(previous) ?? previous.id}`}
                      </Link>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    )}
  </Panel>
);

/**
 * Every release CI published, as the admin imported it: the admin's
 * Releases page, under Platform.
 */
const ReleasesPage = () => {
  const { releases, older } = Route.useLoaderData();
  return (
    <AdminPage
      description="Every merge to main publishes a release, and the admin imports it within five minutes. A rollout takes one to the companies, ring by ring."
      parents={[platformCrumb]}
      title="Releases"
    >
      <PlatformNav />
      <div className="flex flex-col gap-6 text-sm">
        {releases.length > 1 ? <Compare releases={releases} /> : null}
        <EveryRelease older={older} releases={releases} />
      </div>
    </AdminPage>
  );
};

export const Route = createFileRoute("/platform/releases/")({
  loader: async () => await fetchReleases(),
  component: ReleasesPage,
});
