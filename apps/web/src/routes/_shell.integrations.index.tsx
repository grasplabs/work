import { catalogGroups } from "@grasp-os/shared/connect-names";
import type { CatalogGroup } from "@grasp-os/shared/connect-names";
import type { Identity } from "@grasp-os/shared/rpc";
import { Button } from "@grasp-os/ui/components/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@grasp-os/ui/components/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Await, createFileRoute, useNavigate } from "@tanstack/react-router";
import { PlusIcon, SearchIcon } from "lucide-react";
import { useState } from "react";

import { connectionErrorMessage } from "../connection-errors.ts";
import { ConnectedDialog } from "../connections/connected-dialog.tsx";
import { groupLabel } from "../connections/groups.ts";
import { IntegrationRow } from "../connections/integration-row.tsx";
import { IntegrationsBanner } from "../connections/integrations-banner.tsx";
import { loadIntegrations } from "../connections/integrations-data.ts";
import { IntegrationsSection } from "../connections/integrations-section.tsx";
import {
  countByGroup,
  integrationsOf,
  keeps,
  roundedDown,
  sectionsOf,
} from "../connections/integrations.ts";
import type {
  Integration,
  IntegrationFilter,
  IntegrationSections,
} from "../connections/integrations.ts";
import { RequestAppDialog } from "../connections/request-app-dialog.tsx";
import { RequestedApps } from "../connections/requested-apps.tsx";
import type { ConnectionUses } from "../connections/workflows-using.tsx";
import { ErrorText } from "../error-text.tsx";
import { formatNumber } from "../format.ts";
import { PageLoading } from "../frame/page-states.tsx";
import { PageHeading } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";

// Integrations, as in the prototype (`routes/integrations/index.tsx`): one
// column of lists by where each app stands. First what someone has to
// sign in to again (the prototype's first list, what is still to connect,
// Grasp can't tell: its workflows name connections), then what is
// connected and used, what is connected though no workflow uses it, and
// what was asked for; then the catalog's other apps, some 1,500 in all,
// drawn as they come near. One control filters them all, to what is
// connected or to one kind of app, and the search narrows them; both are
// in the address. Each app opens its own page, where it is connected and
// managed. Core's callback sends a flow that failed back here, with
// `connectionError=<code>`.

/** What the address holds: the search, the filter, and a failed flow's code. */
interface IntegrationsSearch {
  q?: string;
  show?: "connected";
  group?: CatalogGroup;
  connectionError?: string;
  /** A connection a flow just made, when core sent it back here. */
  connection?: string;
}

/**
 * How many of the catalog's apps are drawn at first, and with every step
 * further down: the list is some 1,500 long.
 */
const step = 80;

const filterOf = ({ show, group }: IntegrationsSearch): IntegrationFilter => {
  if (show !== undefined) {
    return { show };
  }
  return group === undefined ? { show: "all" } : { show: "group", group };
};

/** The search for `choice`, keeping what was searched for. */
const searchFor = (
  choice: IntegrationFilter,
  q: string | undefined
): IntegrationsSearch => {
  const kept = q === undefined ? {} : { q };
  if (choice.show === "group") {
    return { ...kept, group: choice.group };
  }
  return choice.show === "all" ? kept : { ...kept, show: choice.show };
};

const sameFilter = (one: IntegrationFilter, other: IntegrationFilter) =>
  one.show === other.show &&
  (one.show !== "group" ||
    (other.show === "group" && one.group === other.group));

interface Choice {
  id: string;
  filter: IntegrationFilter;
  label: string;
  count: number;
}

/** The search, in the address as it is typed. */
const Search = ({ q }: { q: string | undefined }) => {
  const { t } = useLingui();
  const navigate = useNavigate({ from: "/integrations/" });
  const [text, setText] = useState(q ?? "");
  // The search the address had when the box last followed it: a new one
  // from elsewhere (the filter, back) replaces what the box shows.
  const [followed, setFollowed] = useState(q);
  if (q !== followed) {
    setFollowed(q);
    if ((q ?? "") !== text.trim()) {
      setText(q ?? "");
    }
  }
  return (
    <InputGroup>
      <InputGroupInput
        aria-label={t`Search integrations`}
        onChange={(event) => {
          const typed = event.target.value;
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
      <InputGroupAddon>
        <SearchIcon />
      </InputGroupAddon>
    </InputGroup>
  );
};

/** The rows of one list. */
const Rows = ({
  integrations,
  identity,
  uses,
}: {
  integrations: readonly Integration[];
  identity: Identity;
  uses: ConnectionUses;
}) =>
  integrations.map((integration) => (
    <IntegrationRow
      identity={identity}
      integration={integration}
      key={integration.key}
      uses={uses}
    />
  ));

/**
 * The company's own apps, by where they stand: to sign in to again,
 * connected and used, and connected though no workflow uses them. Which
 * workflows use what comes on its own (`uses`); until it does, every
 * connected app is under Connected.
 */
const OwnSections = ({
  sections,
  identity,
  uses,
}: {
  sections: IntegrationSections;
  identity: Identity;
  uses: ConnectionUses;
}) => {
  const { t } = useLingui();
  return (
    <>
      <IntegrationsSection
        count={sections.lapsed.length}
        id="lapsed"
        title={t`Needs someone to sign in again`}
      >
        <Rows identity={identity} integrations={sections.lapsed} uses={uses} />
      </IntegrationsSection>
      <IntegrationsSection
        count={sections.connected.length}
        id="connected"
        title={t({
          message: "Connected",
          context: "apps that are connected and that workflows use",
        })}
      >
        <Rows
          identity={identity}
          integrations={sections.connected}
          uses={uses}
        />
      </IntegrationsSection>
      <IntegrationsSection
        count={sections.unused.length}
        id="unused"
        title={t`Connected, used by no workflow you can open`}
      >
        <Rows identity={identity} integrations={sections.unused} uses={uses} />
      </IntegrationsSection>
    </>
  );
};

/**
 * The catalog's other apps, some 1,500: only the first are drawn, and more
 * as the reader nears the end, so the page opens at once and their logos
 * are fetched as they come into view.
 */
const MoreApps = ({
  others,
  identity,
  uses,
}: {
  others: readonly Integration[];
  identity: Identity;
  uses: ConnectionUses;
}) => {
  const { t } = useLingui();
  const [drawn, setDrawn] = useState(step);
  // The end of what is drawn: once it is near the screen, well before it
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
      <IntegrationsSection
        about={t`Every other app Grasp can connect to.`}
        count={others.length}
        id="more"
        title={t({
          message: "More apps",
          context: "the catalog's apps nobody connected",
        })}
      >
        <Rows
          identity={identity}
          integrations={others.slice(0, drawn)}
          uses={uses}
        />
      </IntegrationsSection>
      {others.length > drawn ? (
        <span aria-hidden="true" className="h-px" key={drawn} ref={watch} />
      ) : null}
    </>
  );
};

/** The filters to choose from, each with how many apps it holds. */
const useChoices = (integrations: Integration[]): Choice[] => {
  const { t, i18n } = useLingui();
  const perGroup = countByGroup(integrations);
  return [
    {
      id: "all",
      filter: { show: "all" },
      label: t({ message: "All", context: "filter: every integration" }),
      count: integrations.length,
    },
    {
      id: "connected",
      filter: { show: "connected" },
      label: t({
        message: "Connected",
        context: "filter: the integrations that are connected",
      }),
      count: integrations.filter((integration) =>
        keeps({ show: "connected" }, integration)
      ).length,
    },
    ...catalogGroups.map((group) => ({
      id: `group:${group}`,
      filter: { show: "group" as const, group },
      label: i18n._(groupLabel[group]),
      count: perGroup.get(group) ?? 0,
    })),
  ];
};

const emptyTexts = {
  search: msg`No integrations match your search.`,
  connected: msg`Nothing connected yet.`,
  other: msg`Nothing here yet.`,
} as const;

/** Why nothing shows: a search or filter that matches nothing, or nothing connected yet. */
const emptyTextOf = (
  filter: IntegrationFilter,
  q: string | undefined
): MessageDescriptor => {
  if (q !== undefined) {
    return emptyTexts.search;
  }
  if (filter.show === "connected") {
    return emptyTexts.connected;
  }
  return emptyTexts.other;
};

/** A filter as the one control says it: its name and count. */
const labelOf = (choice: Choice): string =>
  `${choice.label} · ${formatNumber(choice.count)}`;

/** The filters, as one control: a row of them would be several screens wide. */
const FilterSelect = ({
  choices,
  filter,
  q,
}: {
  choices: Choice[];
  filter: IntegrationFilter;
  q: string | undefined;
}) => {
  const { t } = useLingui();
  const navigate = useNavigate({ from: "/integrations/" });
  const selected =
    choices.find((choice) => sameFilter(choice.filter, filter)) ?? choices[0];
  return (
    <Select
      items={choices.map((choice) => ({
        value: choice.id,
        label: labelOf(choice),
      }))}
      onValueChange={(value) => {
        const choice = choices.find(({ id }) => id === value);
        if (choice !== undefined) {
          void navigate({ search: searchFor(choice.filter, q) });
        }
      }}
      value={selected?.id}
    >
      <SelectTrigger aria-label={t`Filter integrations`} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {choices.map((choice) => (
            <SelectItem key={choice.id} value={choice.id}>
              {labelOf(choice)}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
};

/**
 * The success screen for the connection a flow just made, once core sent
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

const Integrations = () => {
  const { catalog, connections, uses, requests } = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  const search = Route.useSearch();
  const { q, connectionError, connection } = search;
  const { t, i18n } = useLingui();
  const integrations = integrationsOf(
    catalog.state === "ready" ? catalog.data.entries : [],
    connections.state === "ready" ? connections.data : []
  );
  const filter = filterOf(search);
  const choices = useChoices(integrations);
  // Before it is known which workflows use what: the sections as they
  // stand then, and the count of what shows, which doesn't change after.
  const first = sectionsOf(integrations, filter, q);
  const shown =
    first.lapsed.length +
    first.connected.length +
    first.unused.length +
    first.others.length;
  const loaded = catalog.state === "ready" && connections.state === "ready";
  const about = formatNumber(roundedDown(integrations.length));
  const [requesting, setRequesting] = useState(false);
  return (
    <>
      <RequestAppDialog
        integrations={integrations}
        onOpenChange={setRequesting}
        open={requesting}
      />
      <SiteHeader crumbs={[{ label: t`Integrations` }]} />
      <div className="min-h-0 flex-1 overflow-y-auto text-sm" data-scroller>
        {/* Columns follow the room this area has, not the window. */}
        <div className="pb-chat @container mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 pt-7 md:px-9">
          <PageHeading
            description={
              catalog.state === "ready" &&
              catalog.data.composio === "listed" ? (
                <Trans>
                  More than {about} apps your workflows can work in. Grasp only
                  does what you allow per app.
                </Trans>
              ) : (
                <Trans>
                  The apps your workflows can work in. Grasp only does what you
                  allow per app.
                </Trans>
              )
            }
            title={t`Integrations`}
          />
          <Returned connection={connection} integrations={integrations} />
          {connectionError === undefined ? null : (
            <ErrorText>{connectionErrorMessage(connectionError)}</ErrorText>
          )}
          {/* The band, and under it on the right the filter, the search and the way to ask for an app. */}
          <div className="flex flex-col gap-3">
            <IntegrationsBanner integrations={integrations} />
            {identity.staff ? (
              <p className="text-muted-foreground">
                <Trans>
                  Grasp staff can&apos;t connect accounts or change what is
                  offered here: that is for the organization&apos;s own people.
                </Trans>
              </p>
            ) : null}
            {catalog.state === "ready" &&
            catalog.data.composio === "unavailable" ? (
              <p className="text-muted-foreground">
                <Trans>
                  Composio&apos;s toolkits can&apos;t be listed right now. Try
                  again shortly.
                </Trans>
              </p>
            ) : null}
            <div className="flex flex-wrap items-center justify-end gap-2">
              <div className="w-full @md:w-48">
                <FilterSelect choices={choices} filter={filter} q={q} />
              </div>
              <div className="min-w-0 flex-1 @md:w-56 @md:flex-none">
                <Search q={q} />
              </div>
              <Button
                onClick={() => {
                  setRequesting(true);
                }}
                variant="outline"
              >
                <PlusIcon data-icon="inline-start" />
                <Trans>Request app</Trans>
              </Button>
            </div>
          </div>
          <NotLoaded page={catalog} />
          <NotLoaded page={connections} />
          <output className="sr-only">
            {q !== undefined || filter.show !== "all"
              ? t`${plural(shown, { one: "# integration shown", other: "# integrations shown" })}`
              : ""}
          </output>
          {loaded && shown === 0 ? (
            <p className="text-muted-foreground py-16 text-center">
              {i18n._(emptyTextOf(filter, q))}
            </p>
          ) : null}
          <Await
            fallback={
              <OwnSections identity={identity} sections={first} uses={uses} />
            }
            promise={uses}
          >
            {(read) => (
              <OwnSections
                identity={identity}
                sections={sectionsOf(
                  integrations,
                  filter,
                  q,
                  read.state === "ready" ? read.data : undefined
                )}
                uses={uses}
              />
            )}
          </Await>
          {/* The apps asked for have no kind, and none is connected. */}
          {filter.show === "all" ? (
            <RequestedApps requests={requests} search={q} />
          ) : null}
          {/* Mounted anew for another kind or another search, so it starts at its first apps again. */}
          <MoreApps
            identity={identity}
            key={`${JSON.stringify(filter)}·${q ?? ""}`}
            others={first.others}
            uses={uses}
          />
        </div>
      </div>
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
    show: search.show === "connected" ? search.show : undefined,
    group: catalogGroups.find((group) => group === search.group),
    connectionError: textOf(search.connectionError),
    connection: textOf(search.connection),
  }),
  // Read once: the filters and the search only narrow what was read, so a
  // new one keeps the page as it is rather than reading it again. A change
  // reads it again (use-change.ts invalidates it).
  shouldReload: false,
  loader: async ({ context: { core, identity } }) => ({
    ...(await loadIntegrations(core, identity, { held: false })),
    // Not awaited: the catalog never waits for the apps people asked for.
    requests: loadFromCore(
      core,
      async (session) => await session.connections.appRequests()
    ),
  }),
  pendingComponent: PageLoading,
  component: Integrations,
});
