import { isMemberAdmin } from "@grasp-os/shared/roles";
import { Skeleton } from "@grasp-os/ui/components/skeleton";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { ManualAgent } from "../agents/manual-agent.tsx";
import { NewAgentStart } from "../agents/new-agent-start.tsx";
import { newAgentWayOf } from "../agents/new-agent-way.ts";
import type { NewAgentWay } from "../agents/new-agent-way.ts";
import { NewAgent } from "../agents/new-agent.tsx";
import type { CatalogApp } from "../agents/setup/model.ts";
import { chatPresence } from "../chat/chat-presence.ts";
import { PageNotLoaded } from "../frame/page-states.tsx";
import { Page } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import type { Loaded } from "../load-from-core.tsx";

// A new agent: anyone of the company makes one of their own, while the
// company lets them, and its own admins one for the company. Grasp's staff
// are sent to the Agents page, as core would refuse them the making, and
// so is anyone who may make neither kind. It starts by asking
// which way (agents/new-agent-start.tsx): set up by hand
// (agents/manual-agent.tsx), or in a chat
// (agents/new-agent.tsx).

const styles = stylex.create({
  // What a way shows before it arrives: its question's place in the middle.
  waiting: {
    display: "grid",
    justifyItems: "center",
    gap: space["4"],
    width: "100%",
    maxWidth: "28rem",
    marginInline: "auto",
    paddingBlock: space["16"],
  },
  line: { display: "block", width: "100%" },
  short: { display: "block", width: "60%" },
});

const NewAgentPage = () => {
  const { t } = useLingui();
  const { identity } = Route.useRouteContext();
  const { way } = Route.useSearch();
  const page = Route.useLoaderData();
  const company = isMemberAdmin(identity);
  const crumbs = [{ label: t`Agents`, to: "/agents" }, { label: t`New agent` }];
  if (page.state !== "ready") {
    return <PageNotLoaded crumbs={crumbs} page={page} />;
  }
  const { taken, models, apps, teams, ownOn } = page.data;
  return (
    <>
      <SiteHeader crumbs={crumbs} />
      {way === undefined ? (
        <Page>
          <NewAgentStart />
        </Page>
      ) : null}
      {way === "manual" ? (
        <Page>
          <ManualAgent
            apps={apps}
            company={company}
            models={models}
            own={ownOn}
            personId={identity.userId}
            taken={taken}
            teams={teams}
          />
        </Page>
      ) : null}
      {way === "chat" ? (
        <NewAgent
          company={company}
          own={ownOn}
          personId={identity.userId}
          taken={taken}
        />
      ) : null}
    </>
  );
};

/**
 * New agent before what it offers arrives: its crumbs, then the place of
 * the question the way shown asks first, in the page's middle.
 */
const NewAgentLoading = () => {
  const { t } = useLingui();
  return (
    <>
      <SiteHeader
        crumbs={[{ label: t`Agents`, to: "/agents" }, { label: t`New agent` }]}
      />
      <Page>
        <div aria-busy="true" {...stylex.props(styles.waiting)}>
          <span {...stylex.props(styles.line)}>
            <Skeleton size="lg" />
          </span>
          <span {...stylex.props(styles.short)}>
            <Skeleton />
          </span>
        </div>
      </Page>
    </>
  );
};

export const Route = createFileRoute("/_shell/agents/new")({
  // No chat box at its foot: it is a task of its own (Ruben, 19 Nov 2026).
  staticData: { chat: chatPresence.hidden },
  validateSearch: (
    search: Record<string, unknown>
  ): { way?: NewAgentWay | undefined } => {
    const way = newAgentWayOf(search.way);
    return way === undefined ? {} : { way };
  },
  beforeLoad: ({ context: { identity } }) => {
    // Grasp's staff are no one of the company: they make neither kind.
    if (identity.staff) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({ to: "/agents", replace: true });
    }
  },
  component: NewAgentPage,
  pendingComponent: NewAgentLoading,
  // What the setup offers, each none when core won't say: the names other
  // agents have, the company's and the person's own (core still refuses a
  // name in use), the models an agent can be given, the apps the company
  // offers, connected and working ones marked, and the company's teams.
  // Whether the company lets people have agents of their own: on when core
  // won't say, as core still refuses what it refuses.
  // The choice of two ways needs none of it, so it stands at once: what a
  // way offers is read once it is picked (each list read is audited, so
  // never ahead), and only whether the company lets people have their own
  // agents before.
  loaderDeps: ({ search: { way } }) => ({ way }),
  loader: async ({
    context: { core, identity },
    deps: { way },
  }): Promise<
    Loaded<{
      taken: string[];
      models: string[];
      apps: CatalogApp[];
      teams: { teamId: string; name: string }[];
      ownOn: boolean;
    }>
  > => {
    const readOwnOn = async (): Promise<boolean> => {
      try {
        const setting = await core.withSession(
          async (session) => await session.orgSettings.ownAgents()
        );
        return setting.on;
      } catch {
        return true;
      }
    };
    // An admin makes the company's agents whatever the setting says.
    const admin = isMemberAdmin(identity);
    if (way === undefined && admin) {
      return {
        state: "ready",
        data: { taken: [], models: [], apps: [], teams: [], ownOn: true },
      };
    }
    const ownOnRead = readOwnOn();
    if (way === undefined) {
      const ownOn = await ownOnRead;
      if (!ownOn) {
        // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
        throw redirect({ to: "/agents", replace: true });
      }
      return {
        state: "ready",
        data: { taken: [], models: [], apps: [], teams: [], ownOn },
      };
    }
    // The names other agents have, which either way needs (core still
    // refuses a name in use): none where core won't say them.
    const takenRead = Promise.allSettled([
      core.withSession(async (session) => await session.connections.agents()),
      core.withSession(
        async (session) => await session.connections.ownAgents()
      ),
    ]);
    const ownOn = await ownOnRead;
    // Someone who may make neither kind has nothing to make here.
    if (!ownOn && !admin) {
      // oxlint-disable-next-line typescript/only-throw-error -- the router redirects on a thrown redirect
      throw redirect({ to: "/agents", replace: true });
    }
    const takenNames = await takenRead;
    const taken = takenNames.flatMap((read) =>
      read.status === "fulfilled" ? read.value.map(({ name }) => name) : []
    );
    // In a chat, Grasp asks for no model, app or team: nothing more to read.
    if (way === "chat") {
      return {
        state: "ready",
        data: { taken, models: [], apps: [], teams: [], ownOn },
      };
    }
    // Set up by hand: the models an agent can be given (none where core
    // won't say, and it then takes the one the asker picks), the apps the
    // company offers, and its teams, each none where core won't say.
    const [models, connections, catalog, reach] = await Promise.allSettled([
      core.withSession(async (session) => await session.chats.models()),
      core.withSession(async (session) => await session.connections.list()),
      core.withSession(async (session) => await session.connections.catalog()),
      core.withSession(
        async (session) => await session.connections.stephenReach()
      ),
    ]);
    // An agent is given only an app the company offers.
    const entries =
      catalog.status === "fulfilled"
        ? catalog.value.entries.filter(({ offered }) => offered)
        : [];
    const working =
      connections.status === "fulfilled"
        ? connections.value.filter(({ status }) => status === "active")
        : [];
    // The catalog's apps, the connected ones marked with the account they use.
    const apps = entries.map((entry) => {
      const connection = working.find(({ provider }) => provider === entry.id);
      return {
        id: entry.id,
        source: entry.source,
        name: entry.name,
        logo: entry.logo,
        description: entry.description,
        categories: entry.categories,
        connected: connection !== undefined,
        account: connection?.accountName ?? null,
      };
    });
    return {
      state: "ready",
      data: {
        taken,
        models: models.status === "fulfilled" ? models.value : [],
        apps,
        teams: reach.status === "fulfilled" ? reach.value.teams : [],
        ownOn,
      },
    };
  },
});
