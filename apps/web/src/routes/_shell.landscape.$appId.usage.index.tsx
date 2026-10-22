import { isAdmin } from "@grasp-os/shared/roles";
import { createFileRoute } from "@tanstack/react-router";

import { discoveredAppOfId } from "../landscape/landscape.ts";
import { UsageTab } from "../landscape/usage-tab.tsx";
import type { UsagePeople } from "../landscape/usage-tab.tsx";
import { useAppPage } from "../landscape/use-app-page.ts";
import { loadFromCore } from "../load-from-core.tsx";

const Usage = () => {
  const { app } = useAppPage();
  const { people } = Route.useLoaderData();
  return app === null ? null : <UsageTab app={app} people={people} />;
};

export const Route = createFileRoute("/_shell/landscape/$appId/usage/")({
  // `?team=Sales` opens the tab filtered to one team, as in the prototype.
  validateSearch: (search: Record<string, unknown>): { team?: string } =>
    typeof search.team === "string" && search.team !== ""
      ? { team: search.team }
      : {},
  // Who granted a found app access, for admins only: core records the look.
  loader: async ({
    context: { core, identity },
    params,
  }): Promise<{ people: UsagePeople }> => {
    const found = discoveredAppOfId(params.appId);
    if (found === undefined || !isAdmin(identity.role)) {
      return { people: null };
    }
    return {
      people: await loadFromCore(
        core,
        async (session) =>
          await session.landscape.people(found.connectionId, found.appId)
      ),
    };
  },
  component: Usage,
});
