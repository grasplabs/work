import type { ListedConnection } from "@grasp-os/shared/connect";
import { catalogGroups } from "@grasp-os/shared/connect-names";
import type { ConnectionWorkflows } from "@grasp-os/shared/workflows";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useNavigate } from "@tanstack/react-router";

import { formatDayMonth, formatNumber } from "../format.ts";
import { Avatar, AvatarFallback } from "../grasp/avatar/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import type { BadgeTone } from "../grasp/badge/index.ts";
import { BrandIcon } from "../grasp/brand-icon/index.ts";
import { Button } from "../grasp/button/index.ts";
import { Card } from "../grasp/card/index.ts";
import { DataTable } from "../grasp/data-table/index.ts";
import { Empty } from "../grasp/empty/index.ts";
import { Plus, Search as SearchIcon } from "../grasp/icons/index.ts";
import {
  InputGroup,
  InputGroupClear,
  InputGroupInput,
  InputGroupText,
} from "../grasp/input-group/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { PageHeader } from "../grasp/page-header/index.ts";
import { PanelTexture } from "../grasp/panel/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "../grasp/select/index.ts";
import { StatsGrid } from "../grasp/stats/index.ts";
import { TabsLink, TabsNav } from "../grasp/tabs/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { ToolbarBand } from "../grasp/toolbar-band/index.ts";
import { groupLabel } from "./groups.ts";
import { httpConnectionsMatching } from "./http-connections.tsx";
import { find, stateOf, workflowsOf } from "./integrations.ts";
import type { Integration } from "./integrations.ts";
import { brandOf } from "./provider-mark.tsx";

// CONCEPT BRANCH ONLY, never merged: three shapes for the Integrations
// overview, for Ruben to choose between (`?concept=a|b|c`). Each opens an
// app in the shell's panel (frame/page-panel.tsx) through `?app=`.
//   a: a table of what is connected, grouped by what needs someone, with a
//      second tab for every app Grasp can connect (Oneleet's shape).
//   b: a catalogue of cards, filtered by a segmented switch, each card an
//      app with its mark, kind, sentence and its one action at its foot.
//   c: settings-like, a card per topic with its title on the canvas:
//      what needs you, what is connected, what can be added.

export type OverviewConcept = "a" | "b" | "c";

export interface OverviewProps {
  integrations: readonly Integration[];
  uses: readonly ConnectionWorkflows[] | undefined;
  connections: readonly ListedConnection[];
  q: string | undefined;
  /** Which of `a`'s tabs, or `b`'s filter. */
  view: string | undefined;
  onRequest: () => void;
}

const styles = stylex.create({
  page: { display: "grid", rowGap: grasp.space6, minWidth: 0 },
  name: { display: "flex", alignItems: "center", gap: grasp.space3 },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 20rem), 1fr))",
    gap: grasp.space3,
    margin: 0,
    padding: 0,
  },
  search: { flexGrow: 1, maxWidth: "24rem" },
  // The strip's own box, so the texture fills it: positioned, clipped.
  strip: {
    position: "relative",
    overflow: "hidden",
    paddingInline: grasp.space3,
    paddingBlock: grasp.space3,
  },
  chips: {
    position: "relative",
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 20rem), 1fr))",
    gap: grasp.space1,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  cell: { minWidth: 0, listStyle: "none" },
  kind: { width: "auto", minWidth: "12rem" },
});

/** Opens an app in the shell's panel. */
const useOpen = () => {
  const navigate = useNavigate({ from: "/integrations/" });
  return (key: string) => {
    void navigate({
      resetScroll: false,
      search: (last) => ({ ...last, app: key }),
    });
  };
};

/** Who an app's connections serve, in a few words. */
const useWhose = () => {
  const { t } = useLingui();
  return (integration: Integration): string => {
    const state = stateOf(integration);
    if (integration.connections.some(({ scope }) => scope === "shared")) {
      return t`Whole company`;
    }
    return state === "not_connected" ? "" : t`Only you`;
  };
};

/** How many workflows use it, once that is read. */
const useUsedBy = () => {
  const { t } = useLingui();
  return (
    integration: Integration,
    uses: readonly ConnectionWorkflows[] | undefined
  ): string => {
    if (uses === undefined) {
      return "";
    }
    const count = workflowsOf(integration, uses).length;
    return count === 0
      ? ""
      : t`${plural(count, { one: "# workflow", other: "# workflows" })}`;
  };
};

/** Where it stands, as a Badge's words and tone. */
const useStatus = () => {
  const { t } = useLingui();
  return (integration: Integration): { words: string; tone: BadgeTone } => {
    const state = stateOf(integration);
    if (state === "needs_reauth") {
      return { words: t`Needs sign-in`, tone: "attention" };
    }
    if (state === "not_connected") {
      return integration.offered
        ? { words: t`Not connected`, tone: "neutral" }
        : { words: t`Not offered`, tone: "neutral" };
    }
    return { words: t`Connected`, tone: "success" };
  };
};

/**
 * An app's mark, one size per list: the library's Brand icon on its tile
 * where it has the brand, else the library's fallback, an Avatar with the
 * app's initials, at the same size.
 */
const Mark = ({
  integration,
  look = "row",
}: {
  integration: Integration;
  look?: "row" | "card";
}) => {
  const brand = brandOf(integration.id, integration.name);
  const size = look === "row" ? "sm" : "lg";
  return brand === undefined ? (
    <Avatar decorative name={integration.name} size={size}>
      <AvatarFallback />
    </Avatar>
  ) : (
    <BrandIcon brand={brand} decorative size={size} />
  );
};

/** The figures at a glance: connected, needing someone, workflows that use them. */
const Figures = ({
  integrations,
  uses,
}: {
  integrations: readonly Integration[];
  uses: readonly ConnectionWorkflows[] | undefined;
}) => {
  const { t } = useLingui();
  const connected = integrations.filter((each) => each.connections.length > 0);
  const needs = connected.filter((each) => stateOf(each) === "needs_reauth");
  const workflows = new Set(
    uses === undefined
      ? []
      : connected.flatMap((each) => workflowsOf(each, uses).map(({ id }) => id))
  );
  return (
    <StatsGrid
      aria-label={t`At a glance`}
      items={[
        { title: t`Connected`, value: formatNumber(connected.length) },
        {
          title: t`Need sign-in`,
          value: formatNumber(needs.length),
          ...(needs.length > 0 ? { tone: "danger" as const } : {}),
        },
        {
          title: t`In workflows`,
          value: uses === undefined ? "" : formatNumber(workflows.size),
          loading: uses === undefined,
        },
        {
          title: t`To add`,
          value: formatNumber(integrations.length - connected.length),
        },
      ]}
    />
  );
};

/** The search, in the address as it is typed. */
const Search = ({ q }: { q: string | undefined }) => {
  const { t } = useLingui();
  const navigate = useNavigate({ from: "/integrations/" });
  return (
    <InputGroup layout={styles.search} size="sm">
      <InputGroupText icon={SearchIcon} />
      <InputGroupInput
        aria-label={t`Search integrations`}
        defaultValue={q ?? ""}
        onValueChange={(typed) => {
          void navigate({
            replace: true,
            resetScroll: false,
            search: (last) => ({
              ...last,
              q: typed.trim() === "" ? undefined : typed,
            }),
          });
        }}
        placeholder={t`Search by name or kind`}
        type="search"
      />
      <InputGroupClear aria-label={t`Clear search`} />
    </InputGroup>
  );
};

/** One row of concept a's tables. */
interface AppRow {
  key: string;
  integration: Integration;
  name: string;
  kind: string;
  group: string;
  whose: string;
  by: string;
  usedBy: string;
  status: { words: string; tone: BadgeTone };
}

const NameCell = ({ integration }: { integration: Integration }) => (
  <Link
    resetScroll={false}
    search={(last) => ({ ...last, app: integration.key })}
    from="/integrations/"
    to="/integrations"
  >
    <span {...stylex.props(styles.name)}>
      <Mark integration={integration} />
      {integration.name}
    </span>
  </Link>
);

const nameCell = (row: AppRow) => <NameCell integration={row.integration} />;

/** Sign in again, where the app needs it: it opens the app beside the list, with its sign-in. */
const ActionCell = ({ integration }: { integration: Integration }) => {
  const { t } = useLingui();
  const open = useOpen();
  const { name } = integration;
  return stateOf(integration) === "needs_reauth" ? (
    <Button
      aria-label={t`Sign in to ${name} again`}
      onClick={() => {
        open(integration.key);
      }}
      size="xs"
      variant="quiet"
    >
      {t`Sign in again`}
    </Button>
  ) : null;
};

const actionCell = (row: AppRow) => (
  <ActionCell integration={row.integration} />
);

const statusCell = (row: AppRow) => (
  <Badge tone={row.status.tone}>{row.status.words}</Badge>
);

/** Concept a: what is connected as a table grouped by what needs someone; every app on a second tab. */
export const ConceptTable = ({
  integrations,
  uses,
  q,
  view,
  onRequest,
}: OverviewProps) => {
  const { t, i18n } = useLingui();
  const whose = useWhose();
  const usedBy = useUsedBy();
  const status = useStatus();
  const all = view === "all";
  const found = find(integrations, q);
  const connected = found.filter((each) => each.connections.length > 0);
  const others = found.filter((each) => each.connections.length === 0);
  const connectedCount = formatNumber(connected.length);
  const othersCount = formatNumber(others.length);
  const attention = t`Needs someone`;
  const working = t`Working`;
  const rowOf = (integration: Integration): AppRow => {
    const [newest] = integration.connections;
    const person = newest?.connectedByName ?? "";
    const date = newest === undefined ? "" : formatDayMonth(newest.createdAt);
    return {
      key: integration.key,
      integration,
      name: integration.name,
      kind: i18n._(groupLabel[integration.group]),
      group: stateOf(integration) === "needs_reauth" ? attention : working,
      whose: whose(integration),
      by: newest === undefined ? "" : t`${person}, ${date}`,
      usedBy: usedBy(integration, uses),
      status: status(integration),
    };
  };
  const rows = (all ? others : connected)
    .map(rowOf)
    .toSorted(
      (one, other) =>
        Number(other.group === attention) - Number(one.group === attention)
    );
  return (
    <div {...stylex.props(styles.page)}>
      <PageHeader
        actions={
          <Button icon={Plus} onClick={onRequest} variant="quiet">
            {t`Request app`}
          </Button>
        }
        tabs={
          <TabsNav aria-label={t`Integrations`}>
            <TabsLink
              current={!all}
              render={
                <Link
                  search={(last) => ({ ...last, view: undefined })}
                  from="/integrations/"
                  to="/integrations"
                />
              }
            >
              {t`Connected · ${connectedCount}`}
            </TabsLink>
            <TabsLink
              current={all}
              render={
                <Link
                  search={(last) => ({ ...last, view: "all" })}
                  from="/integrations/"
                  to="/integrations"
                />
              }
            >
              {t`All apps · ${othersCount}`}
            </TabsLink>
          </TabsNav>
        }
        title={t`Integrations`}
      />
      {all ? null : <Figures integrations={integrations} uses={uses} />}
      <ToolbarBand aria-label={t`Narrow the list`} start={<Search q={q} />} />
      {all ? (
        <DataTable
          appearance={{ head: "plain" }}
          columns={[
            {
              key: "name",
              header: t`App`,
              value: (row: AppRow) => row.name,
              cell: nameCell,
              sortable: true,
            },
            {
              key: "kind",
              header: t`Kind`,
              value: (row: AppRow) => row.kind,
              sortable: true,
            },
            {
              key: "status",
              header: t`Status`,
              value: (row: AppRow) => row.status.words,
              cell: statusCell,
              align: "end",
            },
          ]}
          label={t`All apps`}
          pageSize={20}
          rowKey={(row: AppRow) => row.key}
          rows={rows}
          unit={{ one: t`app`, other: t`apps` }}
        />
      ) : (
        <DataTable
          appearance={{ head: "plain" }}
          columns={[
            {
              key: "name",
              header: t`App`,
              value: (row: AppRow) => row.name,
              cell: nameCell,
            },
            { key: "whose", header: t`For`, value: (row: AppRow) => row.whose },
            {
              key: "by",
              header: t`Connected by`,
              value: (row: AppRow) => row.by,
            },
            ...(rows.some((row) => row.usedBy !== "")
              ? [
                  {
                    key: "usedBy",
                    header: t`Used by`,
                    value: (row: AppRow) => row.usedBy,
                  },
                ]
              : []),
            {
              key: "status",
              header: t`Status`,
              value: (row: AppRow) => row.status.words,
              cell: statusCell,
              align: "end",
            },
            {
              key: "action",
              header: t`Action`,
              value: () => "",
              cell: actionCell,
              align: "end",
            },
          ]}
          label={t`Connected`}
          rowKey={(row: AppRow) => row.key}
          rows={rows}
          searchable={false}
          unit={{ one: t`app`, other: t`apps` }}
        />
      )}
    </div>
  );
};

/** One app to add, as an outlined Item: its mark, name, sentence and Connect. */
const AppCard = ({ integration }: { integration: Integration }) => {
  const { t, i18n } = useLingui();
  const open = useOpen();
  const { name } = integration;
  return (
    <li {...stylex.props(styles.cell)}>
      <Item size="sm" variant="outline">
        <ItemMedia>
          <Mark integration={integration} />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>{name}</ItemTitle>
          <ItemDescription>
            {integration.description ?? i18n._(groupLabel[integration.group])}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          {integration.offered ? (
            <Button
              aria-label={t`Connect ${name}`}
              onClick={() => {
                open(integration.key);
              }}
              size="sm"
              variant="quiet"
            >
              {t`Connect`}
            </Button>
          ) : (
            <Badge size="sm">{t`Not offered`}</Badge>
          )}
        </ItemActions>
      </Item>
    </li>
  );
};

/**
 * What is connected, at the head of the catalogue, on the library's faint
 * dither of the light (PanelTexture, as the organisation card's cover):
 * one row of the same height each, those needing sign-in first.
 */
const ConnectedStrip = ({
  connected,
}: {
  connected: readonly Integration[];
}) => {
  const { t } = useLingui();
  const open = useOpen();
  if (connected.length === 0) {
    return null;
  }
  const ordered = connected.toSorted(
    (one, other) =>
      Number(stateOf(other) === "needs_reauth") -
      Number(stateOf(one) === "needs_reauth")
  );
  return (
    <Card aria-label={t`Connected`} element="section" padding="none">
      <div {...stylex.props(styles.strip)}>
        <PanelTexture />
        <ul {...stylex.props(styles.chips)}>
          {ordered.map((integration) => {
            const needs = stateOf(integration) === "needs_reauth";
            return (
              <li key={integration.key} {...stylex.props(styles.cell)}>
                <Item
                  render={
                    <button
                      aria-label={integration.name}
                      onClick={() => {
                        open(integration.key);
                      }}
                      type="button"
                    />
                  }
                  size="xs"
                >
                  <ItemMedia>
                    <Mark integration={integration} />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{integration.name}</ItemTitle>
                  </ItemContent>
                  {needs ? (
                    <ItemActions>
                      <Badge size="sm" tone="attention">
                        {t`Needs sign-in`}
                      </Badge>
                    </ItemActions>
                  ) : null}
                </Item>
              </li>
            );
          })}
        </ul>
      </div>
    </Card>
  );
};

/** Concept b: a catalogue of cards under a segmented filter. */
export const ConceptCatalogue = ({
  integrations,
  q,
  view,
  onRequest,
}: OverviewProps) => {
  const { t } = useLingui();
  const navigate = useNavigate({ from: "/integrations/" });
  const { i18n } = useLingui();
  const found = find(integrations, q);
  const connected = found.filter((each) => each.connections.length > 0);
  const others = found.filter((each) => each.connections.length === 0);
  const othersCount = formatNumber(others.length);
  const kinds = catalogGroups.filter((group) =>
    others.some((each) => each.group === group)
  );
  const filter = kinds.find((group) => group === view);
  const shown =
    filter === undefined
      ? others
      : others.filter((each) => each.group === filter);
  return (
    <div {...stylex.props(styles.page)}>
      <PageHeader
        actions={
          <Button icon={Plus} onClick={onRequest} variant="quiet">
            {t`Request app`}
          </Button>
        }
        title={t`Integrations`}
      />
      <ConnectedStrip connected={connected} />
      <ToolbarBand
        aria-label={t`Narrow the list`}
        end={
          <Select
            items={[
              {
                value: "all",
                label: t`Every kind · ${othersCount}`,
              },
              ...kinds.map((group) => ({
                value: group,
                label: i18n._(groupLabel[group]),
              })),
            ]}
            onValueChange={(next: string | null) => {
              void navigate({
                resetScroll: false,
                search: (last) => ({
                  ...last,
                  view: next === "all" || next === null ? undefined : next,
                }),
              });
            }}
            value={filter ?? "all"}
          >
            <SelectTrigger aria-label={t`Kind`} layout={styles.kind} size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent />
          </Select>
        }
        start={<Search q={q} />}
      />
      {shown.length === 0 ? (
        <Empty size="section">{t`No integrations match your search.`}</Empty>
      ) : (
        <ul {...stylex.props(styles.grid)}>
          {shown.map((integration) => (
            <AppCard integration={integration} key={integration.key} />
          ))}
        </ul>
      )}
    </div>
  );
};

/** Concept c: a card per topic, its title on the canvas. */
export const ConceptTopics = ({
  integrations,
  uses,
  connections,
  q,
  onRequest,
}: OverviewProps) => {
  const { t, i18n } = useLingui();
  const open = useOpen();
  const whose = useWhose();
  const usedBy = useUsedBy();
  const found = find(integrations, q);
  const needs = found.filter((each) => stateOf(each) === "needs_reauth");
  const working = found.filter(
    (each) => each.connections.length > 0 && stateOf(each) !== "needs_reauth"
  );
  const others = found.filter((each) => each.connections.length === 0);
  const http = httpConnectionsMatching(connections, q);
  const addable = others;
  return (
    <div {...stylex.props(styles.page)}>
      <PageHeader
        actions={
          <Button icon={Plus} onClick={onRequest} variant="quiet">
            {t`Request app`}
          </Button>
        }
        title={t`Integrations`}
      />
      {needs.length === 0 ? null : (
        <SectionCard
          density="compact"
          flush
          title={t`Needs you`}
          variant="grouped"
        >
          <ItemGroup aria-label={t`Needs you`} separated>
            {needs.map((integration) => {
              const { name } = integration;
              return (
                <Item key={integration.key} size="xs">
                  <ItemMedia>
                    <Mark integration={integration} />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{name}</ItemTitle>
                    <ItemDescription>
                      {t`Needs sign-in. What uses it waits until then.`}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      aria-label={t`Sign in to ${name} again`}
                      onClick={() => {
                        open(integration.key);
                      }}
                      size="sm"
                      variant="quiet"
                    >
                      {t`Sign in again`}
                    </Button>
                  </ItemActions>
                </Item>
              );
            })}
          </ItemGroup>
        </SectionCard>
      )}
      <SectionCard
        aside={
          <Text element="span" size="sm" tone="muted">
            {formatNumber(working.length)}
          </Text>
        }
        density="compact"
        flush
        title={t`Connected`}
        variant="grouped"
      >
        {working.length === 0 ? (
          <Empty size="inline">{t`Nothing connected yet.`}</Empty>
        ) : (
          <ItemGroup aria-label={t`Connected`} separated>
            {working.map((integration) => (
              <Item
                key={integration.key}
                render={
                  <Link
                    from="/integrations/"
                    resetScroll={false}
                    search={(last) => ({ ...last, app: integration.key })}
                    to="/integrations"
                  />
                }
                size="xs"
              >
                <ItemMedia>
                  <Mark integration={integration} />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{integration.name}</ItemTitle>
                  <ItemDescription>
                    {[whose(integration), usedBy(integration, uses)]
                      .filter((part) => part !== "")
                      .join(" · ")}
                  </ItemDescription>
                </ItemContent>
              </Item>
            ))}
          </ItemGroup>
        )}
      </SectionCard>
      <SectionCard
        actions={<Search q={q} />}
        density="compact"
        flush
        title={t`Add an app`}
        variant="grouped"
      >
        <ItemGroup aria-label={t`Add an app`} separated>
          {addable.map((integration) => {
            const { name } = integration;
            return (
              <Item key={integration.key} size="xs">
                <ItemMedia>
                  <Mark integration={integration} />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{name}</ItemTitle>
                  <ItemDescription>
                    {integration.description ??
                      i18n._(groupLabel[integration.group])}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  {integration.offered ? (
                    <Button
                      aria-label={t`Connect ${name}`}
                      onClick={() => {
                        open(integration.key);
                      }}
                      size="sm"
                      variant="quiet"
                    >
                      {t`Connect`}
                    </Button>
                  ) : (
                    <Badge size="sm">{t`Not offered`}</Badge>
                  )}
                </ItemActions>
              </Item>
            );
          })}
        </ItemGroup>
      </SectionCard>
      {http.length === 0 ? null : (
        <SectionCard
          density="compact"
          flush
          title={t`HTTP connections`}
          variant="grouped"
        >
          <ItemGroup aria-label={t`HTTP connections`} separated>
            {http.map(({ connection, http: summary }) => (
              <Item key={connection.id} size="xs">
                <ItemContent>
                  <ItemTitle>{summary.name}</ItemTitle>
                  <ItemDescription>{summary.origin}</ItemDescription>
                </ItemContent>
              </Item>
            ))}
          </ItemGroup>
        </SectionCard>
      )}
    </div>
  );
};

export const overviewConcepts = {
  a: ConceptTable,
  b: ConceptCatalogue,
  c: ConceptTopics,
} as const;
