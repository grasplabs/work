import {
  composioReasonSchema,
  connectVersionSchema,
  releaseNameSchema,
} from "@grasp-os/shared/connect";
import type { ComposioReason } from "@grasp-os/shared/connect";
import { catalogGroups } from "@grasp-os/shared/connect-names";
import type { CatalogGroup } from "@grasp-os/shared/connect-names";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import type { ConnectionWorkflows } from "@grasp-os/shared/workflows";
import { Alert, AlertTitle } from "@grasp-os/ui/components/alert";
import { Button } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupClear,
  InputGroupInput,
} from "@grasp-os/ui/components/input-group";
import { ItemGrid } from "@grasp-os/ui/components/item";
import { PageHeader } from "@grasp-os/ui/components/page-header";
import { SectionHeader } from "@grasp-os/ui/components/section-header";
import { Text } from "@grasp-os/ui/components/text";
import { Icon, PlusIcon, SearchIcon } from "@grasp-os/ui/lib/icons";
import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
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
import { AddConnector } from "../connections/add-connector.tsx";
import {
  ConnectedDialog,
  returnedOf,
} from "../connections/connected-dialog.tsx";
import { groupLabel } from "../connections/groups.ts";
import {
  HttpConnections,
  httpConnectionsMatching,
} from "../connections/http-connections.tsx";
import { IntegrationPanel } from "../connections/integration-panel.tsx";
import { IntegrationTile } from "../connections/integration-tile.tsx";
import type { OpenApp } from "../connections/integration-tile.tsx";
import { IntegrationsBand } from "../connections/integrations-band.tsx";
import { knownOf, loadIntegrations } from "../connections/integrations-data.ts";
import { IntegrationsSkeleton } from "../connections/integrations-skeleton.tsx";
import { integrationsOf, sectionsOf } from "../connections/integrations.ts";
import type {
  Integration,
  IntegrationSections,
} from "../connections/integrations.ts";
import { PartNotLoaded } from "../connections/part-not-loaded.tsx";
import { RecommendedApps } from "../connections/recommended-apps.tsx";
import { nothingKnown, recommendedOf } from "../connections/recommended.ts";
import { RequestAppDialog } from "../connections/request-app-dialog.tsx";
import { RequestedApps } from "../connections/requested-apps.tsx";
import { RevocationsByHand } from "../connections/revocations-by-hand.tsx";
import { SupportDetails, supportOf } from "../connections/support-details.tsx";
import { formatNumber } from "../format.ts";
import { PageNotLoaded } from "../frame/page-states.tsx";
import { Page } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore } from "../load-from-core.tsx";

// Integrations: what Grasp can reach. A slim band says it at a glance,
// with the connected apps' marks at its end (integrations-band.tsx), then
// the apps to connect first, each saying why (recommended-apps.tsx; Ruben's
// direction B, 20 Nov 2026). Every app is a small tile with its own mark
// (Ruben, 19 Nov 2026: tiles, not rows, so many apps fit): what is
// connected, then each kind of app, a few of each, leaving out the
// recommended ones. The kinds themselves stand in the
// sidebar (integrations-sidebar.tsx), each opening that kind whole here
// (`?group=`); the search beside "Request app" narrows every app. An app
// opens in a panel over the page (`?app=`), which never squeezes the
// tiles, and its own page holds everything rarely changed. Tiles, panel
// and page are the app parts (connections/app/, #2503's library block),
// drawn from one App each (connections/app-of.tsx). Outside APIs
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
  /**
   * Why a Composio flow was refused, the release core runs and which
   * version of connect refused, when core's callback named them: each
   * only as its fixed form has it, for support.
   */
  connectionReason?: ComposioReason;
  connectionRelease?: string;
  connectionVersion?: string;
  /** A connection a flow just made, when core sent it back here. */
  connection?: string;
}

/** How many of a kind's apps show before "Show all", where every kind shows. */
const perKind = 8;

/** How many apps are drawn at first, and with every step further down. */
const step = 80;

const PHONE = "@container page-header (width < 40rem)";

const styles = stylex.create({
  // On a phone (the header under 40rem) the row is the column's width: the field takes what Request
  // app leaves, and under 9rem of it Request app goes to the next line (ui#93).
  actions: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["2"],
    width: { default: "auto", [PHONE]: "100cqi" },
  },
  search: {
    width: { default: "16rem", [PHONE]: "auto" },
    flexGrow: { default: 0, [PHONE]: 1 },
    flexShrink: { default: 0, [PHONE]: 1 },
    flexBasis: { default: "auto", [PHONE]: 0 },
    minWidth: { default: null, [PHONE]: "9rem" },
  },
  lists: {
    display: "flex",
    flexDirection: "column",
    gap: space["8"],
    minWidth: 0,
  },
  kind: { display: "flex", flexDirection: "column", gap: space["4"] },
  more: { alignSelf: "start" },
  mark: { display: "block", height: "1px" },
  // The room #2503's Empty kept round its words for the faint cards it
  // drew behind them (its `shape`), which Damsko's Empty doesn't draw
  // (registry gap of 24 Nov 2026): a band's 32px and the words' 20px.
  nothingFound: { marginBlock: `calc(${space["8"]} + ${space["5"]})` },
});

/** The search, in the address as it is typed. */
const Search = ({ q }: { q: string | undefined }) => {
  const { t } = useLingui();
  const navigate = useNavigate({ from: "/connectors/" });
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
    <InputGroup style={styles.search} size="sm">
      <InputGroupAddon>
        <Icon icon={SearchIcon} />
      </InputGroupAddon>
      <InputGroupInput
        aria-label={t`Search connectors`}
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
      badge={
        <Text as="span" color="muted" size="sm">
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
  onOpen,
}: {
  sections: IntegrationSections;
  uses: readonly ConnectionWorkflows[] | undefined;
  open: string | undefined;
  onOpen: OpenApp;
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
      <ItemGrid aria-label={title}>
        {shown.map((integration) => (
          <IntegrationTile
            identity={identity}
            integration={integration}
            key={integration.key}
            onOpen={onOpen}
            open={integration.key === open}
            uses={uses}
          />
        ))}
      </ItemGrid>
    </Tiles>
  );
};

/** A run of apps, the first `step` drawn and more as the reader nears its end. */
const Drawn = ({
  integrations,
  label,
  open,
  onOpen,
}: {
  integrations: readonly Integration[];
  label: string;
  open: string | undefined;
  onOpen: OpenApp;
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
      <ItemGrid aria-label={label}>
        {integrations.slice(0, drawn).map((integration) => (
          <IntegrationTile
            identity={identity}
            integration={integration}
            key={integration.key}
            onOpen={onOpen}
            open={integration.key === open}
          />
        ))}
      </ItemGrid>
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
  recommended,
  open,
  onOpen,
}: {
  others: readonly Integration[];
  /** The recommended apps' keys: they stand in their own run above. */
  recommended: ReadonlySet<string>;
  open: string | undefined;
  onOpen: OpenApp;
}) => {
  const { identity } = Route.useRouteContext();
  const { t, i18n } = useLingui();
  return catalogGroups.map((group) => {
    const ofKind = others.filter((integration) => integration.group === group);
    const shown = ofKind
      .filter((integration) => !recommended.has(integration.key))
      .slice(0, perKind);
    if (shown.length === 0) {
      return null;
    }
    const label = i18n._(groupLabel[group]);
    const count = ofKind.length;
    return (
      <Tiles count={count} key={group} title={label}>
        <ItemGrid aria-label={label}>
          {shown.map((integration) => (
            <IntegrationTile
              identity={identity}
              integration={integration}
              key={integration.key}
              onOpen={onOpen}
              open={integration.key === open}
            />
          ))}
        </ItemGrid>
        {count > shown.length ? (
          <Button style={styles.more} asChild size="sm" variant="ghost">
            <Link
              from="/connectors/"
              search={(last) => ({ ...last, group })}
              to="."
            >
              {t`${plural(count, { one: `Show the # app in ${label}`, other: `Show all # in ${label}` })}`}
            </Link>
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
  recommended,
  group,
  q,
  open,
  onOpen,
}: {
  others: readonly Integration[];
  recommended: ReadonlySet<string>;
  group: CatalogGroup | undefined;
  q: string | undefined;
  open: string | undefined;
  onOpen: OpenApp;
}) => {
  const { t, i18n } = useLingui();
  if (others.length === 0) {
    return null;
  }
  if (q === undefined && group === undefined) {
    return (
      <Kinds
        onOpen={onOpen}
        open={open}
        others={others}
        recommended={recommended}
      />
    );
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
        onOpen={onOpen}
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
  const navigate = useNavigate({ from: "/connectors/" });
  const connectedTo =
    connection === undefined
      ? undefined
      : integrations.find((integration) =>
          integration.connections.some(({ id }) => id === connection)
        );
  // Only one that works, and "again" where it took a stopped one's place.
  const returned = returnedOf(connectedTo?.connections ?? [], connection);
  return (
    <ConnectedDialog
      again={returned.again}
      app={connectedTo?.name ?? ""}
      connection={returned.connection}
      onClose={() => {
        void navigate({
          replace: true,
          search: (last) => ({ ...last, connection: undefined }),
        });
      }}
    />
  );
};

/** What the page must say before its tiles: a failed flow, staff's limits, Composio down, revokes to make. */
const Notices = ({
  connectionError,
  support,
  integrations,
  toRevoke,
  unlisted,
}: {
  connectionError: string | undefined;
  /** What core's callback named for support beside the failed flow. */
  support: Pick<
    IntegrationsSearch,
    "connectionReason" | "connectionRelease" | "connectionVersion"
  >;
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
        <Alert variant="destructive">
          <AlertTitle>{connectionErrorMessage(connectionError)}</AlertTitle>
          {identity.staff || isAdmin(identity.role) ? (
            <SupportDetails
              {...supportOf({
                reason: support.connectionReason,
                release: support.connectionRelease,
                version: support.connectionVersion,
              })}
            />
          ) : null}
        </Alert>
      )}
      {identity.staff ? (
        <Alert>
          <AlertTitle>{t`Grasp staff can't connect accounts or change what is offered here: that is for the organization's own people.`}</AlertTitle>
        </Alert>
      ) : null}
      {unlisted ? (
        <Alert variant="warning">
          <AlertTitle>{t`Composio's toolkits can't be listed right now. Try again shortly.`}</AlertTitle>
        </Alert>
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
    <Empty style={styles.nothingFound}>
      <EmptyHeader>
        <EmptyMedia illustration="search" />
        <EmptyTitle>{t`No apps match your search`}</EmptyTitle>
        <EmptyDescription>{t`Ask for the app you need, and an admin can add it.`}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button onClick={onRequest} variant="outline">
          <Icon icon={PlusIcon} />
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

/** The crumbs to the page: Integrations, then the kind of app it shows, if one. */
const crumbsOf = (integrations: string, kind: string | undefined) =>
  kind === undefined
    ? [{ label: integrations }]
    : [{ label: integrations, to: "/connectors" as const }, { label: kind }];

const Integrations = () => {
  const { catalog, connections, known, requests, toRevoke, uses } =
    Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  const {
    q,
    group,
    app,
    connectionError,
    connectionReason,
    connectionRelease,
    connectionVersion,
    connection,
  } = Route.useSearch();
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
  const opened = integrations.find((integration) => integration.key === app);
  const [requesting, setRequesting] = useState(false);
  // The tile an app was opened from, so its panel grows from it.
  const [from, setFrom] = useState<HTMLElement | null>(null);
  const navigate = useNavigate({ from: "/connectors/" });
  const onOpen: OpenApp = (key, tile) => {
    setFrom(tile);
    void navigate({
      resetScroll: false,
      search: (last) => ({ ...last, app: key }),
    });
  };
  // The overview itself: no kind chosen and nothing searched.
  const overview = group === undefined && q === undefined;
  const recommended = overview ? recommendedOf(integrations, known) : [];
  const kind = group === undefined ? undefined : i18n._(groupLabel[group]);
  const crumbs = crumbsOf(t`Connectors`, kind);
  // The apps and the connections are the page: without both, it failed as
  // a whole, and says so across the card; with one, it shows what it has
  // and says beside it what didn't load.
  if (catalog.state !== "ready" && connections.state !== "ready") {
    return <PageNotLoaded crumbs={crumbs} page={catalog} />;
  }
  const loaded = catalog.state === "ready" && connections.state === "ready";
  return (
    <>
      <RequestAppDialog
        integrations={integrations}
        onOpenChange={setRequesting}
        open={requesting}
      />
      <SiteHeader crumbs={crumbs} />
      <Page>
        <PageHeader
          actions={
            <div {...stylex.props(styles.actions)}>
              <Search q={q} />
              <AddConnector identity={identity} />
              <Button
                onClick={() => {
                  setRequesting(true);
                }}
                size="sm"
                variant="outline"
              >
                <Icon icon={PlusIcon} />
                {t`Request app`}
              </Button>
            </div>
          }
          title={kind ?? t`Connectors`}
        />
        <Returned connection={connection} integrations={integrations} />
        <Notices
          connectionError={connectionError}
          support={{ connectionReason, connectionRelease, connectionVersion }}
          integrations={integrations}
          toRevoke={toRevoke}
          unlisted={
            catalog.state === "ready" && catalog.data.composio === "unavailable"
          }
        />
        <PartNotLoaded page={catalog} />
        <PartNotLoaded page={connections} />
        <output {...stylex.props(visuallyHidden)}>
          {q === undefined
            ? ""
            : t`${plural(shown, { one: "# connector shown", other: "# connectors shown" })}`}
        </output>
        <div {...stylex.props(styles.lists)}>
          {overview ? (
            <IntegrationsBand identity={identity} integrations={integrations} />
          ) : null}
          <RecommendedApps
            identity={identity}
            onOpen={onOpen}
            open={app}
            recommended={recommended}
          />
          {group === undefined ? (
            <Await
              fallback={
                <Connected
                  onOpen={onOpen}
                  open={app}
                  sections={first}
                  uses={undefined}
                />
              }
              promise={uses}
            >
              {(read) => {
                const used = read.state === "ready" ? read.data : undefined;
                return (
                  <Connected
                    onOpen={onOpen}
                    open={app}
                    sections={sectionsOf(
                      integrations,
                      { show: "all" },
                      q,
                      used
                    )}
                    uses={used}
                  />
                );
              }}
            </Await>
          ) : null}
          <Others
            group={group}
            onOpen={onOpen}
            open={app}
            others={others}
            q={q}
            recommended={
              new Set(recommended.map(({ integration }) => integration.key))
            }
          />
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
        <IntegrationPanel
          from={from}
          identity={identity}
          integration={opened}
          key={opened.key}
          onClose={() => {
            void navigate({
              resetScroll: false,
              search: (last) => ({ ...last, app: undefined }),
            });
          }}
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

export const Route = createFileRoute("/_shell/connectors/")({
  validateSearch: (search: Record<string, unknown>): IntegrationsSearch => ({
    q: textOf(search.q),
    group: catalogGroups.find((each) => each === search.group),
    app: textOf(search.app),
    connectionError: textOf(search.connectionError),
    connectionReason: composioReasonSchema.safeParse(search.connectionReason)
      .data,
    connectionRelease: releaseNameSchema.safeParse(
      textOf(search.connectionRelease)
    ).data,
    connectionVersion: connectVersionSchema.safeParse(
      textOf(search.connectionVersion)
    ).data,
    connection: textOf(search.connection),
  }),
  // No `shouldReload`: the router reads the page again as it is entered,
  // when another admin may have connected, and not when only the search
  // changes (a kind, the open app), which narrows what was read. A change
  // reads it again (use-change.ts invalidates it).
  loader: async ({ context: { core, identity } }) => {
    const requests = loadFromCore(
      core,
      async (session) => await session.connections.appRequests()
    );
    // What Recommended's reasons are read from comes with the catalog, so
    // the kinds never lose an app under the reader's eyes; each read has
    // core's deadline, and one that fails only leaves its reasons out.
    // None for Grasp staff, who connect nothing here.
    const [integrations, known] = await Promise.all([
      loadIntegrations(core, identity, { held: false }),
      identity.staff ? nothingKnown : knownOf(core, identity, requests),
    ]);
    return {
      ...integrations,
      known,
      requests,
      // Admins' and Grasp staff's only, and never waited for either.
      toRevoke:
        identity.staff || isAdmin(identity.role)
          ? loadFromCore(
              core,
              async (session) => await session.connections.revocationsByHand()
            )
          : undefined,
    };
  },
  pendingComponent: IntegrationsSkeleton,
  component: Integrations,
});
