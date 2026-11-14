import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";
import { LayoutGridIcon } from "lucide-react";

import { OpenedApp } from "../apps/app-page.tsx";
import { settingsSectionOf } from "../apps/app-settings.tsx";
import type { AppSettingsSection } from "../apps/app-settings.tsx";
import type { ReadOnlyShown, WorkspaceView } from "../apps/app-workspace.tsx";
import { chatPresence } from "../chat/chat-presence.ts";
import {
  backCrumb,
  projectSearchOf,
  readItemProject,
} from "../frame/item-shell.tsx";
import { PageLoading, PageNotLoaded } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";

// An App, at one address for everyone (apps/app-page.tsx): its workspace
// for who builds it, the live App for anyone else. The live App's own
// routes past its `/` sit under `pages/` (_shell.apps.$app.pages.$.tsx,
// which draws nothing of its own, so moving between the App's routes
// keeps this page and its frame). Opened from a project (`?project=`),
// the way back is to that project.

/** What the address asks of the workspace, as `validateSearch` read it. */
type AppSearch = ReturnType<typeof validateSearch>;

/** What the preview shows read-only, as the address names it: a point first. */
const shownOf = ({ point, version }: AppSearch): ReadOnlyShown | undefined => {
  if (point !== undefined) {
    return { point };
  }
  return version === undefined ? undefined : { version };
};

const AppRoute = () => {
  const page = Route.useLoaderData();
  const search = Route.useSearch();
  const { identity } = Route.useRouteContext();
  const { t } = useLingui();
  if (page.state !== "ready") {
    return (
      <PageNotLoaded
        crumbs={[{ label: t`Apps`, to: "/apps" }, { label: t`App` }]}
        icon={LayoutGridIcon}
        notFound={t`App not found`}
        page={page}
      />
    );
  }
  const { app, contents, project } = page.data;
  return (
    <OpenedApp
      app={app}
      back={backCrumb({ label: t`Apps`, to: "/apps" }, project)}
      env={search.env ?? "draft"}
      handedOver={search.chat}
      identity={identity}
      // Another App starts afresh: nothing the last one said stays.
      key={app.id}
      pages={contents.pages}
      section={search.section}
      shown={shownOf(search)}
      view={search.view ?? "preview"}
    />
  );
};

/** A view other than the preview named in an address; anything else is the preview. */
const viewOf = (
  value: unknown
): Exclude<WorkspaceView, "preview"> | undefined =>
  value === "code" || value === "data" || value === "settings"
    ? value
    : undefined;

/** A whole number from an address: a checkpoint's or a version's. */
const whole = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;

/**
 * What the workspace reads from the address; any other value (an old or
 * hand-typed address) shows the preview, or General. The App's own search
 * and hash, for one who uses it, are the App's (pages/app-address.ts),
 * read raw.
 */
const validateSearch = (
  search: Record<string, unknown>
): {
  view?: Exclude<WorkspaceView, "preview"> | undefined;
  section?: AppSettingsSection | undefined;
  chat?: string | undefined;
  env?: "live" | undefined;
  point?: number | undefined;
  version?: number | undefined;
  project?: string | undefined;
} => ({
  view: viewOf(search.view),
  section: settingsSectionOf(search.section),
  // The chat the person came from, building the App in Grasp's chat: the
  // workspace makes it the App's. Core checks it is theirs on each read.
  chat: typeof search.chat === "string" ? search.chat : undefined,
  // The live App rather than the draft, in Preview, Code and Data.
  env: search.env === "live" ? "live" : undefined,
  // A checkpoint of the draft, or a version, the preview shows read-only
  // (History's Preview).
  point: whole(search.point),
  version: whole(search.version),
  // The project it was started or opened from: the way back.
  project: projectSearchOf(search),
});

export const Route = createFileRoute("/_shell/apps/$app")({
  // Grasp's chat is no part of the live App; for its builders, the App's
  // chat docks beside the workspace, about it (chat/chat-subject.ts).
  staticData: { chat: chatPresence.hidden },
  pendingComponent: PageLoading,
  component: AppRoute,
  validateSearch,
  loaderDeps: ({ search: { project } }) => ({ project }),
  // Moving between the App's own routes (`pages/`), or the workspace's
  // views, reads nothing again: the frame routes them. Loading the App
  // again (`invalidate`) still does.
  shouldReload: false,
  loader: async ({ context: { core }, params, deps: { project } }) =>
    await loadFromCore(core, async (session) => {
      const [app, contents, inProject] = await Promise.all([
        session.apps.get(params.app),
        session.apps.contents(params.app),
        readItemProject(session, project),
      ]);
      return { app, contents, project: inProject };
    }),
});
