import type { CatalogTool } from "@grasp-os/shared/connect";
import { catalogGroups } from "@grasp-os/shared/connect-names";
import type { CatalogGroup } from "@grasp-os/shared/connect-names";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import type { ConnectionWorkflows } from "@grasp-os/shared/workflows";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import {
  Await,
  createFileRoute,
  Link,
  useNavigate,
} from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";

import { connectionErrorMessage } from "../connection-errors.ts";
import { ConnectedDialog } from "../connections/connected-dialog.tsx";
import { groupLabel } from "../connections/groups.ts";
import {
  HttpConnections,
  httpConnectionsMatching,
} from "../connections/http-connections.tsx";
import { IntegrationInspector } from "../connections/integration-inspector.tsx";
import { IntegrationTile, TileGrid } from "../connections/integration-tile.tsx";
import { loadIntegrations } from "../connections/integrations-data.ts";
import { IntegrationsHeader } from "../connections/integrations-header.tsx";
import { IntegrationsSkeleton } from "../connections/integrations-skeleton.tsx";
import { integrationsOf, sectionsOf } from "../connections/integrations.ts";
import type {
  Integration,
  IntegrationSections,
} from "../connections/integrations.ts";
import { RequestAppDialog } from "../connections/request-app-dialog.tsx";
import { RequestedApps } from "../connections/requested-apps.tsx";
import { RevocationsByHand } from "../connections/revocations-by-hand.tsx";
import type { ConnectionUses } from "../connections/workflows-using.tsx";
import type { CoreConnection } from "../core-connection.ts";
import { formatNumber } from "../format.ts";
import { Page, PageHeading } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { Alert } from "../grasp/alert/index.ts";
import { Button } from "../grasp/button/index.ts";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../grasp/empty/index.ts";
import { visuallyHidden } from "../grasp/hidden/hidden.ts";
import { Plus, Search as SearchIcon } from "../grasp/icons/index.ts";
import {
  InputGroup,
  InputGroupClear,
  InputGroupInput,
  InputGroupText,
} from "../grasp/input-group/index.ts";
import { SectionHeader } from "../grasp/section-header/index.ts";
import { Sheet, SheetContent, SheetTitle } from "../grasp/sheet/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";

// Integrations: what Grasp can reach. A header card says it at a glance,
// a brain in dots with a nerve into it for every connected app
// (integrations-header.tsx), and what needs someone to sign in again.
// Under it every app is a small tile with its own mark (Ruben, 19 Nov
// 2026: tiles, not rows, so many apps fit): what is connected first, then
// each kind of app, a few of each. The kinds themselves stand in the
// sidebar (integrations-sidebar.tsx), each opening that kind whole here
// (`?group=`); the search beside "Request app" narrows every app. An app
// opens in a Sheet over the page (`?app=`), which never squeezes the
// tiles, and its own page holds everything rarely changed. Outside APIs
// an admin approved, the apps people asked for and what an admin still
// has to revoke by hand follow. Core's callback sends a flow that failed
// back here with `connectionError=<code>`, and one that worked with
// `connection=<id>`.

/** What the address holds. */
interface IntegrationsSearch {
  q?: string;
  /** One kind of app, all of it, in place of a few of each. */
  group?: CatalogGroup;
  /** The app open over the page, by its key. */
  app?: string;
  connectionError?: string;
  /** A connection a flow just made, when core sent it back here. */
  connection?: string;
}

/** How many of a kind's apps show before "Show all", where every kind shows. */
const perKind = 8;

/** How many apps are drawn at first, and with every step further down. */
const step = 80;

const styles = stylex.create({
  actions: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
  },
  // Narrow on a phone, so "Request app" fits beside it.
  search: {
    width: { default: "9.5rem", "@media (min-width: 40rem)": "15rem" },
  },
  lists: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space8,
    minWidth: 0,
  },
  kind: { display: "flex", flexDirection: "column", gap: grasp.space4 },
  more: { alignSelf: "start" },
  mark: { display: "block", height: "1px" },
});

/** The search, in the address as it is typed. */
const Search = ({ q }: { q: string | undefined }) => {
  const { t } = useLingui();
  const navigate = useNavigate({ from: "/integrations/" });
  const [text, setText] = useState(q ?? "");
  // The search the address had when the box last followed it: a new one
  // from elsewhere (back) replaces what the box shows.
  const [followed, setFollowed] = useState(q);
  if (q !== followed) {
    setFollowed(q);
    if ((q ?? "") !== text.trim()) {
      setText(q ?? "");
    }
  }
  return (
    <InputGroup layout={styles.search}>
      <InputGroupText icon={SearchIcon} />
      <InputGroupInput
        aria-label={t`Search integrations`}
        onValueChange={(typed) => {
          setText(typed);
          void navigate({
            replace: true,
            search: (last) => ({
              ...last,
              q: typed.trim() === "" ? undefined : typed,
            }),
          });
        }}
        placeholder={t`Search apps`}
        type="search"
        value={text}
      />
      <InputGroupClear aria-label={t`Clear search`} />
    </InputGroup>
  );
};

/** An app's tools, as one read of them: the same read each time it opens. */
interface ToolsRead {
  tools: Promise<Loaded<CatalogTool[]>>;
}

/** Each app's tools, read once a tab first opens it, kept for as long as the tab is. */
const toolsRead = new WeakMap<CoreConnection, Map<string, ToolsRead>>();

/**
 * `integration`'s tools: read now, or the read from before, so the panel
 * waits for one read, not a new one with every render.
 */
const toolsOf = (core: CoreConnection, integration: Integration): ToolsRead => {
  const known = toolsRead.get(core) ?? new Map<string, ToolsRead>();
  toolsRead.set(core, known);
  const read = known.get(integration.key) ?? {
    tools: loadFromCore(
      core,
      async (session) =>
        await session.connections.catalogTools(
          integration.source,
          integration.id
        )
    ),
  };
  known.set(integration.key, read);
  return read;
};

/** A titled run of tiles, its count beside the title. */
const Tiles = ({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) => (
  <section {...stylex.props(styles.kind)}>
    <SectionHeader
      aside={
        <Text element="span" size="sm" tone="muted">
          {formatNumber(count)}
        </Text>
      }
      headingLevel={2}
      size="sm"
      title={title}
    />
    {children}
  </section>
);

/** What is connected, every app this person can see, needing someone first. */
const Connected = ({
  sections,
  uses,
  open,
}: {
  sections: IntegrationSections;
  uses: readonly ConnectionWorkflows[] | undefined;
  open: string | undefined;
}) => {
  const { identity } = Route.useRouteContext();
  const { t } = useLingui();
  const shown = [...sections.lapsed, ...sections.connected, ...sections.unused];
  if (shown.length === 0) {
    return null;
  }
  const title = t({
    message: "Connected",
    context: "apps that are connected",
  });
  return (
    <Tiles count={shown.length} title={title}>
      <TileGrid label={title}>
        {shown.map((integration) => (
          <IntegrationTile
            identity={identity}
            integration={integration}
            key={integration.key}
            open={integration.key === open}
            uses={uses}
          />
        ))}
      </TileGrid>
    </Tiles>
  );
};

/** A run of apps, the first `step` drawn and more as the reader nears its end. */
const Drawn = ({
  integrations,
  label,
  open,
}: {
  integrations: readonly Integration[];
  label: string;
  open: string | undefined;
}) => {
  const { identity } = Route.useRouteContext();
  const [drawn, setDrawn] = useState(step);
  // The end of what is drawn: once it is near the page, well before it
  // shows, more is drawn. It is a new mark after every step, so it is
  // looked at again. Measured against the part of the page that scrolls,
  // which is not the window.
  const watch = (mark: HTMLSpanElement | null): (() => void) | undefined => {
    if (mark === null) {
      return undefined;
    }
    const watcher = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting === true) {
          setDrawn((count) => count + step);
        }
      },
      { root: mark.closest("[data-scroller]"), rootMargin: "800px" }
    );
    watcher.observe(mark);
    return () => {
      watcher.disconnect();
    };
  };
  return (
    <>
      <TileGrid label={label}>
        {integrations.slice(0, drawn).map((integration) => (
          <IntegrationTile
            identity={identity}
            integration={integration}
            key={integration.key}
            open={integration.key === open}
          />
        ))}
      </TileGrid>
      {integrations.length > drawn ? (
        <span
          aria-hidden="true"
          key={drawn}
          ref={watch}
          {...stylex.props(styles.mark)}
        />
      ) : null}
    </>
  );
};

/** Every kind of app, a few of each, with the rest of a kind a press away. */
const Kinds = ({
  others,
  open,
}: {
  others: readonly Integration[];
  open: string | undefined;
}) => {
  const { identity } = Route.useRouteContext();
  const { t, i18n } = useLingui();
  return catalogGroups.map((group) => {
    const ofKind = others.filter((integration) => integration.group === group);
    if (ofKind.length === 0) {
      return null;
    }
    const label = i18n._(groupLabel[group]);
    const count = ofKind.length;
    return (
      <Tiles count={count} key={group} title={label}>
        <TileGrid label={label}>
          {ofKind.slice(0, perKind).map((integration) => (
            <IntegrationTile
              identity={identity}
              integration={integration}
              key={integration.key}
              open={integration.key === open}
            />
          ))}
        </TileGrid>
        {count > perKind ? (
          <Button
            layout={styles.more}
            render={
              <Link
                from="/integrations/"
                search={(last) => ({ ...last, group })}
                to="."
              />
            }
            size="sm"
            variant="ghost"
          >
            {t`${plural(count, { one: `Show the # app in ${label}`, other: `Show all # in ${label}` })}`}
          </Button>
        ) : null}
      </Tiles>
    );
  });
};

/**
 * Every app nobody connected yet: every kind, a few of each; one kind
 * whole; or, while someone searches, what the search finds.
 */
const Others = ({
  others,
  group,
  q,
  open,
}: {
  others: readonly Integration[];
  group: CatalogGroup | undefined;
  q: string | undefined;
  open: string | undefined;
}) => {
  const { t, i18n } = useLingui();
  if (others.length === 0) {
    return null;
  }
  if (q === undefined && group === undefined) {
    return <Kinds open={open} others={others} />;
  }
  const title =
    group === undefined
      ? t({
          message: "Add an app",
          context: "apps that can still be connected",
        })
      : i18n._(groupLabel[group]);
  return (
    <Tiles count={others.length} title={title}>
      {/* Mounted anew for another search or kind, so it starts at its first apps again. */}
      <Drawn
        integrations={others}
        key={`${group ?? ""}·${q ?? ""}`}
        label={title}
        open={open}
      />
    </Tiles>
  );
};

/**
 * The success dialog for the connection a flow just made, once core sent
 * the browser back here with it. Only a connection the page lists: anyone
 * can put an ID in a link.
 */
const Returned = ({
  connection,
  integrations,
}: {
  connection: string | undefined;
  integrations: readonly Integration[];
}) => {
  const navigate = useNavigate({ from: "/integrations/" });
  const connectedTo =
    connection === undefined
      ? undefined
      : integrations.find((integration) =>
          integration.connections.some(({ id }) => id === connection)
        );
  return (
    <ConnectedDialog
      again={false}
      app={connectedTo?.name ?? ""}
      connection={connectedTo?.connections.find(({ id }) => id === connection)}
      onClose={() => {
        void navigate({
          replace: true,
          search: (last) => ({ ...last, connection: undefined }),
        });
      }}
    />
  );
};

/** The open app, in a Sheet over the page: it never squeezes the tiles. */
const Details = ({
  integration,
  identity,
  uses,
  core,
}: {
  integration: Integration;
  identity: Identity;
  uses: ConnectionUses;
  core: CoreConnection;
}) => {
  const { t } = useLingui();
  const navigate = useNavigate({ from: "/integrations/" });
  const close = () => {
    void navigate({
      resetScroll: false,
      search: (last) => ({ ...last, app: undefined }),
    });
  };
  const tools = integration.listed
    ? toolsOf(core, integration).tools
    : undefined;
  return (
    <Sheet
      onOpenChange={(open: boolean) => {
        if (!open) {
          close();
        }
      }}
      open
    >
      <SheetContent closeLabel={t`Close`}>
        {/* Named for a screen reader only: the panel's own head says its name. */}
        <SheetTitle hidden>{integration.name}</SheetTitle>
        {/* Its own close: the hidden title draws no bar to hold the Sheet's. */}
        <IntegrationInspector
          framed={false}
          identity={identity}
          integration={integration}
          onClose={close}
          tools={tools}
          uses={uses}
        />
      </SheetContent>
    </Sheet>
  );
};

/** What the page must say before its tiles: a failed flow, staff's limits, Composio down, revokes to make. */
const Notices = ({
  connectionError,
  integrations,
  toRevoke,
  unlisted,
}: {
  connectionError: string | undefined;
  integrations: readonly Integration[];
  toRevoke: Parameters<typeof RevocationsByHand>[0]["toDos"];
  /** Composio's toolkits couldn't be listed. */
  unlisted: boolean;
}) => {
  const { identity } = Route.useRouteContext();
  const { t } = useLingui();
  return (
    <>
      {connectionError === undefined ? null : (
        <Alert title={connectionErrorMessage(connectionError)} tone="danger" />
      )}
      {identity.staff ? (
        <Alert
          title={t`Grasp staff can't connect accounts or change what is offered here: that is for the organization's own people.`}
        />
      ) : null}
      {unlisted ? (
        <Alert
          title={t`Composio's toolkits can't be listed right now. Try again shortly.`}
          tone="attention"
        />
      ) : null}
      <RevocationsByHand
        nameOf={(provider) =>
          integrations.find(
            (each) => each.source === "native" && each.id === provider
          )?.name ?? provider
        }
        toDos={toRevoke}
      />
    </>
  );
};

/**
 * Below the apps: outside APIs an admin approved and the apps people asked
 * for. While someone searches, only the outside APIs the search finds.
 */
const Extras = ({
  identity,
  listed,
  q,
  requests,
}: {
  identity: Identity;
  listed: Parameters<typeof httpConnectionsMatching>[0] | undefined;
  q: string | undefined;
  requests: Parameters<typeof RequestedApps>[0]["requests"];
}) => {
  if (
    q !== undefined &&
    httpConnectionsMatching(listed ?? [], q).length === 0
  ) {
    return null;
  }
  return (
    <>
      <HttpConnections connections={listed} identity={identity} search={q} />
      {q === undefined ? (
        <RequestedApps requests={requests} search={q} />
      ) : null}
    </>
  );
};

/** A search that finds nothing: say so, and offer to ask for the app. */
const NothingFound = ({ onRequest }: { onRequest: () => void }) => {
  const { t } = useLingui();
  return (
    <Empty shape="cards" size="md">
      <EmptyHeader>
        <EmptyMedia picture="search" />
        <EmptyTitle>{t`No apps match your search`}</EmptyTitle>
        <EmptyDescription>{t`Ask for the app you need, and an admin can add it.`}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button icon={Plus} onClick={onRequest} variant="quiet">
          {t`Request app`}
        </Button>
      </EmptyContent>
    </Empty>
  );
};

/**
 * What the page shows for a kind or a search: the apps nobody connected
 * that it keeps, and how many apps and outside APIs show in all.
 */
const shownOf = (
  first: IntegrationSections,
  listed: Parameters<typeof httpConnectionsMatching>[0],
  group: CatalogGroup | undefined,
  q: string | undefined
): { others: Integration[]; shown: number } => {
  if (group !== undefined) {
    const others = first.others.filter(
      (integration) => integration.group === group
    );
    return { others, shown: others.length };
  }
  const connected =
    first.lapsed.length + first.connected.length + first.unused.length;
  return {
    others: first.others,
    shown:
      connected +
      first.others.length +
      httpConnectionsMatching(listed, q).length,
  };
};

const Integrations = () => {
  const { catalog, connections, requests, toRevoke, uses } =
    Route.useLoaderData();
  const { identity, core } = Route.useRouteContext();
  const { q, group, app, connectionError, connection } = Route.useSearch();
  const { t, i18n } = useLingui();
  const listed = connections.state === "ready" ? connections.data : undefined;
  const integrations = integrationsOf(
    catalog.state === "ready" ? catalog.data.entries : [],
    listed ?? []
  );
  // Before it is known which workflows use what: the sections as they
  // stand then; the count of what shows doesn't change after.
  const first = sectionsOf(integrations, { show: "all" }, q);
  const { others, shown } = shownOf(first, listed ?? [], group, q);
  const loaded = catalog.state === "ready" && connections.state === "ready";
  const opened = integrations.find((integration) => integration.key === app);
  const [requesting, setRequesting] = useState(false);
  // The overview itself: no kind chosen and nothing searched.
  const overview = group === undefined && q === undefined;
  const kind = group === undefined ? undefined : i18n._(groupLabel[group]);
  const crumbs =
    kind === undefined
      ? [{ label: t`Integrations` }]
      : [
          { label: t`Integrations`, to: "/integrations" as const },
          { label: kind },
        ];
  return (
    <>
      <RequestAppDialog
        integrations={integrations}
        onOpenChange={setRequesting}
        open={requesting}
      />
      <SiteHeader crumbs={crumbs} />
      <Page>
        <PageHeading
          action={
            <div {...stylex.props(styles.actions)}>
              <Search q={q} />
              <Button
                icon={Plus}
                onClick={() => {
                  setRequesting(true);
                }}
                variant="quiet"
              >
                {t`Request app`}
              </Button>
            </div>
          }
          title={kind ?? t`Integrations`}
        />
        <Returned connection={connection} integrations={integrations} />
        <Notices
          connectionError={connectionError}
          integrations={integrations}
          toRevoke={toRevoke}
          unlisted={
            catalog.state === "ready" && catalog.data.composio === "unavailable"
          }
        />
        <NotLoaded page={catalog} />
        <NotLoaded page={connections} />
        <output {...stylex.props(visuallyHidden)}>
          {q === undefined
            ? ""
            : t`${plural(shown, { one: "# integration shown", other: "# integrations shown" })}`}
        </output>
        <div {...stylex.props(styles.lists)}>
          {overview && loaded ? (
            <IntegrationsHeader
              identity={identity}
              integrations={integrations}
            />
          ) : null}
          {group === undefined ? (
            <Await
              fallback={
                <Connected open={app} sections={first} uses={undefined} />
              }
              promise={uses}
            >
              {(read) => {
                const known = read.state === "ready" ? read.data : undefined;
                return (
                  <Connected
                    open={app}
                    sections={sectionsOf(
                      integrations,
                      { show: "all" },
                      q,
                      known
                    )}
                    uses={known}
                  />
                );
              }}
            </Await>
          ) : null}
          <Others group={group} open={app} others={others} q={q} />
          {loaded && shown === 0 ? (
            <NothingFound
              onRequest={() => {
                setRequesting(true);
              }}
            />
          ) : null}
          {group === undefined ? (
            <Extras
              identity={identity}
              listed={listed}
              q={q}
              requests={requests}
            />
          ) : null}
        </div>
      </Page>
      {opened === undefined ? null : (
        <Details
          core={core}
          identity={identity}
          integration={opened}
          key={opened.key}
          uses={uses}
        />
      )}
    </>
  );
};

/** Text from the address; the router reads `?q=365` as a number. */
const textOf = (value: unknown): string | undefined => {
  const text = typeof value === "number" ? String(value) : value;
  return typeof text === "string" && text.trim() !== "" ? text : undefined;
};

export const Route = createFileRoute("/_shell/integrations/")({
  validateSearch: (search: Record<string, unknown>): IntegrationsSearch => ({
    q: textOf(search.q),
    group: catalogGroups.find((each) => each === search.group),
    app: textOf(search.app),
    connectionError: textOf(search.connectionError),
    connection: textOf(search.connection),
  }),
  // Read once: the search, a kind and the open app only narrow what was
  // read, so a new one keeps the page as it is rather than reading it
  // again. A change reads it again (use-change.ts invalidates it).
  shouldReload: false,
  loader: async ({ context: { core, identity } }) => ({
    ...(await loadIntegrations(core, identity, { held: false })),
    // Not awaited: the catalog never waits for the apps people asked for.
    requests: loadFromCore(
      core,
      async (session) => await session.connections.appRequests()
    ),
    // Admins' and Grasp staff's only, and never waited for either.
    toRevoke:
      identity.staff || isAdmin(identity.role)
        ? loadFromCore(
            core,
            async (session) => await session.connections.revocationsByHand()
          )
        : undefined,
  }),
  pendingComponent: IntegrationsSkeleton,
  component: Integrations,
});
