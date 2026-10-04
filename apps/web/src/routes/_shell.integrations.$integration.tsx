import type { CatalogTool } from "@grasp-os/shared/connect";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@grasp-os/ui/components/tabs";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { BlocksIcon, EyeIcon, PenLineIcon } from "lucide-react";
import { useState } from "react";

import { AppLogo } from "../connections/app-logo.tsx";
import { canConnect, ConnectDialog } from "../connections/connect-dialog.tsx";
import { ConnectionList } from "../connections/connection-list.tsx";
import type { HeldPermissions } from "../connections/connection-list.tsx";
import { loadIntegrations } from "../connections/integrations-data.ts";
import {
  integrationsOf,
  parseIntegrationKey,
  stateOf,
} from "../connections/integrations.ts";
import type {
  Integration,
  IntegrationState,
} from "../connections/integrations.ts";
import { OfferSwitch } from "../connections/offer-switch.tsx";
import { SourceBadge } from "../connections/source-badge.tsx";
import { ErrorText } from "../error-text.tsx";
import { formatList } from "../format.ts";
import { NotFound, PageLoading, PageNotLoaded } from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore, notLoadedText } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";

// One integration, as in the prototype (`routes/integrations/$integrationId.tsx`):
// its tile, name and what it is for, then Overview (where it stands, what
// its tools can do, and, for admins, whether it is offered) and Account
// (each connection made to it: who connected it, when, signing in again
// and disconnecting). The prototype's Workflows tab is left out: core
// can't tell yet which workflows use a connection. A flow comes back here
// from the provider, through core's callback, with `connection=<id>`.

type Tab = "overview" | "account";

interface IntegrationSearch {
  tab?: Tab;
  connection?: string;
}

const stateText: Record<IntegrationState, MessageDescriptor> = {
  needs_reauth: msg`Needs someone to sign in again`,
  shared: msg`Active, for the whole company`,
  personal: msg`Active, only for you`,
  not_connected: msg`Not connected`,
};

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
    <ErrorText>{t`Which engines and agents hold permissions: ${why}`}</ErrorText>
  );
};

/** One tool: its name, what it does, and whether it only reads. */
const ToolRow = ({ tool }: { tool: CatalogTool }) => (
  <li className="flex min-h-11 items-center gap-3 border-b px-4 py-3 last:border-b-0">
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="truncate font-mono text-xs">{tool.name}</span>
      {tool.description === null ? null : (
        <span className="text-muted-foreground line-clamp-2 text-xs">
          {tool.description}
        </span>
      )}
    </div>
    {tool.readOnly ? (
      <Badge variant="outline">
        <EyeIcon data-icon="inline-start" />
        <Trans context="what a tool may do">Read</Trans>
      </Badge>
    ) : (
      <Badge variant="secondary">
        <PenLineIcon data-icon="inline-start" />
        <Trans context="what a tool may do">Write</Trans>
      </Badge>
    )}
  </li>
);

/** What its tools can do, as its provider declares them, reads first. */
const Tools = ({
  tools,
  app,
}: {
  tools: Loaded<CatalogTool[]> | undefined;
  app: string;
}) => {
  const { i18n } = useLingui();
  if (tools === undefined) {
    return (
      <p className="text-muted-foreground">
        <Trans>
          The catalog doesn&apos;t list {app}, so its tools can&apos;t be shown.
        </Trans>
      </p>
    );
  }
  if (tools.state !== "ready") {
    return <ErrorText>{notLoadedText(tools, i18n)}</ErrorText>;
  }
  if (tools.data.length === 0) {
    return (
      <p className="text-muted-foreground">
        <Trans>{app} has no tools.</Trans>
      </p>
    );
  }
  const ordered = tools.data.toSorted(
    (one, other) => Number(other.readOnly) - Number(one.readOnly)
  );
  return (
    <ul className="bg-card flex flex-col overflow-hidden rounded-xl border">
      {ordered.map((tool) => (
        <ToolRow key={tool.name} tool={tool} />
      ))}
    </ul>
  );
};

const Overview = ({
  integration,
  tools,
  identity,
}: {
  integration: Integration;
  tools: Loaded<CatalogTool[]> | undefined;
  identity: Identity;
}) => {
  const { i18n } = useLingui();
  const state = stateOf(integration);
  return (
    <div className="flex flex-col gap-8">
      <section
        aria-labelledby="integration-status"
        className="flex flex-col gap-3"
      >
        <h2 className="font-medium" id="integration-status">
          <Trans>Status</Trans>
        </h2>
        <div className="bg-card flex items-center gap-2 rounded-xl border p-4">
          {state === "not_connected" ? null : (
            <span
              aria-hidden="true"
              className={
                state === "needs_reauth"
                  ? "bg-status-attention size-1.75 rounded-full"
                  : "bg-status-agreed size-1.75 rounded-full"
              }
            />
          )}
          {i18n._(stateText[state])}
        </div>
      </section>
      <section
        aria-labelledby="integration-tools"
        className="flex flex-col gap-3"
      >
        <div className="flex flex-col gap-0.5">
          <h2 className="font-medium" id="integration-tools">
            <Trans>What Grasp may do</Trans>
          </h2>
          <p className="text-muted-foreground">
            <Trans>
              What its tools do, as its provider declares them. Engines and
              agents use only what they are granted, and a tool that changes
              something waits for its person to confirm it.
            </Trans>
          </p>
        </div>
        <Tools app={integration.name} tools={tools} />
      </section>
      {isAdmin(identity.role) && integration.listed ? (
        <OfferSwitch integration={integration} staff={identity.staff} />
      ) : null}
    </div>
  );
};

const Account = ({
  integration,
  held,
  identity,
  onConnect,
}: {
  integration: Integration;
  held: Loaded<HeldPermissions> | undefined;
  identity: Identity;
  onConnect: (() => void) | undefined;
}) => {
  const app = integration.name;
  return (
    <div className="flex flex-col gap-4">
      <HeldNotLoaded held={held} />
      {integration.connections.length === 0 ? (
        <p className="text-muted-foreground">
          <Trans>{app} isn&apos;t connected yet.</Trans>
        </p>
      ) : (
        <ConnectionList
          held={held}
          identity={identity}
          integration={integration}
        />
      )}
      {onConnect === undefined ||
      integration.connections.length === 0 ? null : (
        <Button className="self-start" onClick={onConnect} variant="outline">
          <Trans>Connect another account</Trans>
        </Button>
      )}
    </div>
  );
};

/** What the app is for, and since when it is connected, under its name. */
const aboutOf = (integration: Integration): string | undefined =>
  integration.categories.length === 0
    ? undefined
    : formatList(integration.categories);

const IntegrationPage = ({ integration }: { integration: Integration }) => {
  const { held, tools } = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  const { tab = "overview", connection } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { t } = useLingui();
  // One sign-in for the page, held here so it stays as the page changes.
  const [connecting, setConnecting] = useState(false);
  const connectable = canConnect(integration, identity);
  const open = (): void => {
    setConnecting(true);
  };
  // Only a connection the page lists: anyone can put an ID in a link.
  const connected =
    connection !== undefined &&
    integration.connections.some(({ id }) => id === connection);
  const about = aboutOf(integration);
  const count = integration.connections.length;
  return (
    <>
      <SiteHeader
        crumbs={[
          { label: t`Integrations`, to: "/integrations" },
          { label: integration.name },
        ]}
      />
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-7 text-sm md:px-9">
        <div className="flex items-center gap-4">
          <AppLogo name={integration.name} />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-medium tracking-tight">
                {integration.name}
              </h1>
              <SourceBadge source={integration.source} />
              {integration.listed && !integration.offered ? (
                <Badge variant="outline">
                  <Trans>Not offered</Trans>
                </Badge>
              ) : null}
            </div>
            {about === undefined ? null : (
              <p className="text-muted-foreground">{about}</p>
            )}
          </div>
          {connectable && count === 0 ? (
            <Button onClick={open}>
              <Trans>Connect</Trans>
            </Button>
          ) : null}
        </div>
        {!connectable &&
        count === 0 &&
        integration.source === "composio" &&
        !identity.staff ? (
          <p className="text-muted-foreground">
            <Trans>An admin connects this for everyone.</Trans>
          </p>
        ) : null}
        {connected ? (
          <output>
            <Trans>Connected.</Trans>
          </output>
        ) : null}
        <Tabs
          onValueChange={(next: Tab) => {
            void navigate({
              replace: true,
              search: (last) => ({
                ...last,
                tab: next === "overview" ? undefined : next,
              }),
            });
          }}
          value={tab}
        >
          <TabsList variant="line">
            <TabsTrigger value="overview">
              <Trans>Overview</Trans>
            </TabsTrigger>
            <TabsTrigger value="account">
              <Trans>Account</Trans>
              <span className="text-muted-foreground tabular-nums">
                {count}
              </span>
            </TabsTrigger>
          </TabsList>
          <TabsContent value="overview">
            <div className="pt-4">
              <Overview
                identity={identity}
                integration={integration}
                tools={integration.listed ? tools : undefined}
              />
            </div>
          </TabsContent>
          <TabsContent value="account">
            <div className="pt-4">
              <Account
                held={held}
                identity={identity}
                integration={integration}
                onConnect={connectable ? open : undefined}
              />
            </div>
          </TabsContent>
        </Tabs>
      </div>
      {connectable ? (
        <ConnectDialog
          identity={identity}
          integration={integration}
          onOpenChange={setConnecting}
          open={connecting}
        />
      ) : null}
    </>
  );
};

const IntegrationRoute = () => {
  const { catalog, connections } = Route.useLoaderData();
  const { integration: key } = Route.useParams();
  const { t } = useLingui();
  const parsed = parseIntegrationKey(key);
  const integrations = { label: t`Integrations`, to: "/integrations" as const };
  if (catalog.state !== "ready") {
    return (
      <PageNotLoaded
        crumbs={[integrations, { label: key }]}
        icon={BlocksIcon}
        notFound={t`Integration not found`}
        page={catalog}
      />
    );
  }
  if (connections.state !== "ready") {
    return (
      <PageNotLoaded
        crumbs={[integrations, { label: key }]}
        page={connections}
      />
    );
  }
  const integration =
    parsed === undefined
      ? undefined
      : integrationsOf(catalog.data.entries, connections.data).find(
          (candidate) => candidate.key === key
        );
  if (integration === undefined) {
    return (
      <NotFound
        crumbs={[integrations, { label: t`Not found` }]}
        icon={BlocksIcon}
        title={t`Integration not found`}
      />
    );
  }
  return <IntegrationPage integration={integration} />;
};

export const Route = createFileRoute("/_shell/integrations/$integration")({
  validateSearch: (search: Record<string, unknown>): IntegrationSearch => ({
    tab: search.tab === "account" ? "account" : undefined,
    connection:
      typeof search.connection === "string" ? search.connection : undefined,
  }),
  loader: async ({ context: { core, identity }, params }) => {
    const parsed = parseIntegrationKey(params.integration);
    const [read, tools] = await Promise.all([
      loadIntegrations(core, identity, { held: true }),
      parsed === undefined
        ? undefined
        : loadFromCore(
            core,
            async (session) =>
              await session.connections.catalogTools(parsed.source, parsed.id)
          ),
    ]);
    return { ...read, tools };
  },
  pendingComponent: PageLoading,
  component: IntegrationRoute,
});
