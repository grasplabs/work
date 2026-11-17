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
import { useEffect, useRef, useState } from "react";

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
import {
  IntegrationsNerves,
  LINES,
} from "../connections/integrations-nerves.tsx";
import {
  integrationsOf,
  sectionsOf,
  stateOf,
} from "../connections/integrations.ts";
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
import { PageLoading } from "../frame/page-states.tsx";
import { Page, PageHeading } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { Alert } from "../grasp/alert/index.ts";
import { Button } from "../grasp/button/index.ts";
import { Empty } from "../grasp/empty/index.ts";
import { visuallyHidden } from "../grasp/hidden/hidden.ts";
import { ArrowLeft, Plus, Search as SearchIcon } from "../grasp/icons/index.ts";
import {
  InputGroup,
  InputGroupClear,
  InputGroupInput,
  InputGroupText,
} from "../grasp/input-group/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { SectionHeader } from "../grasp/section-header/index.ts";
import { Sheet, SheetContent, SheetTitle } from "../grasp/sheet/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";

// Integrations: what Grasp can reach, at a glance. First what is connected,
// on one card: a brain in dots with a nerve into it for every connected
// app (integrations-nerves.tsx), live, and under it a tile for each, with
// the app's own mark and one fact (to sign in to again, first, then how
// many workflows use it). Then every other app Grasp can connect to,
// grouped by kind, a few of each with the rest a press away, chosen by its
// mark; one search narrows both. An app opens beside the list, in the
// Inspector pattern (a Sheet on a phone), with what Grasp may do in it,
// who connected it and the workflows that use it; everything rarely
// changed stays on its own page. Outside APIs an admin approved, the apps
// people asked for and what an admin still has to revoke by hand follow.
// Core's callback sends a flow that failed back here with
// `connectionError=<code>`, and one that worked with `connection=<id>`.

/** What the address holds. */
interface IntegrationsSearch {
  q?: string;
  /** One kind of app, all of it, in place of a few of each. */
  group?: CatalogGroup;
  /** The app open beside the list, by its key. */
  app?: string;
  connectionError?: string;
  /** A connection a flow just made, when core sent it back here. */
  connection?: string;
}

/** How many of a kind's apps show before "Show all", where every kind shows. */
const perKind = 6;

/** How many apps are drawn at first, and with every step further down. */
const step = 80;

/**
 * How wide the page's own box must be for the app beside the list: the
 * panel, the gap, and room for two columns of tiles.
 */
const WIDE = 60 * 16;

const styles = stylex.create({
  // The lists, and the app beside them while one is open.
  split: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    columnGap: grasp.space6,
    alignItems: "start",
  },
  open: {
    gridTemplateColumns: `minmax(0, 1fr) ${grasp.inspectorWidth}`,
  },
  lists: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space6,
    minWidth: 0,
  },
  // The app stays in view beside the list, as tall as the window lets it
  // be, and scrolls inside.
  aside: {
    position: "sticky",
    insetBlockStart: grasp.space4,
    height: `calc(100dvh - 2 * ${grasp.space8})`,
    minHeight: 0,
  },
  fill: { height: "100%" },
  // The brain and its nerves: room for the drawing, which fills it.
  nerves: {
    position: "relative",
    height: "9rem",
    marginBlockEnd: grasp.space3,
  },
  kinds: { display: "flex", flexDirection: "column", gap: grasp.space6 },
  kind: { display: "flex", flexDirection: "column", gap: grasp.space2 },
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
    <InputGroup>
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
        placeholder={t`Search by name or kind`}
        type="search"
        value={text}
      />
      <InputGroupClear aria-label={t`Clear search`} />
    </InputGroup>
  );
};

/** Whether the page's own box is wide enough for the app beside the list; true until measured. */
const useWide = () => {
  const box = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const element = box.current;
    if (element === null || typeof ResizeObserver === "undefined") {
      return () => {
        // Nothing was watched.
      };
    }
    const watch = new ResizeObserver(([entry]) => {
      setWide((entry?.contentRect.width ?? 0) >= WIDE);
    });
    watch.observe(element);
    return () => {
      watch.disconnect();
    };
  }, []);
  return { box, wide };
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

/** What is connected, every app this person can see, its nerve and its tile. */
const Connected = ({
  sections,
  uses,
  open,
}: {
  sections: IntegrationSections;
  uses: readonly ConnectionWorkflows[] | undefined;
  open: string | undefined;
}) => {
  const { t } = useLingui();
  const navigate = useNavigate({ from: "/integrations/" });
  // To sign in to again first: the one thing here to act on.
  const shown = [...sections.lapsed, ...sections.connected, ...sections.unused];
  const lines = shown.slice(0, LINES).map((integration) => ({
    id: integration.key,
    attention: stateOf(integration) === "needs_reauth",
  }));
  const title = t({
    message: "Connected",
    context: "apps that are connected",
  });
  return (
    <SectionCard
      aside={
        shown.length === 0 ? undefined : (
          <Text element="span" size="sm" tone="muted">
            {formatNumber(shown.length)}
          </Text>
        )
      }
      density="compact"
      title={title}
    >
      <div {...stylex.props(styles.nerves)}>
        <IntegrationsNerves
          lines={lines}
          onHold={() => {
            // The app's tile says its name: nothing to show over the drawing.
          }}
          onOpen={(id) => {
            void navigate({
              resetScroll: false,
              search: (last) => ({ ...last, app: id }),
            });
          }}
        />
      </div>
      {shown.length === 0 ? (
        <Empty size="inline">{t`Nothing connected yet. Choose an app below to connect it.`}</Empty>
      ) : (
        <TileGrid label={title}>
          {shown.map((integration) => (
            <IntegrationTile
              integration={integration}
              key={integration.key}
              open={integration.key === open}
              uses={uses}
            />
          ))}
        </TileGrid>
      )}
    </SectionCard>
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
  const { t, i18n } = useLingui();
  return (
    <div {...stylex.props(styles.kinds)}>
      {catalogGroups.map((group) => {
        const ofKind = others.filter(
          (integration) => integration.group === group
        );
        if (ofKind.length === 0) {
          return null;
        }
        const label = i18n._(groupLabel[group]);
        const count = ofKind.length;
        return (
          <section key={group} {...stylex.props(styles.kind)}>
            <SectionHeader
              aside={
                <Text element="span" size="sm" tone="muted">
                  {formatNumber(count)}
                </Text>
              }
              headingLevel={3}
              size="sm"
              title={label}
            />
            <TileGrid label={label}>
              {ofKind.slice(0, perKind).map((integration) => (
                <IntegrationTile
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
                    search={(last) => ({ ...last, group })}
                    to="/integrations"
                  />
                }
                size="sm"
                variant="ghost"
              >
                {t`${plural(count, { one: `Show the # app in ${label}`, other: `Show all # in ${label}` })}`}
              </Button>
            ) : null}
          </section>
        );
      })}
    </div>
  );
};

/**
 * Every other app Grasp can connect to: every kind, a few of each; one
 * kind whole; or, while someone searches, what the search finds.
 */
const AddMore = ({
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
  const ofKind =
    group === undefined
      ? others
      : others.filter((integration) => integration.group === group);
  const title =
    group === undefined
      ? t({ message: "Add more", context: "apps that can still be connected" })
      : i18n._(groupLabel[group]);
  if (others.length === 0) {
    return null;
  }
  return (
    <SectionCard
      actions={
        group === undefined ? undefined : (
          <Button
            icon={ArrowLeft}
            render={
              <Link
                search={(last) => ({ ...last, group: undefined })}
                to="/integrations"
              />
            }
            size="sm"
            variant="ghost"
          >
            {t`Every kind`}
          </Button>
        )
      }
      aside={
        <Text element="span" size="sm" tone="muted">
          {formatNumber(ofKind.length)}
        </Text>
      }
      density="compact"
      title={title}
    >
      {/* Mounted anew for another search or kind, so it starts at its first apps again. */}
      {q === undefined && group === undefined ? (
        <Kinds open={open} others={others} />
      ) : (
        <Drawn
          integrations={ofKind}
          key={`${group ?? ""}·${q ?? ""}`}
          label={title}
          open={open}
        />
      )}
    </SectionCard>
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

/** The open app: beside the list, or in a Sheet where the page is narrow. */
const Details = ({
  integration,
  identity,
  uses,
  core,
  wide,
}: {
  integration: Integration;
  identity: Identity;
  uses: ConnectionUses;
  core: CoreConnection;
  wide: boolean;
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
  if (wide) {
    return (
      <div {...stylex.props(styles.aside)}>
        <IntegrationInspector
          framed
          identity={identity}
          integration={integration}
          layout={styles.fill}
          onClose={close}
          tools={tools}
          uses={uses}
        />
      </div>
    );
  }
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

const Integrations = () => {
  const { catalog, connections, requests, toRevoke, uses } =
    Route.useLoaderData();
  const { identity, core } = Route.useRouteContext();
  const { q, group, app, connectionError, connection } = Route.useSearch();
  const { t } = useLingui();
  const { box, wide } = useWide();
  const listed = connections.state === "ready" ? connections.data : undefined;
  const integrations = integrationsOf(
    catalog.state === "ready" ? catalog.data.entries : [],
    listed ?? []
  );
  // Before it is known which workflows use what: the sections as they
  // stand then; the count of what shows doesn't change after.
  const first = sectionsOf(integrations, { show: "all" }, q);
  const httpShown = httpConnectionsMatching(listed ?? [], q).length;
  const shown =
    first.lapsed.length +
    first.connected.length +
    first.unused.length +
    first.others.length +
    httpShown;
  const loaded = catalog.state === "ready" && connections.state === "ready";
  const opened = integrations.find((integration) => integration.key === app);
  const beside = opened !== undefined && wide;
  const [requesting, setRequesting] = useState(false);
  return (
    <>
      <RequestAppDialog
        integrations={integrations}
        onOpenChange={setRequesting}
        open={requesting}
      />
      <SiteHeader crumbs={[{ label: t`Integrations` }]} />
      <Page>
        <PageHeading
          action={
            <Button
              icon={Plus}
              onClick={() => {
                setRequesting(true);
              }}
              variant="quiet"
            >
              {t`Request app`}
            </Button>
          }
          title={t`Integrations`}
        />
        <Returned connection={connection} integrations={integrations} />
        {connectionError === undefined ? null : (
          <Alert
            title={connectionErrorMessage(connectionError)}
            variant="danger"
          />
        )}
        {identity.staff ? (
          <Alert
            title={t`Grasp staff can't connect accounts or change what is offered here: that is for the organization's own people.`}
          />
        ) : null}
        {catalog.state === "ready" &&
        catalog.data.composio === "unavailable" ? (
          <Alert
            title={t`Composio's toolkits can't be listed right now. Try again shortly.`}
            variant="attention"
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
        <NotLoaded page={catalog} />
        <NotLoaded page={connections} />
        <div ref={box} {...stylex.props(styles.split, beside && styles.open)}>
          <div {...stylex.props(styles.lists)}>
            <Search q={q} />
            <output {...stylex.props(visuallyHidden)}>
              {q === undefined
                ? ""
                : t`${plural(shown, { one: "# integration shown", other: "# integrations shown" })}`}
            </output>
            {loaded && shown === 0 ? (
              <Empty size="section">{t`No integrations match your search.`}</Empty>
            ) : null}
            {q !== undefined && shown === 0 ? null : (
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
            )}
            <AddMore group={group} open={app} others={first.others} q={q} />
            <HttpConnections
              connections={listed}
              identity={identity}
              search={q}
            />
            <RequestedApps requests={requests} search={q} />
          </div>
          {opened === undefined ? null : (
            <Details
              core={core}
              identity={identity}
              integration={opened}
              key={opened.key}
              uses={uses}
              wide={wide}
            />
          )}
        </div>
      </Page>
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
    group: catalogGroups.find((group) => group === search.group),
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
  pendingComponent: PageLoading,
  component: Integrations,
});
