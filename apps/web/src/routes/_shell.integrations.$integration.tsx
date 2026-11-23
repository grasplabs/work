import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { useSettled } from "../connections/app-of.tsx";
import { IntegrationAppPage } from "../connections/app-page.tsx";
import { ConnectedDialog } from "../connections/connected-dialog.tsx";
import { ConnectionsAccess } from "../connections/connection-list.tsx";
import type { HeldPermissions } from "../connections/connection-list.tsx";
import { useWhyNoConnect } from "../connections/integration-facts.ts";
import { loadIntegrations } from "../connections/integrations-data.ts";
import { IntegrationSkeleton } from "../connections/integrations-skeleton.tsx";
import {
  integrationsOf,
  parseIntegrationKey,
} from "../connections/integrations.ts";
import type { Integration } from "../connections/integrations.ts";
import { PartNotLoaded } from "../connections/part-not-loaded.tsx";
import { IntegrationsIcon } from "../frame/integrations-icon.tsx";
import { NotFound, PageNotLoaded } from "../frame/page-states.tsx";
import { Page } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";

// One integration, on its app page (connections/app-page.tsx),
// in one column: its head in the app's own colour, a row for each account,
// the workflows that use it and what Grasp may do with its tools; then
// why the page can't say all it would, and what each connection holds
// besides (its consent, who may read in the Brain what agents read through
// it, the Apps and agents holding a permission for it). A
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
  const { t } = useLingui();
  return held === undefined ? null : (
    <PartNotLoaded
      page={held}
      what={t`Which Apps and agents hold permissions`}
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
  const { t } = useLingui();
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
  return (
    <>
      {notices.map((notice) => (
        <Alert key={notice}>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ))}
      {tools === undefined ? null : (
        <PartNotLoaded page={tools} what={t`${app}'s tools`} />
      )}
    </>
  );
};

/** One app's page: its app page, with its notices and its connections' access in its column. */
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
        >
          <Notices catalog={catalog} integration={integration} tools={read} />
          <HeldNotLoaded held={held} />
          <ConnectionsAccess
            held={held}
            identity={identity}
            integration={integration}
          />
        </IntegrationAppPage>
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
        icon={IntegrationsIcon}
        notFound={t`App not found`}
        page={catalog}
      />
    );
  }
  if (integration === undefined) {
    return (
      <NotFound
        crumbs={[integrations, { label: t`Not found` }]}
        icon={IntegrationsIcon}
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
  // No `shouldReload`: a tab, or a notice dropped (the search), keeps what
  // was read; opening this app or another reads it again, as does a change
  // (use-change.ts invalidates it).
  pendingComponent: IntegrationSkeleton,
  component: IntegrationRoute,
});
