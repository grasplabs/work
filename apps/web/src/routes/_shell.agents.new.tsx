import { isMemberAdmin } from "@grasp-os/shared/roles";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { NewAgent } from "../agents/new-agent.tsx";
import { SiteHeader } from "../frame/site-header.tsx";

// A new agent (agents/new-agent.tsx): anyone of the company makes one of
// their own, and its own admins one for the company. Grasp's staff are
// sent to the Agents page, as core would refuse them the making.

const NewAgentPage = () => {
  const { t } = useLingui();
  const { models, ownOn } = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  return (
    <>
      <SiteHeader
        crumbs={[{ label: t`Agents`, to: "/agents" }, { label: t`New agent` }]}
      />
      <NewAgent company={isMemberAdmin(identity)} models={models} own={ownOn} />
    </>
  );
};

export const Route = createFileRoute("/_shell/agents/new")({
  beforeLoad: ({ context: { identity } }) => {
    // Grasp's staff are no one of the company: they make neither kind.
    if (identity.staff) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({ to: "/agents", replace: true });
    }
  },
  component: NewAgentPage,
  // The models an agent can be given, and whether the company lets people
  // have agents of their own: no models, and on, when core won't say,
  // as core still refuses what it refuses.
  loader: async ({ context: { core, identity } }) => {
    const [models, setting] = await Promise.allSettled([
      core.withSession(async (session) => await session.chats.models()),
      core.withSession(
        async (session) => await session.orgSettings.ownAgents()
      ),
    ]);
    const ownOn = setting.status === "fulfilled" ? setting.value.on : true;
    // Someone who may make neither kind has nothing to make here.
    if (!ownOn && !isMemberAdmin(identity)) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({ to: "/agents", replace: true });
    }
    return {
      models: models.status === "fulfilled" ? models.value : [],
      ownOn,
    };
  },
});
