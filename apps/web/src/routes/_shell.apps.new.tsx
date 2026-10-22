import type { Blueprint } from "@grasp-os/shared/apps";
import type { ModelEfforts } from "@grasp-os/shared/models";
import { canBuild } from "@grasp-os/shared/roles";
import { useLingui } from "@lingui/react/macro";
import { Await, createFileRoute } from "@tanstack/react-router";

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
          {/* Offered once its list comes; the chat never waits for it. */}
          {blueprints === undefined ? null : (
            <Await fallback={null} promise={blueprints}>
              {(listed) =>
                listed.state === "ready" ? (
                  <StartFromBlueprint
                    blueprints={listed.data.blueprints}
                    people={listed.data.people}
                  />
                ) : null
              }
            </Await>
          )}
        </NewApp>
      </div>
    </>
  );
};

export const Route = createFileRoute("/_shell/apps/new")({
  pendingComponent: PageLoading,
  loader: async ({ context: { core, identity } }) => ({
    page: await loadFromCore(core, async (session): Promise<NewAppPage> => {
      const [models, efforts] = await Promise.all([
        session.chats.models(),
        session.chats.efforts(),
      ]);
      return { models, efforts };
    }),
    // Deferred, and only for who builds, who may start from them: a list
    // slow or refused leaves the chat as it is.
    blueprints: canBuild(identity.role)
      ? loadFromCore(core, async (session): Promise<Blueprints> => {
          const [listed, people] = await Promise.all([
            session.apps.blueprints.list(),
            readPeople(session),
          ]);
          return { blueprints: listed, people };
        })
      : undefined,
  }),
  component: NewAppRoute,
});
