import { isMemberAdmin } from "@grasp-os/shared/roles";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { NewAgent } from "../agents/new-agent.tsx";
import { SiteHeader } from "../frame/site-header.tsx";

// A new agent (agents/new-agent.tsx), for the company's own admins: anyone
// else is sent to the Agents page, as core would refuse them the making.

const NewAgentPage = () => {
  const { t } = useLingui();
  const { identity } = Route.useRouteContext();
  const taken = Route.useLoaderData();
  return (
    <>
      <SiteHeader
        crumbs={[{ label: t`Agents`, to: "/agents" }, { label: t`New agent` }]}
      />
      <NewAgent personId={identity.userId} taken={taken} />
    </>
  );
};

export const Route = createFileRoute("/_shell/agents/new")({
  beforeLoad: ({ context: { identity } }) => {
    if (!isMemberAdmin(identity)) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({ to: "/agents", replace: true });
    }
  },
  component: NewAgentPage,
  // The names other agents have, so none is offered or taken twice: none
  // when core won't say, and core still refuses a name in use.
  loader: async ({ context: { core } }): Promise<string[]> => {
    try {
      const agents = await core.withSession(
        async (session) => await session.connections.agents()
      );
      return agents.map(({ name }) => name);
    } catch {
      return [];
    }
  },
});
