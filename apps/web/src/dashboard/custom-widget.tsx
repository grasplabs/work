import type {
  CustomWidget,
  WidgetCell,
  WidgetColumn,
  WidgetMeasure,
  WidgetState,
  WidgetViewPart,
} from "@grasp-os/shared/widgets";
import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { formatNumber } from "../format.ts";
import {
  Chart,
  ChartArea,
  ChartAxis,
  ChartGrid,
  ChartTooltip,
} from "../grasp/chart/index.ts";
import { Stat } from "../grasp/stats/index.ts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../grasp/table/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { BarList } from "./bar-list.tsx";
import { WidgetBlock } from "./widget-block.tsx";

// A widget Grasp made from what the person asked (@grasp-os/shared's
// widgets.ts), as the prototype draws one (`components/dashboard/
// widget-render.tsx`): its parts top to bottom, a row's side by side, in
// the board's own parts and colours. Core works out every number from
// what the person may see when it reads the widget: the page only draws
// them, and names what core names by key (a state, a measure).

const styles = stylex.create({
  part: { display: "flex", flexDirection: "column", gap: grasp.space2 },
  parts: { display: "flex", flexDirection: "column", gap: grasp.space4 },
  row: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: grasp.space4,
  },
  rowOfThree: { gridTemplateColumns: "repeat(3, minmax(0, 1fr))" },
});

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
  <Text size="sm" tone="muted">
    <Trans>Nothing to show yet.</Trans>
  </Text>
);

/** A part's own label, over it, when it has one. */
const PartLabel = ({ label }: { label: string | null }) =>
  label === null ? null : (
    <h3>
      <Text element="span" size="xs" tone="muted" weight="medium">
        {label}
      </Text>
    </h3>
  );

/** How tall a trend is drawn in a block, in CSS pixels. */
const TREND_HEIGHT = 112;

/** What a trend's numbers say, for a screen reader: where it started and where it is now. */
const trendSummary = (
  points: readonly { value: number }[],
  measure: string,
  i18n: I18n
): string => {
  const first = points.at(0)?.value;
  const last = points.at(-1)?.value;
  if (first === undefined || last === undefined) {
    return i18n._(msg`Nothing to show yet.`);
  }
  const from = formatNumber(first);
  const to = formatNumber(last);
  return i18n._(msg`${measure}: from ${from} to ${to}.`);
};

/** One part of a widget. */
const Part = ({ part }: { part: WidgetViewPart }) => {
  const { i18n } = useLingui();
  switch (part.type) {
    case "number": {
      return <Stat title={part.label} value={formatNumber(part.value)} />;
    }
    case "bars": {
      const measure = i18n._(measureNames[part.measure]);
      return (
        <div {...stylex.props(styles.part)}>
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
        <div {...stylex.props(styles.part)}>
          <PartLabel label={part.label} />
          <Chart
            config={{ value: { label: measure } }}
            data={part.points}
            height={TREND_HEIGHT}
            aria-label={part.label ?? measure}
            summary={trendSummary(part.points, measure, i18n)}
            xKey="day"
          >
            <ChartGrid />
            <ChartAxis
              format={(value) => formatNumber(Number(value))}
              side="y"
            />
            <ChartArea series="value" />
            <ChartTooltip format={formatNumber} />
          </Chart>
        </div>
      );
    }
    case "table": {
      return (
        <div {...stylex.props(styles.part)}>
          <PartLabel label={part.label} />
          {part.rows.length === 0 ? (
            <NothingToShow />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  {part.columns.map((column) => (
                    <TableHead
                      align={
                        column === "workflow" || column === "state"
                          ? "start"
                          : "end"
                      }
                      key={column}
                    >
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
                        <TableCell
                          align={typeof cell === "number" ? "end" : "start"}
                          key={column}
                        >
                          {cellText(cell, column, i18n)}
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
      return (
        <Text size="sm" tone="muted">
          {part.text}
        </Text>
      );
    }
    case "row": {
      return (
        <div
          {...stylex.props(
            styles.row,
            part.parts.length === 3 && styles.rowOfThree
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
    <div {...stylex.props(styles.parts)}>
      {parts.map((part, index) => (
        // A widget's parts are as its spec lists them, and never move.
        <Part key={index} part={part} />
      ))}
      <Text size="xs" tone="muted">
        <Plural one="The last # day" other="The last # days" value={days} />
      </Text>
    </div>
  );
};

/** A widget Grasp made, in its block, opening in full. */
export const CustomWidgetBlock = ({ widget }: { widget: CustomWidget }) => (
  <WidgetBlock full={<Parts widget={widget} />} title={widget.view.title}>
    <Parts widget={widget} />
  </WidgetBlock>
);
