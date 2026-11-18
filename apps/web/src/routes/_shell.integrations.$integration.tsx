import type { CatalogTool, ListedConnection } from "@grasp-os/shared/connect";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Await, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import {
  canConnect,
  ConnectDialog,
  signInAgainTarget,
} from "../connections/connect-dialog.tsx";
import { ConnectedDialog } from "../connections/connected-dialog.tsx";
import { ConnectionList } from "../connections/connection-list.tsx";
import type { HeldPermissions } from "../connections/connection-list.tsx";
import {
  aboutOf,
  allowedToolsOf,
  newestOf,
  toolGroups,
  useReaches,
  useWhyNoConnect,
} from "../connections/integration-facts.ts";
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
import { ProviderMark } from "../connections/provider-mark.tsx";
import {
  changeableConnectionOf,
  ToolPermissions,
} from "../connections/tool-permissions.tsx";
import { ToolRows } from "../connections/tool-rows.tsx";
import { WorkflowsUsing } from "../connections/workflows-using.tsx";
import { formatDate, formatDayMonth } from "../format.ts";
import {
  LoadingLines,
  NotFound,
  PageLoading,
  PageNotLoaded,
} from "../frame/page-states.tsx";
import { Page } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { Alert } from "../grasp/alert/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import { Empty } from "../grasp/empty/index.ts";
import { Cable } from "../grasp/icons/index.ts";
import { PageHeader } from "../grasp/page-header/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { SectionHeader } from "../grasp/section-header/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { loadFromCore, notLoadedText } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { FactRow, SettingsRows } from "../settings/section.tsx";

// One integration: its mark, name and what it is for, then a page of
// compact cards, as Settings has them, where the prototype had tabs:
// where its account stands, what its tools can do, for admins whether it
// is offered, the workflows the person can open that use it, and each
// connection made to it (who connected it, when, signing in again and
// disconnecting). An address's `tab` (an older link's) still opens it. A flow comes back here from the provider, through
// core's callback, with `connection=<id>` (and `again=1` when it signed in
// again), and opens the success page.

type Tab = "overview" | "workflows" | "account";

interface IntegrationSearch {
  tab?: Tab;
  connection?: string;
  /** The flow that made `connection` signed in again (connect-dialog.tsx). */
  again?: true;
}

/** Where its account stands, as a Badge: active for whom, or to sign in to again. */
const StateBadge = ({ state }: { state: IntegrationState }) => {
  const { t } = useLingui();
  if (state === "needs_reauth") {
    return <Badge tone="attention">{t`Needs someone to sign in again`}</Badge>;
  }
  if (state === "shared") {
    return <Badge tone="success">{t`Active, for the whole company`}</Badge>;
  }
  return state === "personal" ? (
    <Badge tone="success">{t`Active, only for you`}</Badge>
  ) : null;
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
    <Alert
      title={t`Which Apps and agents hold permissions: ${why}`}
      variant="danger"
    />
  );
};

/** The connection whose tools the person may change here, and whether they are staff. */
interface Changeable {
  connection: ListedConnection;
  staff: boolean;
}

/**
 * What its tools can do, as its provider declares them, reads first, each
 * group a run of rows under its name: with a switch each where the person
 * may change which a connection allows.
 */
const ToolList = ({
  tools,
  app,
  slug,
  allowed,
  changeable,
}: {
  tools: Loaded<CatalogTool[]>;
  app: string;
  /** The app's id in the catalog, which a Composio tool's name starts with. */
  slug: string;
  allowed: ReadonlySet<string> | undefined;
  changeable: Changeable | undefined;
}) => {
  const { i18n, t } = useLingui();
  if (tools.state !== "ready") {
    return (
      <Empty size="inline" tone="danger">
        {notLoadedText(tools, i18n)}
      </Empty>
    );
  }
  if (tools.data.length === 0) {
    return <Empty size="inline">{t`${app} has no tools.`}</Empty>;
  }
  if (changeable !== undefined) {
    return (
      <ToolPermissions
        connection={changeable.connection}
        staff={changeable.staff}
        tools={tools.data}
      />
    );
  }
  return toolGroups.map((group) => {
    const inGroup = tools.data.filter(
      ({ readOnly }) => readOnly === group.readOnly
    );
    const title = i18n._(group.title);
    return inGroup.length === 0 ? null : (
      <section key={group.id} {...stylex.props(styles.group)}>
        <SectionHeader layout={styles.groupHead} size="sm" title={title} />
        <ToolRows allowed={allowed} label={title} slug={slug} tools={inGroup} />
      </section>
    );
  });
};

/**
 * Its tools once their read comes (the rest of the page doesn't wait for
 * it), or why there are none to show: the catalog couldn't be read, or
 * doesn't list it.
 */
const Tools = ({
  tools,
  catalog,
  app,
  slug,
  allowed,
  changeable,
}: {
  tools: Promise<Loaded<CatalogTool[]>> | undefined;
  catalog: Loaded<unknown>;
  app: string;
  slug: string;
  allowed: ReadonlySet<string> | undefined;
  changeable: Changeable | undefined;
}) => {
  const { i18n, t } = useLingui();
  if (tools === undefined && catalog.state !== "ready") {
    return (
      <Empty size="inline" tone="danger">
        {notLoadedText(catalog, i18n)}
      </Empty>
    );
  }
  if (tools === undefined) {
    return (
      <Empty size="inline">
        {t`The catalog doesn't list ${app}, so its tools can't be shown.`}
      </Empty>
    );
  }
  return (
    <Await fallback={<LoadingLines />} promise={tools}>
      {(loaded) => (
        <ToolList
          allowed={allowed}
          app={app}
          slug={slug}
          changeable={changeable}
          tools={loaded}
        />
      )}
    </Await>
  );
};

/**
 * Where its account stands, once it is connected: signing in again to the
 * first connection whose access ran out that this person may sign in to
 * again, who connected it, and what it reaches, as Settings' fact rows. An
 * active connection has nothing to sign in to again (connect refuses it as
 * already connected).
 */
const AccountCard = ({
  integration,
  identity,
}: {
  integration: Integration;
  identity: Identity;
}) => {
  const { t } = useLingui();
  const reachesOf = useReaches();
  const [signingIn, setSigningIn] = useState(false);
  const target = signInAgainTarget(integration, identity);
  const newest = newestOf(integration);
  const date = newest === undefined ? "" : formatDate(newest.createdAt);
  const person = newest?.connectedByName ?? null;
  return (
    <SectionCard
      actions={
        target === undefined ? undefined : (
          <Button
            onClick={() => {
              setSigningIn(true);
            }}
            size="sm"
            variant="ink"
          >
            {t`Sign in again`}
          </Button>
        )
      }
      density="compact"
      flush
      title={t`Account`}
    >
      <SettingsRows>
        <FactRow label={t`Status`}>
          <StateBadge state={stateOf(integration)} />
        </FactRow>
        <FactRow label={t`Reaches`}>{reachesOf(integration)}</FactRow>
        {newest === undefined ? null : (
          <FactRow label={t`Connected by`}>
            {person === null
              ? date
              : t({
                  message: `${person}, ${date}`,
                  comment: "Who connected the app, then the day they did.",
                })}
          </FactRow>
        )}
      </SettingsRows>
      {target === undefined ? null : (
        <ConnectDialog
          again={target}
          identity={identity}
          integration={integration}
          onOpenChange={setSigningIn}
          open={signingIn}
        />
      )}
    </SectionCard>
  );
};

/** What `identity` may change of `integration`'s tools here, if anything. */
const changeableOf = (
  integration: Integration,
  identity: Identity
): Changeable | undefined => {
  const connection = changeableConnectionOf(integration, identity);
  return connection === undefined
    ? undefined
    : { connection, staff: identity.staff };
};

/** What the app is for and, once it is connected, since when: "Accounting · connected 3 Oct". */
const useSubtitle = () => {
  const { t } = useLingui();
  return (integration: Integration): string | undefined => {
    const about = aboutOf(integration);
    const newest = newestOf(integration);
    if (newest === undefined) {
      return about;
    }
    const date = formatDayMonth(newest.createdAt);
    return about === undefined
      ? t`Connected ${date}`
      : t({
          message: `${about} · connected ${date}`,
          comment:
            "{about} is what the app is for, as the app list writes it, e.g. “Accounting”. {date} is a day and month.",
        });
  };
};

const styles = stylex.create({
  title: { display: "flex", alignItems: "center", gap: grasp.space3 },
  // A group of tools in the card's flush rows: its name and its rows'
  // words on the card's inset (the rows bring 12px of their own).
  group: {
    display: "grid",
    gap: grasp.space1,
    paddingInline: grasp.space1,
    paddingBlock: grasp.space3,
  },
  groupHead: { marginInline: grasp.space3 },
});

/**
 * One app's page, as a page of compact cards (no tabs): where its account
 * stands, what Grasp may do in it, whether it is offered, the workflows
 * that use it, and its connections.
 */
const IntegrationPage = ({ integration }: { integration: Integration }) => {
  const { held, tools, catalog, uses } = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  const { connection, again = false } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { t } = useLingui();
  const subtitleOf = useSubtitle();
  const whyNoConnectOf = useWhyNoConnect();
  // One sign-in for the page, held here so it stays as the page changes.
  const [connecting, setConnecting] = useState(false);
  const connectable = canConnect(integration, identity);
  // Only a connection the page lists: anyone can put an ID in a link.
  const connected =
    connection === undefined
      ? undefined
      : integration.connections.find(({ id }) => id === connection);
  const count = integration.connections.length;
  const subtitle = subtitleOf(integration);
  const why =
    catalog.state === "ready"
      ? whyNoConnectOf(integration, identity)
      : t`The catalog of integrations couldn't be read, so this page shows only what your accounts say about it.`;
  return (
    <>
      <SiteHeader
        crumbs={[
          { label: t`Integrations`, to: "/integrations" },
          { label: integration.name },
        ]}
      />
      <Page>
        <PageHeader
          actions={
            connectable ? (
              <Button
                onClick={() => {
                  setConnecting(true);
                }}
                variant={count === 0 ? "ink" : "quiet"}
              >
                {count === 0 ? t`Connect` : t`Connect another account`}
              </Button>
            ) : undefined
          }
          aside={
            integration.listed && !integration.offered ? (
              <Badge>{t`Not offered`}</Badge>
            ) : undefined
          }
          {...(subtitle === undefined ? {} : { description: subtitle })}
          descriptionLines={2}
          title={
            <span {...stylex.props(styles.title)}>
              <ProviderMark
                id={integration.id}
                logo={integration.logo}
                name={integration.name}
                size="md"
              />
              {integration.name}
            </span>
          }
        />
        {why === undefined ? null : <Alert title={why} />}
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
        {count === 0 ? null : (
          <AccountCard identity={identity} integration={integration} />
        )}
        <SectionCard
          density="compact"
          flush
          info={t`What its tools do, as its provider declares them. Apps and agents use only what they are granted, and a tool that changes something waits for its person to confirm it.`}
          infoLabel={t`More about what Grasp may do`}
          title={t`What Grasp may do`}
        >
          <Tools
            allowed={allowedToolsOf(integration)}
            app={integration.name}
            slug={integration.id}
            catalog={catalog}
            changeable={changeableOf(integration, identity)}
            tools={integration.listed ? tools : undefined}
          />
        </SectionCard>
        {isAdmin(identity.role) && integration.listed ? (
          <OfferSwitch integration={integration} staff={identity.staff} />
        ) : null}
        <SectionCard density="compact" flush title={t`Workflows`}>
          <WorkflowsUsing integration={integration} uses={uses} />
        </SectionCard>
        {/* Its connections, each a card of its own. */}
        <HeldNotLoaded held={held} />
        <ConnectionList
          held={held}
          identity={identity}
          integration={integration}
        />
      </Page>
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
  pendingComponent: PageLoading,
  component: IntegrationRoute,
});
