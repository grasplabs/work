import type { Identity } from "@grasp-os/shared/rpc";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@grasp-os/ui/components/input-group";
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  LayoutGridIcon,
  SearchIcon,
  TagIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";

import { connectionErrorMessage } from "../connection-errors.ts";
import { IntegrationRow } from "../connections/integration-row.tsx";
import { loadIntegrations } from "../connections/integrations-data.ts";
import {
  categoriesOf,
  integrationsOf,
  keeps,
  matches,
  stateOf,
} from "../connections/integrations.ts";
import type {
  Integration,
  IntegrationFilter,
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
import { SiteHeader } from "../frame/site-header.tsx";
import { NotLoaded } from "../load-from-core.tsx";

// Integrations, as in the prototype (`routes/integrations/index.tsx`):
// every app Grasp can work in, the connected ones first, filtered in the
// page sidebar (everything, what is connected, what needs attention, or
// one of the catalog's categories) and by a search, both in the address.
// Each app opens its own page, where it is connected and managed. Core's
// callback sends a flow that failed back here (through `/connections`),
// with `connectionError=<code>`.

/** What the address holds: the search, the filter, and a failed flow's code. */
interface IntegrationsSearch {
  q?: string;
  show?: "connected" | "attention";
  category?: string;
  connectionError?: string;
  /** A connection a flow just made, when core sent it back here. */
  connection?: string;
}

/**
 * Most apps shown at once, besides those connected: Composio lists
 * thousands of toolkits, so the rest wait for a narrower search.
 */
const shownMax = 50;

const filterOf = ({
  show,
  category,
}: IntegrationsSearch): IntegrationFilter => {
  if (show !== undefined) {
    return { show };
  }
  return category === undefined
    ? { show: "all" }
    : { show: "category", category };
};

/** The search for `choice`, keeping what was searched for. */
const searchFor = (
  choice: IntegrationFilter,
  q: string | undefined
): IntegrationsSearch => {
  const kept = q === undefined ? {} : { q };
  if (choice.show === "category") {
    return { ...kept, category: choice.category };
  }
  return choice.show === "all" ? kept : { ...kept, show: choice.show };
};

const sameFilter = (one: IntegrationFilter, other: IntegrationFilter) =>
  one.show === other.show &&
  (one.show !== "category" ||
    (other.show === "category" && one.category === other.category));

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
        {choice.count}
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
  const { icon: Icon, label, count } = choice;
  return (
    <RailButton
      active={selected}
      label={t`${label}: ${count}`}
      render={<Link search={searchFor(choice.filter, q)} to="/integrations" />}
    >
      <Icon />
    </RailButton>
  );
};

/** The filters: open, under a heading, with the catalog's categories; folded, a rail of the first three. */
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
  const fixed = choices.slice(0, 3);
  const categories = choices.slice(3);
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
        {categories.length === 0 ? null : <RailDivider />}
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
        {categories.length === 0 ? null : (
          <>
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
          </>
        )}
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
    <InputGroup className="w-40 @md:w-56">
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

const sectionTitles = {
  connected: msg`Connected`,
  available: msg`Available`,
} as const;

/** The apps that match, connected first, each group a section of rows in two columns where there is room. */
const Sections = ({
  shown,
  identity,
}: {
  shown: Integration[];
  identity: Identity;
}) => {
  const { i18n } = useLingui();
  const sections = [
    {
      id: "connected" as const,
      items: shown.filter(
        (integration) => stateOf(integration) !== "not_connected"
      ),
    },
    {
      id: "available" as const,
      items: shown.filter(
        (integration) => stateOf(integration) === "not_connected"
      ),
    },
  ].filter(({ items }) => items.length > 0);
  return sections.map((section) => (
    <section
      aria-labelledby={`integrations-${section.id}`}
      className="flex flex-col gap-1"
      key={section.id}
    >
      <h2 className="text-muted-foreground" id={`integrations-${section.id}`}>
        {i18n._(sectionTitles[section.id])}
      </h2>
      <ul className="grid grid-cols-1 gap-x-10 @2xl:grid-cols-2">
        {section.items.map((integration) => (
          <IntegrationRow
            identity={identity}
            integration={integration}
            key={integration.key}
          />
        ))}
      </ul>
    </section>
  ));
};

/** The filters to choose from, each with how many apps it holds. */
const useChoices = (integrations: Integration[]): Choice[] => {
  const { t, i18n } = useLingui();
  const count = (filter: IntegrationFilter): number =>
    integrations.filter((integration) => keeps(filter, integration)).length;
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
      count: count({ show: "connected" }),
    },
    {
      id: "attention",
      filter: { show: "attention" },
      label: t`Needs attention`,
      icon: CircleAlertIcon,
      count: count({ show: "attention" }),
    },
    // The catalog's own categories, as it names them: none made up here.
    ...categoriesOf(integrations, i18n.locale).map(
      ({ category, count: n }) => ({
        id: `category:${category}`,
        filter: { show: "category" as const, category },
        label: category,
        icon: TagIcon,
        count: n,
      })
    ),
  ];
};

const emptyTexts = {
  search: msg`No integrations match your search.`,
  connected: msg`Nothing connected yet.`,
  attention: msg`Nothing needs attention.`,
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
  if (filter.show === "connected" || filter.show === "attention") {
    return emptyTexts[filter.show];
  }
  return emptyTexts.other;
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
  // A category the catalog doesn't have (an old link) shows everything.
  const asked = filterOf(search);
  const filter: IntegrationFilter =
    asked.show === "category" &&
    !integrations.some(({ categories }) => categories.includes(asked.category))
      ? { show: "all" }
      : asked;
  // Only a connection the page lists: anyone can put an ID in a link.
  const connected =
    connection !== undefined &&
    connections.state === "ready" &&
    connections.data.some(({ id }) => id === connection);
  const choices = useChoices(integrations);
  const matching = integrations.filter(
    (integration) =>
      keeps(filter, integration) && (q === undefined || matches(integration, q))
  );
  // Every connected one, then as many of the others as fit: a cap in
  // catalog order could push someone's own account off the list.
  const connectedOnes = matching.filter(
    (integration) => stateOf(integration) !== "not_connected"
  );
  const shown = [
    ...connectedOnes,
    ...matching
      .filter((integration) => stateOf(integration) === "not_connected")
      .slice(0, Math.max(0, shownMax - connectedOnes.length)),
  ];
  const count = shown.length;
  const total = matching.length;
  const loaded = catalog.state === "ready" && connections.state === "ready";
  return (
    <>
      <SiteHeader crumbs={[{ label: t`Integrations` }]} />
      <div className="flex min-h-0 flex-1 text-sm">
        <Filters choices={choices} filter={filter} q={q} />
        <div className="min-w-0 flex-1 overflow-y-auto">
          {/* Columns follow the room this area has, not the window: the sidebars take a lot of it. */}
          <div className="@container mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-7 md:px-9">
            <div className="flex flex-col gap-1">
              <h1 className="text-2xl font-medium tracking-tight">
                <Trans>Integrations</Trans>
              </h1>
              <p className="text-muted-foreground">
                <Trans>
                  The apps your workflows can work in. Grasp only does what you
                  allow per app.
                </Trans>
              </p>
            </div>
            {connected ? (
              <output>
                <Trans>Connected.</Trans>
              </output>
            ) : null}
            {connectionError === undefined ? null : (
              <ErrorText>{connectionErrorMessage(connectionError)}</ErrorText>
            )}
            <div className="flex flex-col gap-3">
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
                <Search q={q} />
              </div>
            </div>
            {/* Without room for the filter column, it becomes a row. */}
            <div className="-mx-1 flex gap-1 overflow-x-auto md:hidden">
              {choices.map((choice) => (
                <FilterItem
                  choice={choice}
                  key={choice.id}
                  q={q}
                  selected={sameFilter(choice.filter, filter)}
                />
              ))}
            </div>
            <NotLoaded page={catalog} />
            <NotLoaded page={connections} />
            <output className="sr-only">
              {q !== undefined || filter.show !== "all"
                ? t`${plural(total, { one: "# integration shown", other: "# integrations shown" })}`
                : ""}
            </output>
            {total > count ? (
              <p className="text-muted-foreground">
                {t`Showing the first ${count} of ${total}. Refine your search to find others.`}
              </p>
            ) : null}
            {loaded && count === 0 ? (
              <p className="text-muted-foreground py-16 text-center">
                {i18n._(emptyTextOf(filter, q))}
              </p>
            ) : null}
            <Sections identity={identity} shown={shown} />
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
    show:
      search.show === "connected" || search.show === "attention"
        ? search.show
        : undefined,
    category: textOf(search.category),
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
