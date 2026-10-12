import { catalogGroups } from "@grasp-os/shared/connect";
import type { CatalogGroup } from "@grasp-os/shared/connect";
import type { Identity } from "@grasp-os/shared/rpc";
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
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { CircleCheckIcon, LayoutGridIcon, SearchIcon } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";

import { connectionErrorMessage } from "../connection-errors.ts";
import { groupIcon, groupLabel } from "../connections/groups.ts";
import { IntegrationRow } from "../connections/integration-row.tsx";
import { IntegrationsBanner } from "../connections/integrations-banner.tsx";
import { loadIntegrations } from "../connections/integrations-data.ts";
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
  IntegrationSection,
} from "../connections/integrations.ts";
import { ErrorText } from "../error-text.tsx";
import {
  PageSidebar,
  PageSidebarBody,
  PageSidebarTop,
  RailButton,
  RailDivider,
  RailExpand,
  usePageSidebarFold,
} from "../frame/page-sidebar.tsx";
import { PageLoading } from "../frame/page-states.tsx";
import { PageHeading } from "../frame/page.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { formatNumber } from "../format.ts";
import { NotLoaded } from "../load-from-core.tsx";

// Integrations, as in the prototype (`routes/integrations/index.tsx`):
// every app Grasp can work in. The page sidebar filters: everything, what
// is connected, or one kind of app; it folds to a rail of their icons. Under
// the banner, each kind of app is a section, its connected apps first and
// then the catalog's others, some 1,500 in all, drawn as they come near.
// The filter and the search are in the address. Each app opens its own
// page, where it is connected and managed. Core's callback sends a flow
// that failed back here (through `/connections`), with
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
  icon: LucideIcon;
  count: number;
}

/** A filter in the open sidebar or the narrow row: its icon, name and count. */
const FilterItem = ({
  choice,
  selected,
  q,
}: {
  choice: Choice;
  selected: boolean;
  q: string | undefined;
}) => {
  const { icon: Icon } = choice;
  return (
    <Link
      aria-current={selected ? "page" : undefined}
      className="text-muted-foreground hover:bg-muted/60 hover:text-foreground aria-[current=page]:bg-muted aria-[current=page]:text-foreground flex h-8 flex-none items-center gap-2 rounded-md px-2 text-left transition-colors"
      search={searchFor(choice.filter, q)}
      to="/integrations"
    >
      <Icon aria-hidden="true" className="size-4 flex-none" />
      <span className="min-w-0 flex-1 truncate">{choice.label}</span>
      <span className="text-muted-foreground text-xs tabular-nums">
        {formatNumber(choice.count)}
      </span>
    </Link>
  );
};

/** A filter in the folded rail: its icon, its name and count in the tooltip. */
const RailChoice = ({
  choice,
  selected,
  q,
}: {
  choice: Choice;
  selected: boolean;
  q: string | undefined;
}) => {
  const { t } = useLingui();
  const { icon: Icon, label } = choice;
  const count = formatNumber(choice.count);
  return (
    <RailButton
      active={selected}
      label={t`${label} · ${count}`}
      render={<Link search={searchFor(choice.filter, q)} to="/integrations" />}
    >
      <Icon />
    </RailButton>
  );
};

/** The filters: open, under a heading, with the kinds of app; folded, a rail of their icons. */
const Filters = ({
  choices,
  filter,
  q,
}: {
  choices: Choice[];
  filter: IntegrationFilter;
  q: string | undefined;
}) => {
  const { t } = useLingui();
  const [folded, setFolded] = usePageSidebarFold("integrations");
  const fixed = choices.slice(0, 2);
  const categories = choices.slice(2);
  if (folded) {
    return (
      <PageSidebar folded label={t`Filter integrations`}>
        <RailExpand
          label={t`Expand the filters`}
          onExpand={() => {
            setFolded(false);
          }}
        />
        <RailDivider />
        {fixed.map((choice) => (
          <RailChoice
            choice={choice}
            key={choice.id}
            q={q}
            selected={sameFilter(choice.filter, filter)}
          />
        ))}
        <RailDivider />
        {categories.map((choice) => (
          <RailChoice
            choice={choice}
            key={choice.id}
            q={q}
            selected={sameFilter(choice.filter, filter)}
          />
        ))}
      </PageSidebar>
    );
  }
  return (
    <PageSidebar folded={false} label={t`Filter integrations`}>
      <PageSidebarTop
        fold={{
          label: t`Fold the filters`,
          onFold: () => {
            setFolded(true);
          },
        }}
        joined
      >
        <h2 className="truncate px-2 font-medium">
          <Trans context="heading of the column that filters the integrations">
            Filters
          </Trans>
        </h2>
      </PageSidebarTop>
      <PageSidebarBody joined>
        {fixed.map((choice) => (
          <FilterItem
            choice={choice}
            key={choice.id}
            q={q}
            selected={sameFilter(choice.filter, filter)}
          />
        ))}
        <span aria-hidden="true" className="bg-border my-2 h-px" />
        <span className="text-muted-foreground px-2 pb-1 text-xs">
          <Trans>Categories</Trans>
        </span>
        {categories.map((choice) => (
          <FilterItem
            choice={choice}
            key={choice.id}
            q={q}
            selected={sameFilter(choice.filter, filter)}
          />
        ))}
      </PageSidebarBody>
    </PageSidebar>
  );
};

/** The search, in the address as it is typed. */
const Search = ({ q }: { q: string | undefined }) => {
  const { t } = useLingui();
  const navigate = useNavigate({ from: "/integrations/" });
  const [text, setText] = useState(q ?? "");
  // The search the address had when the box last followed it: a new one
  // from elsewhere (the sidebar's link, back) replaces what the box shows.
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

/**
 * The sections as far as `most` of the catalog's other apps go: each gets
 * what is left of them, and one that would start with none waits.
 */
const upTo = (
  sections: readonly IntegrationSection[],
  most: number
): (IntegrationSection & { count: number })[] => {
  const shown: (IntegrationSection & { count: number })[] = [];
  let left = most;
  for (const section of sections) {
    const others = section.others.slice(0, left);
    if (section.own.length > 0 || others.length > 0) {
      left -= others.length;
      shown.push({
        ...section,
        others,
        count: section.own.length + section.others.length,
      });
    }
  }
  return shown;
};

/**
 * Every section, one after the other: its kind, how many apps it has, and
 * its apps in two columns, the connected ones first. Of the catalog's some
 * 1,500 only the first are drawn; more come as the reader nears the end,
 * so the page opens at once and its logos are fetched as they come into
 * view.
 */
const Kinds = ({
  sections,
  identity,
}: {
  sections: readonly IntegrationSection[];
  identity: Identity;
}) => {
  const { i18n } = useLingui();
  const [drawn, setDrawn] = useState(step);
  const total = sections.reduce(
    (sum, section) => sum + section.others.length,
    0
  );
  // The end of what is drawn: once it is near the screen, well before it
  // shows, more is drawn. It is a new mark after every step, so it is
  // looked at again. Measured against the part of the page that scrolls,
  // which is not the window.
  const watch = (mark: HTMLSpanElement | null) => {
    if (mark === null) {
      return;
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
      {upTo(sections, drawn).map((section) => (
        <section
          aria-labelledby={`integrations-${section.group}`}
          className="flex flex-col gap-2"
          key={section.group}
        >
          <h2
            className="text-muted-foreground flex items-baseline gap-2"
            id={`integrations-${section.group}`}
          >
            {i18n._(groupLabel[section.group])}
            {section.count > 6 ? (
              <span className="text-xs tabular-nums">
                {formatNumber(section.count)}
              </span>
            ) : null}
          </h2>
          <ul className="grid grid-cols-1 gap-x-10 gap-y-1 @2xl:grid-cols-2">
            {[...section.own, ...section.others].map((integration) => (
              <IntegrationRow
                identity={identity}
                integration={integration}
                key={integration.key}
              />
            ))}
          </ul>
        </section>
      ))}
      {total > drawn ? (
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
      icon: LayoutGridIcon,
      count: integrations.length,
    },
    {
      id: "connected",
      filter: { show: "connected" },
      label: t({
        message: "Connected",
        context: "filter: the integrations that are connected",
      }),
      icon: CircleCheckIcon,
      count: integrations.filter((integration) =>
        keeps({ show: "connected" }, integration)
      ).length,
    },
    ...catalogGroups.map((group) => ({
      id: `group:${group}`,
      filter: { show: "group" as const, group },
      label: i18n._(groupLabel[group]),
      icon: groupIcon[group],
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

/** Without room for the filter column, the filters are one control: a row of them would be several screens wide. */
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
  const labelOf = (choice: Choice): string =>
    `${choice.label} · ${formatNumber(choice.count)}`;
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

const Integrations = () => {
  const { catalog, connections } = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  const search = Route.useSearch();
  const { q, connectionError, connection } = search;
  const { t, i18n } = useLingui();
  const integrations = integrationsOf(
    catalog.state === "ready" ? catalog.data.entries : [],
    connections.state === "ready" ? connections.data : []
  );
  const filter = filterOf(search);
  // Only a connection the page lists: anyone can put an ID in a link.
  const connected =
    connection !== undefined &&
    connections.state === "ready" &&
    connections.data.some(({ id }) => id === connection);
  const choices = useChoices(integrations);
  const sections = sectionsOf(integrations, filter, q);
  const shown = sections.reduce(
    (sum, section) => sum + section.own.length + section.others.length,
    0
  );
  const loaded = catalog.state === "ready" && connections.state === "ready";
  const about = formatNumber(roundedDown(integrations.length));
  return (
    <>
      <SiteHeader crumbs={[{ label: t`Integrations` }]} />
      <div className="flex min-h-0 flex-1 text-sm">
        <Filters choices={choices} filter={filter} q={q} />
        <div className="min-w-0 flex-1 overflow-y-auto" data-scroller>
          {/* Columns follow the room this area has, not the window: the sidebars take a lot of it. */}
          <div className="@container pb-chat mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 pt-7 md:px-9">
            <PageHeading
              description={
                catalog.state === "ready" &&
                catalog.data.composio === "listed" ? (
                  <Trans>
                    More than {about} apps your workflows can work in. Grasp
                    only does what you allow per app.
                  </Trans>
                ) : (
                  <Trans>
                    The apps your workflows can work in. Grasp only does what
                    you allow per app.
                  </Trans>
                )
              }
              title={t`Integrations`}
            />
            {connected ? (
              <output>
                <Trans>Connected.</Trans>
              </output>
            ) : null}
            {connectionError === undefined ? null : (
              <ErrorText>{connectionErrorMessage(connectionError)}</ErrorText>
            )}
            {/* The band, and under it on the right the search. */}
            <div className="flex flex-col gap-3">
              <IntegrationsBanner integrations={integrations} />
              {identity.staff ? (
                <p className="text-muted-foreground">
                  <Trans>
                    Grasp staff can&apos;t connect accounts or change what is
                    offered here: that is for the organization&apos;s own
                    people.
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
              <div className="flex items-center justify-end gap-2">
                <div className="w-40 @md:w-56">
                  <Search q={q} />
                </div>
              </div>
            </div>
            <div className="md:hidden">
              <FilterSelect choices={choices} filter={filter} q={q} />
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
            {/* Mounted anew for another kind or another search, so it starts at its first apps again. */}
            <Kinds
              identity={identity}
              key={`${JSON.stringify(filter)}·${q ?? ""}`}
              sections={sections}
            />
          </div>
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
  loader: async ({ context: { core, identity } }) =>
    await loadIntegrations(core, identity, { held: false }),
  pendingComponent: PageLoading,
  component: Integrations,
});
