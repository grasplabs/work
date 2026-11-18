import type { CatalogTool } from "@grasp-os/shared/connect";
import { isAdmin } from "@grasp-os/shared/roles";
import type { Identity } from "@grasp-os/shared/rpc";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Await, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { connectionErrorMessage } from "../connection-errors.ts";
import { canConnect } from "../connections/connect-dialog.tsx";
import { ConnectedDialog } from "../connections/connected-dialog.tsx";
import {
  HttpConnections,
  httpConnectionsMatching,
} from "../connections/http-connections.tsx";
import { IntegrationInspector } from "../connections/integration-inspector.tsx";
import { loadIntegrations } from "../connections/integrations-data.ts";
import { integrationsOf, sectionsOf } from "../connections/integrations.ts";
import type { Integration } from "../connections/integrations.ts";
import {
  AddApps,
  ConnectedList,
  NeedsYou,
} from "../connections/overview-lists.tsx";
import { RequestAppDialog } from "../connections/request-app-dialog.tsx";
import { RequestedApps } from "../connections/requested-apps.tsx";
import { RevocationsByHand } from "../connections/revocations-by-hand.tsx";
import type { ConnectionUses } from "../connections/workflows-using.tsx";
import type { CoreConnection } from "../core-connection.ts";
import { PageLoading } from "../frame/page-states.tsx";
import { Page, PageHeading } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { Alert } from "../grasp/alert/index.ts";
import { Button } from "../grasp/button/index.ts";
import { Empty, EmptyHeader, EmptyDescription } from "../grasp/empty/index.ts";
import { visuallyHidden } from "../grasp/hidden/hidden.ts";
import { Plus, Search as SearchIcon } from "../grasp/icons/index.ts";
import {
  InputGroup,
  InputGroupClear,
  InputGroupInput,
  InputGroupText,
} from "../grasp/input-group/index.ts";
import { Sheet, SheetContent, SheetTitle } from "../grasp/sheet/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";

// Integrations: what Grasp can reach, a card per topic with its title on
// the canvas (Ruben's pick, 18 Nov 2026, connections/overview-lists.tsx):
// what needs someone to sign in again, what is connected, and every other
// app Grasp can connect to, with the search at that card's head. An app
// opens beside the lists, flush with the bar, the card's end and its foot
// (the route has the whole card, `page: "whole"`), in a Sheet where the
// page is narrow. Outside APIs an admin approved, the apps people asked
// for and what an admin still has to revoke by hand follow. Core's
// callback sends a flow that failed back here with
// `connectionError=<code>`, and one that worked with `connection=<id>`.

/** What the address holds. */
interface IntegrationsSearch {
  q?: string;
  /** The app open beside the list, by its key. */
  app?: string;
  connectionError?: string;
  /** A connection a flow just made, when core sent it back here. */
  connection?: string;
}

/**
 * How wide the page's own box must be for the app beside the list: the
 * panel, and room for two columns of apps.
 */
const WIDE = 60 * 16;

const styles = stylex.create({
  // The whole card: the lists keep the shell's own room and scroll on
  // their own; the open app stands beside them, flush with the bar, the
  // card's end and its foot, with one hairline toward the lists.
  whole: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    width: "100%",
    height: "100%",
    minHeight: 0,
  },
  open: {
    gridTemplateColumns: `minmax(0, 1fr) ${grasp.inspectorWidth}`,
  },
  pane: {
    minWidth: 0,
    minHeight: 0,
    overflowY: "auto",
    paddingBlockStart: grasp.space7,
    paddingBlockEnd: grasp.shellPageRoomBelow,
    paddingInline: grasp.shellPageInline,
  },
  side: {
    height: "100%",
    minHeight: 0,
    borderInlineStartWidth: grasp.hairline,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: grasp.line,
  },
  fill: { height: "100%" },
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
      <div {...stylex.props(styles.side)}>
        <IntegrationInspector
          framed={false}
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

/** What the page must say before its lists: a failed flow, staff's limits, Composio down, revokes to make. */
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

const Integrations = () => {
  const { catalog, connections, requests, toRevoke, uses } =
    Route.useLoaderData();
  const { identity, core } = Route.useRouteContext();
  const { q, app, connectionError, connection } = Route.useSearch();
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
  // Every app that can still be added, before the search narrows them:
  // their card, and the search at its head, stand while any is left.
  const addable = sectionsOf(integrations, { show: "all" }).others;
  return (
    <>
      <RequestAppDialog
        integrations={integrations}
        onOpenChange={setRequesting}
        open={requesting}
      />
      <SiteHeader crumbs={[{ label: t`Integrations` }]} />
      <div ref={box} {...stylex.props(styles.whole, beside && styles.open)}>
        <div {...stylex.props(styles.pane)}>
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
            <Notices
              connectionError={connectionError}
              integrations={integrations}
              toRevoke={toRevoke}
              unlisted={
                catalog.state === "ready" &&
                catalog.data.composio === "unavailable"
              }
            />
            <NotLoaded page={catalog} />
            <NotLoaded page={connections} />
            <output {...stylex.props(visuallyHidden)}>
              {q === undefined
                ? ""
                : t`${plural(shown, { one: "# integration shown", other: "# integrations shown" })}`}
            </output>
            <Await
              fallback={
                <>
                  <NeedsYou lapsed={first.lapsed} />
                  <ConnectedList
                    connected={[...first.connected, ...first.unused]}
                  />
                </>
              }
              promise={uses}
            >
              {(read) => {
                const known = read.state === "ready" ? read.data : undefined;
                const sections = sectionsOf(
                  integrations,
                  { show: "all" },
                  q,
                  known
                );
                return (
                  <>
                    <NeedsYou lapsed={sections.lapsed} />
                    <ConnectedList
                      connected={[...sections.connected, ...sections.unused]}
                    />
                  </>
                );
              }}
            </Await>
            {addable.length === 0 ? null : (
              <AddApps
                canConnect={(integration) => canConnect(integration, identity)}
                others={first.others}
                search={<Search q={q} />}
              />
            )}
            {loaded && shown === 0 ? (
              <Empty size="md">
                <EmptyHeader>
                  <EmptyDescription>{t`No integrations match your search.`}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : null}
            <HttpConnections
              connections={listed}
              identity={identity}
              search={q}
            />
            <RequestedApps requests={requests} search={q} />
          </Page>
        </div>
        {opened === undefined || !wide ? null : (
          <Details
            core={core}
            identity={identity}
            integration={opened}
            key={opened.key}
            uses={uses}
            wide
          />
        )}
      </div>
      {opened === undefined || wide ? null : (
        <Details
          core={core}
          identity={identity}
          integration={opened}
          key={opened.key}
          uses={uses}
          wide={false}
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
  // The whole card, so an open app stands flush beside the lists.
  staticData: { page: "whole" },
  validateSearch: (search: Record<string, unknown>): IntegrationsSearch => ({
    q: textOf(search.q),
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
