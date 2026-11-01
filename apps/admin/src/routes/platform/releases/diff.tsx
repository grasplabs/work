import { releaseIdSchema } from "@grasp-os/shared/release-id";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";

import { PageLoading } from "../../../admin/failure.tsx";
import { AdminPage } from "../../../admin/page.tsx";
import {
  PlatformNav,
  platformCrumb,
  releasesCrumb,
} from "../../../admin/platform-nav.tsx";
import { ChangeList, Quiet } from "../../../admin/release-parts.tsx";
import { Section } from "../../../admin/section.tsx";
import { formatTime } from "../../../releases/format.ts";
import { fetchComparison } from "../../../releases/functions.ts";

/**
 * What changed from one release to another: the notes of the releases in
 * between, the platform's packages, and each Worker's code, bindings,
 * settings, migrations and static assets. The admin's comparison, under
 * Platform.
 */
const ComparisonPage = () => {
  const { from, to, diff, between, moreBetween } = Route.useLoaderData();
  return (
    <AdminPage
      description={`What changed from ${from.id} to ${to.id}.`}
      parents={[platformCrumb, releasesCrumb]}
      title={`${from.id} to ${to.id}`}
    >
      <PlatformNav />
      <div className="flex flex-col gap-6 text-sm">
        <Section
          description="The releases after the first, up to the second."
          title="Release notes"
        >
          {between.length === 0 ? (
            <Quiet>No releases in between</Quiet>
          ) : (
            <ul className="flex flex-col">
              {between.map((release) => (
                <li
                  className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-t px-5 py-3"
                  key={release.id}
                >
                  <Link
                    className="font-mono text-xs underline-offset-4 hover:underline"
                    params={{ releaseId: release.id }}
                    to="/platform/releases/$releaseId"
                  >
                    {release.id}
                  </Link>
                  <span>{release.notes}</span>
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {formatTime(release.builtAt)}
                  </span>
                </li>
              ))}
              {moreBetween > 0 ? (
                <li className="text-muted-foreground border-t px-5 py-3">
                  {`and ${moreBetween} more`}
                </li>
              ) : null}
            </ul>
          )}
        </Section>
        <Section title="Platform">
          <ChangeList
            changes={diff.platform}
            title="Compatibility date and packages"
          />
        </Section>
        {diff.workers.map((worker) => (
          <Section key={worker.worker} title={worker.worker}>
            <ChangeList changes={worker.modules} title="Code" />
            <ChangeList changes={worker.bindings} title="Bindings" />
            <ChangeList changes={worker.settings} title="Settings" />
            <ChangeList changes={worker.migrations} title="D1 migrations" />
            <ChangeList changes={worker.assets} title="Static assets" />
          </Section>
        ))}
      </div>
    </AdminPage>
  );
};

/** The two releases to compare, as the URL names them. */
const searchParam = (value: unknown): string =>
  typeof value === "string" ? value : "";

export const Route = createFileRoute("/platform/releases/diff")({
  validateSearch: (search: Record<string, unknown>) => ({
    from: searchParam(search.from),
    to: searchParam(search.to),
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const from = releaseIdSchema.safeParse(deps.from);
    const to = releaseIdSchema.safeParse(deps.to);
    const comparison =
      from.success && to.success
        ? await fetchComparison({ data: { from: from.data, to: to.data } })
        : null;
    if (comparison === null) {
      throw notFound();
    }
    return comparison;
  },
  component: ComparisonPage,
  pendingComponent: PageLoading,
});
