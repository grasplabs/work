import type { ModelEfforts } from "@grasp-os/shared/models";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { NewApp } from "../engines/new-app.tsx";
import { PageLoading, PageNotLoaded } from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore } from "../load-from-core.tsx";

// A new app, from New app in a domain's Apps tab: the question to start
// the chat that makes it.

interface NewAppPage {
  /** The models a question may name, the default first. */
  models: string[];
  /** The efforts each of them takes (`chats.efforts()`). */
  efforts: Record<string, ModelEfforts>;
}

const NewAppRoute = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  const crumbs = [
    { label: t`Apps`, to: "/apps" as const },
    { label: t`New app` },
  ];
  if (page.state !== "ready") {
    return <PageNotLoaded crumbs={crumbs} page={page} />;
  }
  return (
    <>
      <SiteHeader crumbs={crumbs} />
      <div className="flex min-h-0 flex-1 text-sm">
        <NewApp efforts={page.data.efforts} models={page.data.models} />
      </div>
    </>
  );
};

export const Route = createFileRoute("/_shell/apps/new")({
  pendingComponent: PageLoading,
  loader: async ({ context: { core } }) =>
    await loadFromCore(core, async (session): Promise<NewAppPage> => {
      const [models, efforts] = await Promise.all([
        session.chats.models(),
        session.chats.efforts(),
      ]);
      return { models, efforts };
    }),
  component: NewAppRoute,
});
