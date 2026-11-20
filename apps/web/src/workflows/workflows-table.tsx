import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { formatList, formatNumber } from "../format.ts";
import { Avatar, AvatarFallback } from "../grasp/avatar/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import { BrandIconGroup } from "../grasp/brand-icon/group.tsx";
import { Button } from "../grasp/button/index.ts";
import {
  DataTable,
  DataTablePerson,
  grouping,
  view,
} from "../grasp/data-table/index.ts";
import type { DataTableColumn } from "../grasp/data-table/index.ts";
import { IconTile } from "../grasp/icon-tile/index.ts";
import { Workflow } from "../grasp/icons/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { useNarrow } from "../use-narrow.ts";
import { processIcons } from "./business-process.tsx";
import type { OverviewRow, Phase, Tool, ToolsByWorkflow } from "./overview.ts";

// The Workflows page's table, on the library's Data table: one row a
// workflow, gathered by the phase it stands in (overview.ts), what needs
// the reader first. A row begins with the icon of the process it serves
// (or a workflow's own), then its name; then whose it is, the tools it
// reaches and the runs it completed this week. Each row opens its
// workflow. On a phone a row is its workflow and its owner's face.

const phaseNames: Readonly<Record<Phase, MessageDescriptor>> = {
  needsYou: msg({ message: "Needs you", context: "workflow phase" }),
  running: msg({ message: "Running", context: "workflow phase" }),
  building: msg({ message: "Building", context: "workflow phase" }),
  toBuild: msg({ message: "To build", context: "workflow phase" }),
};

const styles = stylex.create({
  // The icon and the name in a box one line of the table's text tall, as
  // the library's person in a cell: the tile, taller than the line, reaches
  // into the cell's padding and the row keeps its height.
  lead: {
    display: "inline-flex",
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
    height: grasp.tableTextLine,
    verticalAlign: "top",
  },
  // The name on the one line the box holds, as the library's person's.
  name: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // A face alone, held to the line as the lead is.
  face: {
    display: "inline-flex",
    alignItems: "center",
    height: grasp.tableTextLine,
    verticalAlign: "top",
  },
});

/** A workflow's icon and name, and that it is paused when it is. */
const WorkflowCell = ({ row }: { row: OverviewRow }) => {
  const { t } = useLingui();
  return (
    <span {...stylex.props(styles.lead)}>
      <IconTile
        icon={row.process === null ? Workflow : processIcons[row.process]}
        size="sm"
        variant="tint"
      />
      <span {...stylex.props(styles.name)}>{row.name}</span>
      {row.paused ? (
        <Badge size="sm">
          {t({ message: "Paused", context: "a workflow someone paused" })}
        </Badge>
      ) : null}
    </span>
  );
};

/** A workflow's owner: their face and name; on a phone their face alone, named for a screen reader. */
const OwnerCell = ({
  name,
  narrow,
}: {
  name: string | null;
  narrow: boolean;
}) => {
  if (name === null) {
    return null;
  }
  return narrow ? (
    <span {...stylex.props(styles.face)}>
      <Avatar name={name} size="xs">
        <AvatarFallback />
      </Avatar>
    </span>
  ) : (
    <DataTablePerson name={name} size="xs" />
  );
};

/** The tools a workflow reaches, as the library's marks: three, then how many more. */
const ToolsCell = ({ tools }: { tools: readonly Tool[] }) =>
  tools.length === 0 ? null : (
    <BrandIconGroup
      brands={tools.map(({ name, brand }) => brand ?? { name })}
      max={3}
    />
  );

const noTools: readonly Tool[] = [];

/**
 * Follows a row's link within Grasp. The Data table draws a row's link as
 * a plain anchor (`rowHref`), which the browser would follow by loading
 * the whole page again: a plain press goes through the router instead. A
 * press that opens a new tab or window is left to the browser.
 */
const useRowLinks = () => {
  const router = useRouter();
  const table = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = table.current;
    const onClick = (event: MouseEvent): void => {
      const link =
        event.target instanceof Element
          ? event.target.closest("a[data-row-target]")
          : null;
      const href = link?.getAttribute("href");
      const plain =
        event.button === 0 &&
        !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
      if (href === null || href === undefined || !plain) {
        return;
      }
      event.preventDefault();
      router.history.push(href);
    };
    host?.addEventListener("click", onClick);
    return () => {
      host?.removeEventListener("click", onClick);
    };
  }, [router]);
  return table;
};

/** The columns' words, in the page's language. */
interface ColumnWords {
  workflow: string;
  phase: string;
  owner: string;
  tools: string;
  runs: string;
  phaseName: (phase: Phase) => string;
}

/** The table's columns: the workflow, its phase (out of view), whose it is, its tools and its runs. */
const columnsOf = ({
  words,
  narrow,
  tools,
}: {
  words: ColumnWords;
  /** Below the phone's width the owner is their face alone. */
  narrow: boolean;
  tools: ToolsByWorkflow | undefined;
}): DataTableColumn<OverviewRow>[] => {
  const toolsOf = (row: OverviewRow): readonly Tool[] =>
    tools?.get(row.id) ?? noTools;
  return [
    {
      key: "workflow",
      header: words.workflow,
      value: (row) => row.name,
      cell: (row) => <WorkflowCell row={row} />,
    },
    // The phase gathers the rows: its column stays out of view, its words
    // in each group's heading.
    {
      key: "phase",
      header: words.phase,
      value: (row) => words.phaseName(row.phase),
      hidden: true,
    },
    {
      key: "owner",
      header: words.owner,
      value: (row) => row.owner ?? "",
      cell: (row) => <OwnerCell name={row.owner} narrow={narrow} />,
    },
    {
      key: "tools",
      header: words.tools,
      value: (row) => formatList(toolsOf(row).map(({ name }) => name)),
      cell: (row) => <ToolsCell tools={toolsOf(row)} />,
      hideBelow: "phone",
    },
    {
      key: "runs",
      header: words.runs,
      value: (row) => row.runs ?? "",
      cell: (row) => (row.runs === null ? null : formatNumber(row.runs)),
      align: "end",
      hideBelow: "phone",
    },
  ];
};

/**
 * Every workflow the person can open, gathered by phase. `tools` come
 * after the rows (their own read): until then, and where a workflow
 * reaches none, its cell is empty.
 */
export const WorkflowsByPhase = ({
  rows,
  tools,
}: {
  /** In the order of their phases (overview.ts). */
  rows: readonly OverviewRow[];
  tools: ToolsByWorkflow | undefined;
}) => {
  const { t, i18n } = useLingui();
  const router = useRouter();
  const narrow = useNarrow();
  const table = useRowLinks();
  const needsYou = i18n._(phaseNames.needsYou);
  return (
    <div ref={table}>
      <DataTable
        columns={columnsOf({
          words: {
            workflow: t`Workflow`,
            phase: t({
              message: "Phase",
              context: "column: a workflow's phase",
            }),
            owner: t({
              message: "Owner",
              context: "column: who owns a workflow",
            }),
            tools: t`Tools`,
            runs: t`Runs a week`,
            phaseName: (phase) => i18n._(phaseNames[phase]),
          },
          narrow,
          tools,
        })}
        empty={{
          title: t`No workflows yet`,
          description: t`Workflows are made in chat: describe what should run on its own, and Grasp builds it.`,
          icon: Workflow,
          action: (
            <Button render={<Link search={{}} to="/" />}>{t`Open Chat`}</Button>
          ),
        }}
        groupBy="phase"
        groupTone={(phase) => (phase === needsYou ? "attention" : undefined)}
        label={t`Workflows`}
        pieces={[grouping, view]}
        rowHref={(row) =>
          router.buildLocation({
            to: "/workflows/$workflow",
            params: { workflow: row.id },
          }).href
        }
        rowKey={(row) => row.id}
        rows={rows}
        unit={{ one: t`workflow`, other: t`workflows` }}
      />
    </div>
  );
};
