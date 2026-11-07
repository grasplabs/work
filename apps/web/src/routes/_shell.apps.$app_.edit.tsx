import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";
import { LayoutGridIcon } from "lucide-react";

import { buildsApp } from "../apps/app-role.ts";
import { settingsSectionOf } from "../apps/app-settings.tsx";
import type { AppSettingsSection } from "../apps/app-settings.tsx";
import { AppWorkspace } from "../apps/app-workspace.tsx";
import type { WorkspaceView } from "../apps/app-workspace.tsx";
import { readStoreChanges } from "../apps/store-changes.tsx";
import { PageLoading, PageNotLoaded } from "../frame/page-states.tsx";
import { loadFromCore, orNull } from "../load-from-core.tsx";

// An App's workspace (apps/app-workspace.tsx), where its builders build
// it with the chat beside a preview of its draft, apart from the live App
// (_shell.apps.$app.tsx). Full height, under no page header of its own:
// its bar is the App's.

const AppWorkspacePage = () => {
  const page = Route.useLoaderData();
  const { view, section, chat } = Route.useSearch();
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
  const { app, models, efforts, storeChanges } = page.data;
  return (
    <AppWorkspace
      app={app}
      builds={buildsApp(app, identity)}
      efforts={efforts}
      handedOver={chat}
      identity={identity}
      // Another App starts afresh: nothing the last one said stays.
      key={app.id}
      models={models}
      section={section}
      storeChanges={storeChanges}
      view={view ?? "preview"}
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

export const Route = createFileRoute("/_shell/apps/$app_/edit")({
  pendingComponent: PageLoading,
  component: AppWorkspacePage,
  // What the main area shows, and, in Settings, which section; any other
  // value (an old or hand-typed address) shows the preview, or General.
  validateSearch: (
    search: Record<string, unknown>
  ): {
    view?: Exclude<WorkspaceView, "preview"> | undefined;
    section?: AppSettingsSection | undefined;
    chat?: string | undefined;
  } => ({
    // Always set, as the address's own would otherwise pass through
    // unchecked (the root route reads the search raw).
    view: viewOf(search.view),
    section: settingsSectionOf(search.section),
    // The chat the person came from, building the App (Chat's studio):
    // the workspace carries it on. Core checks it is theirs on each read.
    chat: typeof search.chat === "string" ? search.chat : undefined,
  }),
  loader: async ({ context: { core, identity }, params }) =>
    await loadFromCore(core, async (session) => {
      // The models leave the workspace as it is when they can't be read:
      // the chat says there is none to ask with.
      const [app, models, efforts] = await Promise.all([
        session.apps.get(params.app),
        orNull(async () => await session.chats.models()),
        orNull(async () => await session.chats.efforts()),
      ]);
      return {
        app,
        models: models ?? [],
        efforts: efforts ?? {},
        // Only for who may abandon a store's failed change: the
        // organization's own admins. Not awaited: General waits for it.
        storeChanges: readStoreChanges(core, identity, params.app),
      };
    }),
});
