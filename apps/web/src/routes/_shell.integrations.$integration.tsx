import { isAdmin } from "@grasp-os/shared/roles";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { useSettled } from "../connections/app-of.tsx";
import { IntegrationAppPage } from "../connections/app-page.tsx";
import { ConnectedDialog } from "../connections/connected-dialog.tsx";
import { ConnectionList } from "../connections/connection-list.tsx";
import type { HeldPermissions } from "../connections/connection-list.tsx";
import { useWhyNoConnect } from "../connections/integration-facts.ts";
import { loadIntegrations } from "../connections/integrations-data.ts";
import { IntegrationSkeleton } from "../connections/integrations-skeleton.tsx";
import {
  integrationsOf,
  parseIntegrationKey,
} from "../connections/integrations.ts";
import type { Integration } from "../connections/integrations.ts";
import { OfferSwitch } from "../connections/offer-switch.tsx";
import { NotFound, PageNotLoaded } from "../frame/page-states.tsx";
import { Page } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { Alert } from "../grasp/alert/index.ts";
import { Cable } from "../grasp/icons/index.ts";
import { loadFromCore, notLoadedText } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";

// One integration, on the library's app page (connections/app-page.tsx):
// its head in the app's own colour, what Grasp may do with its tools
// beside its connection, who can use it and the workflows that use it.
// Under it, for admins, whether it is offered, and each connection made to
// it on its own card (who connected it, its consent, the Apps and agents
// holding a permission for it, signing in again and disconnecting). A
// flow comes back here from the provider, through core's callback, with
// `connection=<id>` (and `again=1` when it signed in again), and opens the
// success page.

type Tab = "overview" | "workflows" | "account";

interface IntegrationSearch {
  tab?: Tab;
  connection?: string;
  /** The flow that made `connection` signed in again (connect-dialog.tsx). */
  again?: true;
}

/** Why the permissions Apps and agents hold can't be shown; nothing once they can. */
const HeldNotLoaded = ({
  held,
}: {
  held: Loaded<HeldPermissions> | undefined;
}) => {
  const { i18n, t } = useLingui();
  const why = held === undefined ? undefined : notLoadedText(held, i18n);
  if (why === undefined) {
    return null;
  }
  return (
    <Alert
      title={t`Which Apps and agents hold permissions: ${why}`}
      tone="danger"
    />
  );
};

/**
 * Why the page can't say all it would: the catalog couldn't be read, it
 * doesn't list the app, its tools couldn't be read, or this person can't
 * connect it.
 */
const Notices = ({
  integration,
  catalog,
  tools,
}: {
  integration: Integration;
  catalog: Loaded<unknown>;
  tools: Loaded<unknown> | undefined;
}) => {
  const { identity } = Route.useRouteContext();
  const { i18n, t } = useLingui();
  const whyNoConnectOf = useWhyNoConnect();
  const app = integration.name;
  const notices: string[] = [];
  if (catalog.state === "ready") {
    const why = whyNoConnectOf(integration, identity);
    if (why !== undefined) {
      notices.push(why);
    }
    if (!integration.listed) {
      notices.push(
        t`The catalog doesn't list ${app}, so its tools can't be shown.`
      );
    }
  } else {
    notices.push(
      t`The catalog of integrations couldn't be read, so this page shows only what your accounts say about it.`
    );
  }
  const toolsWhy = tools === undefined ? undefined : notLoadedText(tools, i18n);
  return (
    <>
      {notices.map((notice) => (
        <Alert key={notice} title={notice} />
      ))}
      {toolsWhy === undefined ? null : <Alert title={toolsWhy} tone="danger" />}
    </>
  );
};

/**
 * One app's page: the library's app page, then, for admins, whether it is
 * offered, and its connections.
 */
const IntegrationPage = ({ integration }: { integration: Integration }) => {
  const { held, tools, catalog, uses } = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  const { connection, again = false } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { t } = useLingui();
  const read = useSettled(integration.listed ? tools : undefined);
  const used = useSettled(uses);
  // Only a connection the page lists: anyone can put an ID in a link.
  const connected =
    connection === undefined
      ? undefined
      : integration.connections.find(({ id }) => id === connection);
  return (
    <>
      <SiteHeader
        crumbs={[
          { label: t`Integrations`, to: "/integrations" },
          { label: integration.name },
        ]}
      />
      <Page>
        <ConnectedDialog
          again={again}
          app={integration.name}
          connection={connected}
          onClose={() => {
            void navigate({
              replace: true,
              search: (last) => ({
                ...last,
                connection: undefined,
                again: undefined,
              }),
            });
          }}
        />
        <IntegrationAppPage
          identity={identity}
          integration={integration}
          tools={read}
          uses={used}
        />
        <Notices catalog={catalog} integration={integration} tools={read} />
        {isAdmin(identity.role) && integration.listed ? (
          <OfferSwitch integration={integration} staff={identity.staff} />
        ) : null}
        {/* Its connections, each a card of its own. */}
        <HeldNotLoaded held={held} />
        <ConnectionList
          held={held}
          identity={identity}
          integration={integration}
        />
      </Page>
    </>
  );
};

const IntegrationRoute = () => {
  const { catalog, connections } = Route.useLoaderData();
  const { integration: key } = Route.useParams();
  const { t } = useLingui();
  const parsed = parseIntegrationKey(key);
  const integrations = { label: t`Integrations`, to: "/integrations" as const };
  if (connections.state !== "ready") {
    return (
      <PageNotLoaded
        crumbs={[integrations, { label: parsed?.id ?? t`Integration` }]}
        page={connections}
      />
    );
  }
  // Without the catalog, an integration someone is connected to still
  // shows from its connections, so they can still see, reconnect or
  // disconnect their accounts; one they aren't connected to needs the
  // catalog. Whether it is offered is unknown then: core, which refuses
  // a flow for one that isn't, decides.
  const listed =
    parsed === undefined
      ? undefined
      : integrationsOf(
          catalog.state === "ready" ? catalog.data.entries : [],
          connections.data
        ).find((candidate) => candidate.key === key);
  const integration =
    listed === undefined || catalog.state === "ready"
      ? listed
      : { ...listed, offered: true };
  if (integration === undefined && catalog.state !== "ready") {
    return (
      <PageNotLoaded
        crumbs={[integrations, { label: parsed?.id ?? t`Integration` }]}
        icon={Cable}
        notFound={t`App not found`}
        page={catalog}
      />
    );
  }
  if (integration === undefined) {
    return (
      <NotFound
        crumbs={[integrations, { label: t`Not found` }]}
        icon={Cable}
        title={t`App not found`}
      />
    );
  }
  return <IntegrationPage integration={integration} />;
};

export const Route = createFileRoute("/_shell/integrations/$integration")({
  validateSearch: (search: Record<string, unknown>): IntegrationSearch => ({
    tab:
      search.tab === "account" || search.tab === "workflows"
        ? search.tab
        : undefined,
    connection:
      typeof search.connection === "string" ? search.connection : undefined,
    again: search.again === 1 || search.again === "1" ? true : undefined,
  }),
  loader: async ({ context: { core, identity }, params }) => {
    const parsed = parseIntegrationKey(params.integration);
    // Not awaited: only Overview shows the tools, and a slow read of them
    // shouldn't keep anyone from their account.
    const tools =
      parsed === undefined
        ? undefined
        : loadFromCore(
            core,
            async (session) =>
              await session.connections.catalogTools(parsed.source, parsed.id)
          );
    const read = await loadIntegrations(core, identity, { held: true });
    return { ...read, tools };
  },
  // A tab, or a notice dropped, keeps what was read; a change reads it
  // again (use-change.ts invalidates it).
  shouldReload: false,
  pendingComponent: IntegrationSkeleton,
  component: IntegrationRoute,
});
