import type { AppOverview } from "@grasp-os/shared/apps";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";

import { readPeople } from "../directory.ts";
import { AppCard } from "../grasp/app-card/index.ts";
import { Avatar } from "../grasp/avatar/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import { DataTable } from "../grasp/data-table/index.ts";
import type { DataTableColumn } from "../grasp/data-table/index.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../grasp/dropdown-menu/index.ts";
import { IconTile } from "../grasp/icon-tile/index.ts";
import {
  AppWindow,
  Archive,
  Expand,
  More,
  Settings,
} from "../grasp/icons/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { ProcessTile } from "../workflows/business-process.tsx";
import { statusOf } from "./app-status.tsx";
import { useCoreRead } from "./use-core-read.ts";

// CONCEPT ONLY (branch feat/apps-bar-concepts): three ways the Apps
// overview could stand, by `?cards=grid|compact|table`, for Ruben to pick.
// Never merged as it stands.
//
// grid: small cards, three to a row, each window the App's own full page
//   running in it (scaled, inert), where core has no picture to show.
// compact: cards without a window: the App's process tile, its name, what
//   it is for in a line, its state as a Badge, its owner's face.
// table: the Apps as a DataTable (the tables pattern), sortable.

export type OverviewConcept = "grid" | "compact" | "table";

const styles = stylex.create({
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(18rem, 1fr))",
    gap: grasp.space4,
  },
  compact: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(20rem, 1fr))",
    gap: grasp.space3,
  },
  card: {
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr) auto",
    alignItems: "start",
    gap: grasp.space3,
    padding: grasp.space4,
    borderRadius: grasp.corner,
    backgroundColor: grasp.raised,
    boxShadow: grasp.edge,
    color: "inherit",
    textDecorationLine: "none",
  },
  words: { display: "grid", gap: grasp.space1, minWidth: 0 },
  foot: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    marginTop: grasp.space2,
  },
  name: { display: "flex", alignItems: "center", gap: grasp.space2 },
});

/** What each state is called, as a Badge says it. */
const useStates = () => {
  const { t } = useLingui();
  return {
    live: { words: t`Live`, tone: "success" as const },
    draft: { words: t`Not shared`, tone: "attention" as const },
    archived: {
      words: t({ message: "Archived", context: "an App put away" }),
      tone: "neutral" as const,
    },
  };
};

/** The App's menu: Open, Open full page, Settings, Archive. */
const AppMenu = ({ app }: { app: AppOverview["app"] }) => {
  const { t } = useLingui();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t`More`}
        icon={More}
        size="sm"
        variant="ghost"
      />
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          icon={AppWindow}
          render={<Link params={{ app: app.id }} to="/apps/$app" />}
        >
          {t`Open`}
        </DropdownMenuItem>
        <DropdownMenuItem href={`/apps/${app.id}/full`} icon={Expand}>
          {t`Open full page`}
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={Settings}
          render={<Link params={{ app: app.id }} to="/apps/$app/settings" />}
        >
          {t`Settings`}
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={Archive}
          render={<Link params={{ app: app.id }} to="/apps/$app/settings" />}
        >
          {t`Archive`}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** The App's mark: its process's tile where it has one, else an App's. */
const Mark = ({ app }: { app: AppOverview["app"] }) =>
  app.process === null ? (
    <IconTile icon={AppWindow} />
  ) : (
    <ProcessTile process={app.process} />
  );

/** The table concept's columns, built outside the component that draws them. */
const appColumns = (
  words: { name: string; state: string; owner: string; made: string },
  states: ReturnType<typeof useStates>,
  names: ReadonlyMap<string, string>
): DataTableColumn<AppOverview>[] => [
  {
    key: "name",
    header: words.name,
    sortable: true,
    wrap: true,
    value: ({ app }) => app.name,
    cell: ({ app }) => (
      <span {...stylex.props(styles.name)}>
        <Mark app={app} />
        <Link params={{ app: app.id }} to="/apps/$app">
          {app.name}
        </Link>
      </span>
    ),
  },
  {
    key: "state",
    header: words.state,
    sortable: true,
    value: ({ app }) => states[statusOf(app)].words,
    cell: ({ app }) => {
      const state = states[statusOf(app)];
      return (
        <Badge tone={state.tone} variant="dot">
          {state.words}
        </Badge>
      );
    },
  },
  {
    key: "owner",
    header: words.owner,
    sortable: true,
    value: ({ app }) => names.get(app.owner) ?? "",
  },
  {
    key: "made",
    header: words.made,
    sortable: true,
    align: "end",
    value: ({ app }) => app.createdAt.slice(0, 10),
  },
];

/** People's names, for the owners' faces. */
const useNames = () => {
  const read = useCoreRead("people", readPeople);
  return read?.state === "ready" ? read.data : new Map<string, string>();
};

/** The Apps, as concept `kind` draws them. */
export const AppsConcept = ({
  kind,
  apps,
}: {
  kind: OverviewConcept;
  apps: readonly AppOverview[];
}) => {
  const { t } = useLingui();
  const states = useStates();
  const names = useNames();
  if (kind === "grid") {
    return (
      <div {...stylex.props(styles.grid)}>
        {apps.map(({ app }) => (
          <AppCard
            actions={[
              {
                label: t`Open full page`,
                icon: Expand,
                href: `/apps/${app.id}/full`,
              },
              {
                label: t`Settings`,
                icon: Settings,
                render: (
                  <Link params={{ app: app.id }} to="/apps/$app/settings" />
                ),
              },
            ]}
            key={app.id}
            labels={{ more: t`More`, empty: "" }}
            meta={states[statusOf(app)].words}
            preview={{
              kind: "live",
              src: `/apps/${app.id}/full`,
              title: app.name,
              sandbox: "allow-scripts allow-same-origin",
            }}
            render={<Link params={{ app: app.id }} to="/apps/$app" />}
            title={app.name}
            {...(app.description === ""
              ? {}
              : { description: app.description })}
          />
        ))}
      </div>
    );
  }
  if (kind === "compact") {
    return (
      <div {...stylex.props(styles.compact)}>
        {apps.map(({ app }) => {
          const state = states[statusOf(app)];
          const owner = names.get(app.owner) ?? "";
          return (
            <div key={app.id} {...stylex.props(styles.card)}>
              <Mark app={app} />
              <div {...stylex.props(styles.words)}>
                <Link params={{ app: app.id }} to="/apps/$app">
                  <Text element="span" size="md" weight="medium">
                    {app.name}
                  </Text>
                </Link>
                <Text size="sm" tone="muted" wrap="truncate">
                  {app.description}
                </Text>
                <div {...stylex.props(styles.foot)}>
                  <Badge tone={state.tone} variant="dot">
                    {state.words}
                  </Badge>
                  {owner === "" ? null : <Avatar name={owner} size="xs" />}
                  <Text element="span" size="xs" tone="muted">
                    {owner}
                  </Text>
                </div>
              </div>
              <AppMenu app={app} />
            </div>
          );
        })}
      </div>
    );
  }
  const columns = appColumns(
    { name: t`Name`, state: t`State`, owner: t`Owner`, made: t`Made` },
    states,
    names
  );
  return (
    <DataTable
      columns={columns}
      label={t`Apps`}
      rowActions={({ app }) => [
        {
          label: t`Open full page`,
          onSelect: () => {
            window.location.assign(`/apps/${app.id}/full`);
          },
        },
      ]}
      rowKey={({ app }) => app.id}
      rows={apps}
      unit={{ one: t`App`, other: t`Apps` }}
    />
  );
};
