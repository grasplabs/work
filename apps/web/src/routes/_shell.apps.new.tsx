import type { Blueprint } from "@grasp-os/shared/apps";
import type { ModelEfforts } from "@grasp-os/shared/models";
import { canBuild } from "@grasp-os/shared/roles";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { readPeople } from "../directory.ts";
import { StartFromBlueprint } from "../engines/blueprints.tsx";
import { NewApp } from "../engines/new-app.tsx";
import { PageLoading, PageNotLoaded } from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore } from "../load-from-core.tsx";

// A new app, from New app in a domain's Apps tab: the question to start
// the chat that makes it, and, for someone who builds, the blueprints to
// start from instead.

interface NewAppPage {
  /** The models a question may name, the default first. */
  models: string[];
  /** The efforts each of them takes (`chats.efforts()`). */
  efforts: Record<string, ModelEfforts>;
}

/** The blueprints to start from, and who saved them by ID. */
interface Blueprints {
  blueprints: Blueprint[];
  people: ReadonlyMap<string, string>;
}

const NewAppRoute = () => {
  const { t } = useLingui();
  const { page, blueprints } = Route.useLoaderData();
  const crumbs = [
    { label: t`Domains`, to: "/domains" as const },
    { label: t`New app` },
  ];
  if (page.state !== "ready") {
    return <PageNotLoaded crumbs={crumbs} page={page} />;
  }
  return (
    <>
      <SiteHeader crumbs={crumbs} />
      <div className="flex min-h-0 flex-1 text-sm">
        <NewApp efforts={page.data.efforts} models={page.data.models}>
          {blueprints?.state === "ready" ? (
            <StartFromBlueprint
              blueprints={blueprints.data.blueprints}
              people={blueprints.data.people}
            />
          ) : null}
        </NewApp>
      </div>
    </>
  );
};

export const Route = createFileRoute("/_shell/apps/new")({
  pendingComponent: PageLoading,
  loader: async ({ context: { core, identity } }) => {
    // Blueprints only for who builds, who may start from them; a list
    // refused leaves the chat.
    const [page, blueprints] = await Promise.all([
      loadFromCore(core, async (session): Promise<NewAppPage> => {
        const [models, efforts] = await Promise.all([
          session.chats.models(),
          session.chats.efforts(),
        ]);
        return { models, efforts };
      }),
      canBuild(identity.role)
        ? loadFromCore(core, async (session): Promise<Blueprints> => {
            const [listed, people] = await Promise.all([
              session.apps.blueprints.list(),
              readPeople(session),
            ]);
            return { blueprints: listed, people };
          })
        : undefined,
    ]);
    return { page, blueprints };
  },
  component: NewAppRoute,
});
