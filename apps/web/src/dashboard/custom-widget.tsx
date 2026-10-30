import type {
  CustomWidget,
  WidgetCell,
  WidgetColumn,
  WidgetMeasure,
  WidgetState,
  WidgetViewPart,
} from "@grasp-os/shared/widgets";
import {
  CartesianGrid,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  Line,
  LineChart,
  XAxis,
  YAxis,
  chartColor,
} from "@grasp-os/ui/components/chart";
import type { ChartConfig } from "@grasp-os/ui/components/chart";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { cn } from "@grasp-os/ui/lib/utils";
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";

import { formatNumber } from "../format.ts";
import { BarList } from "../onboarding/staff-figures.tsx";
import { WidgetBlock } from "./widget-block.tsx";

// A widget Grasp made from what the person asked (@grasp-os/shared's
// widgets.ts), as the prototype draws one (`components/dashboard/
// widget-render.tsx`): its parts top to bottom, a row's side by side, in
// the board's own parts and colours. Core works out every number from
// what the person may see when it reads the widget: the page only draws
// them, and names what core names by key (a state, a measure).

/** What each measure counts, as a part names it. */
const measureNames: Record<WidgetMeasure, MessageDescriptor> = {
  started: msg({ message: "Started", context: "workflow runs that started" }),
  completed: msg({ message: "Completed", context: "workflow runs" }),
  failed: msg({ message: "Failed", context: "workflow runs" }),
  waiting: msg({ message: "Waiting for someone", context: "workflow runs" }),
  workflows: msg`Workflows`,
};

/** Each workflow state, as a widget names it. */
const stateNames: Record<WidgetState, MessageDescriptor> = {
  none: msg({ message: "Not run yet", context: "a workflow's state" }),
  queued: msg({ message: "Queued", context: "a workflow's state" }),
  running: msg({ message: "Running", context: "a workflow's state" }),
  waiting: msg({ message: "Waiting", context: "a workflow's state" }),
  paused: msg({ message: "Paused", context: "a workflow's state" }),
  completed: msg({ message: "Completed", context: "a workflow's state" }),
  failed: msg({ message: "Failed", context: "a workflow's state" }),
  cancelled: msg({ message: "Cancelled", context: "a workflow's state" }),
};

/** Each column of a widget's table, as its header names it. */
const columnNames: Record<WidgetColumn, MessageDescriptor> = {
  engine: msg({ message: "Domain", context: "a table column: an engine" }),
  workflow: msg({ message: "Workflow", context: "a table column" }),
  state: msg({ message: "State", context: "a table column: a workflow's" }),
  started: measureNames.started,
  completed: measureNames.completed,
  failed: measureNames.failed,
  waiting: measureNames.waiting,
};

/** Whether `key` is a state core names by key. */
const isState = (key: string): key is WidgetState => key in stateNames;

/** A table's cell as the page shows it: a state by its name, a number formatted. */
const cellText = (cell: WidgetCell, column: WidgetColumn, i18n: I18n) => {
  if (typeof cell === "number") {
    return formatNumber(cell);
  }
  return column === "state" && isState(cell) ? i18n._(stateNames[cell]) : cell;
};

/** What a part with nothing to show says. */
const NothingToShow = () => (
  <p className="text-muted-foreground">
    <Trans>Nothing to show yet.</Trans>
  </p>
);

/** A part's own label, over it, when it has one. */
const PartLabel = ({ label }: { label: string | null }) =>
  label === null ? null : (
    <h3 className="text-muted-foreground text-xs font-medium">{label}</h3>
  );

const trendConfig = {
  value: { color: "chart-1" },
} satisfies ChartConfig;

/** One part of a widget. */
const Part = ({ part }: { part: WidgetViewPart }) => {
  const { i18n } = useLingui();
  switch (part.type) {
    case "number": {
      return (
        <div className="flex flex-col gap-0.5">
          <span className="type-figure">{formatNumber(part.value)}</span>
          <span className="text-muted-foreground">{part.label}</span>
        </div>
      );
    }
    case "bars": {
      const measure = i18n._(measureNames[part.measure]);
      return (
        <div className="flex flex-col gap-2">
          <PartLabel label={part.label} />
          {part.bars.length === 0 ? (
            <NothingToShow />
          ) : (
            <BarList
              label={part.label ?? measure}
              rows={part.bars.map((bar) => ({
                id: bar.key,
                label:
                  part.by === "state" && isState(bar.key)
                    ? i18n._(stateNames[bar.key])
                    : bar.name,
                value: bar.value,
                shown: formatNumber(bar.value),
              }))}
            />
          )}
        </div>
      );
    }
    case "trend": {
      const measure = i18n._(measureNames[part.measure]);
      return (
        <div className="flex flex-col gap-2">
          <PartLabel label={part.label} />
          <ChartContainer
            aria-label={part.label ?? measure}
            className="aspect-auto h-28 w-full"
            config={trendConfig}
          >
            <LineChart
              data={part.points}
              margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
            >
              <CartesianGrid vertical={false} />
              <XAxis axisLine={false} dataKey="day" hide tickLine={false} />
              <YAxis
                allowDecimals={false}
                axisLine={false}
                tickLine={false}
                width={28}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(value) =>
                      `${measure}: ${formatNumber(Number(value))}`
                    }
                  />
                }
              />
              <Line
                dataKey="value"
                dot={false}
                stroke={chartColor("chart-1")}
                strokeWidth={2}
                type="monotone"
              />
            </LineChart>
          </ChartContainer>
        </div>
      );
    }
    case "table": {
      return (
        <div className="flex flex-col gap-2">
          <PartLabel label={part.label} />
          {part.rows.length === 0 ? (
            <NothingToShow />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  {part.columns.map((column) => (
                    <TableHead key={column}>
                      {i18n._(columnNames[column])}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {part.rows.map((row) => (
                  <TableRow key={row.join("\u0000")}>
                    {row.map((cell, index) => {
                      const column = part.columns[index] ?? "workflow";
                      return (
                        <TableCell key={column}>
                          {typeof cell === "number" ? (
                            <span className="tabular-nums">
                              {cellText(cell, column, i18n)}
                            </span>
                          ) : (
                            cellText(cell, column, i18n)
                          )}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      );
    }
    case "text": {
      return <p className="text-muted-foreground">{part.text}</p>;
    }
    case "row": {
      return (
        <div
          className={cn(
            "grid gap-4",
            part.parts.length === 3 ? "grid-cols-3" : "grid-cols-2"
          )}
        >
          {part.parts.map((each, index) => (
            // The parts of a row never move: their place is who they are.
            <Part key={index} part={each} />
          ))}
        </div>
      );
    }
    default: {
      return null;
    }
  }
};

/** A widget's parts, top to bottom, and the days it looks back over. */
const Parts = ({ widget }: { widget: CustomWidget }) => {
  const { days, parts } = widget.view;
  return (
    <div className="flex flex-col gap-4">
      {parts.map((part, index) => (
        // A widget's parts are as its spec lists them, and never move.
        <Part key={index} part={part} />
      ))}
      <p className="text-muted-foreground text-xs">
        <Plural one="The last # day" other="The last # days" value={days} />
      </p>
    </div>
  );
};

/** A widget Grasp made, in its block, opening in full. */
export const CustomWidgetBlock = ({ widget }: { widget: CustomWidget }) => (
  <WidgetBlock full={<Parts widget={widget} />} title={widget.view.title}>
    <Parts widget={widget} />
  </WidgetBlock>
);
