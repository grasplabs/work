import { Button } from "@grasp-os/ui/components/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@grasp-os/ui/components/context-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@grasp-os/ui/components/tooltip";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  CopyIcon,
  SquareArrowOutUpRightIcon,
} from "lucide-react";

import { AppLogo } from "../connections/app-logo.tsx";
import {
  AiTypeBadge,
  ExposureCell,
  ProcessesCell,
  SourceText,
  UsersCell,
} from "./app-cells.tsx";
import { appCategoryLabel, columnLabel, nextSort } from "./landscape.ts";
import type {
  Column,
  ColumnKey,
  LandscapeApp,
  LandscapeSort,
  SortKey,
} from "./landscape.ts";
import { Owner } from "./owner.tsx";

// The Landscape as a table, as the prototype draws it
// (`components/landscape/app-table.tsx`): one row per app, the columns the
// viewer chose, in their order. The prototype assigns an owner from a row;
// Grasp keeps no owners yet, so a row without one shows a dash.

export type Density = "compact" | "default" | "comfortable";

const columnSort: Partial<Record<ColumnKey, SortKey>> = {
  users: "users",
  owner: "owner",
};

/** The cells' variant for each row height. */
const cellVariant = {
  compact: "compact",
  default: "roomy",
  comfortable: "comfortable",
} as const satisfies Record<Density, string>;

const SortHeader = ({
  label,
  sortKey,
  sort,
  onSortChange,
}: {
  label: string;
  sortKey: SortKey;
  sort: LandscapeSort | null;
  onSortChange: (sort: LandscapeSort | null) => void;
}) => {
  const active = sort?.key === sortKey ? sort.dir : null;
  let Icon = ArrowUpDownIcon;
  if (active === "asc") {
    Icon = ArrowUpIcon;
  } else if (active === "desc") {
    Icon = ArrowDownIcon;
  }
  return (
    <Button
      className="-ml-2"
      onClick={() => {
        onSortChange(nextSort(sort, sortKey));
      }}
      size="xs"
      variant="ghost"
    >
      {label}
      <Icon data-icon="inline-end" />
      <span className="sr-only">
        {active === null ? (
          <Trans comment="Read after the column name by screen readers.">
            , not sorted
          </Trans>
        ) : null}
        {active === "asc" ? (
          <Trans comment="Read after the column name by screen readers.">
            , sorted ascending
          </Trans>
        ) : null}
        {active === "desc" ? (
          <Trans comment="Read after the column name by screen readers.">
            , sorted descending
          </Trans>
        ) : null}
      </span>
    </Button>
  );
};

const AppName = ({ app }: { app: LandscapeApp }) => {
  const rule = app.policySource ?? "";
  const logo = <AppLogo name={app.name} />;
  return (
    <div className="flex min-w-0 items-center gap-3">
      {app.description === null ? (
        <span className="relative z-10">{logo}</span>
      ) : (
        <Tooltip>
          <TooltipTrigger render={<span className="relative z-10" />}>
            {logo}
          </TooltipTrigger>
          <TooltipContent align="start" className="max-w-80" side="bottom">
            {app.description}
          </TooltipContent>
        </Tooltip>
      )}
      <div className="flex min-w-0 flex-col">
        <Link
          className="font-medium outline-none after:absolute after:inset-0 focus-visible:underline"
          params={{ appId: app.id }}
          to="/landscape/$appId/overview"
        >
          {app.name}
        </Link>
        {app.blocked || app.flagged ? (
          <span className="text-status-attention relative z-10 inline-flex min-w-0 items-center gap-1.5">
            <span
              aria-hidden="true"
              className="bg-status-attention size-1.75 flex-none rounded-full"
            />
            <span className="truncate">
              {app.blocked ? (
                <Trans>Blocked by “{rule}”</Trans>
              ) : (
                <Trans>Flagged by “{rule}”</Trans>
              )}
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground">{appCategoryLabel(app)}</span>
        )}
      </div>
    </div>
  );
};

const Cell = ({ app, column }: { app: LandscapeApp; column: ColumnKey }) => {
  const navigate = useNavigate();
  switch (column) {
    case "aiType": {
      return <AiTypeBadge aiType={app.aiType} />;
    }
    case "source": {
      return <SourceText appName={app.name} use={app.use} />;
    }
    case "processes": {
      return <ProcessesCell use={app.use} />;
    }
    case "dataExposure": {
      return (
        <ExposureCell
          reason={app.dataExposureReason}
          types={app.dataExposure}
        />
      );
    }
    case "users": {
      return (
        <UsersCell
          onOpen={() => {
            void navigate({
              to: "/landscape/$appId/usage",
              params: { appId: app.id },
            });
          }}
          teams={[]}
          users={app.users}
        />
      );
    }
    case "owner": {
      return app.owner === null ? (
        <span className="text-muted-foreground">–</span>
      ) : (
        <Owner compact name={app.owner} />
      );
    }
    default: {
      return column satisfies never;
    }
  }
};

const AppRow = ({
  app,
  columns,
  density,
}: {
  app: LandscapeApp;
  columns: readonly Column[];
  density: Density;
}) => {
  const { t } = useLingui();
  const navigate = useNavigate();
  const appName = app.name;
  const { users } = app;
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<TableRow className="relative" />}>
        <TableCell className="whitespace-normal" variant={cellVariant[density]}>
          <AppName app={app} />
        </TableCell>
        {columns.map(({ key }) => (
          <TableCell key={key} variant={cellVariant[density]}>
            <Cell app={app} column={key} />
          </TableCell>
        ))}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuGroup>
          <ContextMenuLabel>
            {t`${plural(users, { one: `${appName} · # user`, other: `${appName} · # users` })}`}
          </ContextMenuLabel>
          <ContextMenuItem
            onClick={() => {
              void navigate({
                to: "/landscape/$appId/overview",
                params: { appId: app.id },
              });
            }}
          >
            <SquareArrowOutUpRightIcon />
            <Trans context="open an app">Open</Trans>
          </ContextMenuItem>
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuGroup>
          <ContextMenuItem
            onClick={() => {
              void navigator.clipboard.writeText(app.id);
            }}
          >
            <CopyIcon />
            <Trans>Copy app ID</Trans>
          </ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
};

/** The landscape as a table: one row per app, the columns the viewer chose, in their order. */
export const AppTable = ({
  apps,
  columns,
  density,
  sort,
  onSortChange,
}: {
  apps: readonly LandscapeApp[];
  columns: readonly Column[];
  density: Density;
  sort: LandscapeSort | null;
  onSortChange: (sort: LandscapeSort | null) => void;
}) => {
  const { t, i18n } = useLingui();
  const shown = columns.filter(({ visible }) => visible);
  return (
    <div className="bg-card overflow-hidden rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="min-w-44" variant="card">
              <SortHeader
                label={t({ message: "App", context: "column: the app" })}
                onSortChange={onSortChange}
                sort={sort}
                sortKey="name"
              />
            </TableHead>
            {shown.map(({ key }) => {
              const sortKey = columnSort[key];
              return (
                <TableHead key={key} variant="card">
                  {sortKey === undefined ? (
                    i18n._(columnLabel[key])
                  ) : (
                    <SortHeader
                      label={i18n._(columnLabel[key])}
                      onSortChange={onSortChange}
                      sort={sort}
                      sortKey={sortKey}
                    />
                  )}
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {apps.length === 0 ? (
            <TableRow>
              <TableCell
                className="h-16 text-center"
                colSpan={shown.length + 1}
                variant="card"
              >
                <span className="text-muted-foreground">
                  <Trans>No apps match these filters.</Trans>
                </span>
              </TableCell>
            </TableRow>
          ) : (
            apps.map((app) => (
              <AppRow
                app={app}
                columns={shown}
                density={density}
                key={app.id}
              />
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
};
