"use client";

// shadcn's chart, on theme tokens only. Upstream writes each series' colour
// into a `<style>` element as `--color-<key>` and colours the tooltip and
// legend markers with inline styles. Here a series' colour is one of the
// theme's chart tokens: marks take it as `fill={chartColor("chart-1")}`, and
// the markers use the token's static class. No inline style, no `<style>`,
// and dark mode comes with the tokens.
import { cn } from "@grasp-os/ui/lib/utils";
import * as React from "react";
import * as RechartsPrimitive from "recharts";
import type { TooltipValueType } from "recharts";

const INITIAL_DIMENSION = { width: 320, height: 200 } as const;
type TooltipNameType = number | string;

/** The theme's chart colours, darkest first. */
const chartColors = [
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
] as const;

export type ChartColor = (typeof chartColors)[number];

/** A chart token as a colour value, for a mark's `fill` or `stroke`. */
const chartColor = (color: ChartColor): string => `var(--${color})`;

const markerColors = {
  "chart-1": "border-chart-1 bg-chart-1",
  "chart-2": "border-chart-2 bg-chart-2",
  "chart-3": "border-chart-3 bg-chart-3",
  "chart-4": "border-chart-4 bg-chart-4",
  "chart-5": "border-chart-5 bg-chart-5",
} as const satisfies Record<ChartColor, string>;

/** The token a mark's colour names, when it is `chartColor(token)`. */
const tokenOf = (color: unknown): ChartColor | undefined =>
  chartColors.find((token) => color === chartColor(token));

/** The classes of a marker in `color`, or a neutral one. */
const markerColor = (color: ChartColor | undefined): string =>
  color === undefined
    ? "border-muted-foreground bg-muted-foreground"
    : markerColors[color];

export type ChartConfig = Record<
  string,
  {
    label?: React.ReactNode;
    icon?: React.ComponentType;
    color?: ChartColor;
  }
>;

interface ChartContextProps {
  config: ChartConfig;
}

const ChartContext = React.createContext<ChartContextProps | null>(null);

function useChart() {
  const context = React.useContext(ChartContext);

  if (!context) {
    throw new Error("useChart must be used within a <ChartContainer />");
  }

  return context;
}

function ChartContainer({
  id,
  className,
  children,
  config,
  initialDimension = INITIAL_DIMENSION,
  ...props
}: React.ComponentProps<"div"> & {
  config: ChartConfig;
  children: React.ComponentProps<
    typeof RechartsPrimitive.ResponsiveContainer
  >["children"];
  initialDimension?: {
    width: number;
    height: number;
  };
}) {
  const uniqueId = React.useId();
  const chartId = `chart-${id ?? uniqueId.replaceAll(":", "")}`;
  const contextValue = { config };

  // Upstream hides the outline of the chart's surface, which takes focus
  // for keyboard use (recharts' accessibility layer); here it shows a ring.
  return (
    // oxlint-disable-next-line react/jsx-no-constructed-context-values -- compiled
    <ChartContext.Provider value={contextValue}>
      <div
        data-slot="chart"
        data-chart={chartId}
        className={cn(
          "[&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-border/50 [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-polar-grid_[stroke='#ccc']]:stroke-border [&_.recharts-radial-bar-background-sector]:fill-muted [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted [&_.recharts-reference-line_[stroke='#ccc']]:stroke-border [&_.recharts-surface:focus-visible]:outline-ring flex aspect-video justify-center text-xs [&_.recharts-dot[stroke='#fff']]:stroke-transparent [&_.recharts-layer]:outline-hidden [&_.recharts-sector]:outline-hidden [&_.recharts-sector[stroke='#fff']]:stroke-transparent [&_.recharts-surface]:outline-hidden [&_.recharts-surface:focus-visible]:outline-2 [&_.recharts-surface:focus-visible]:outline-solid",
          className
        )}
        {...props}
      >
        <RechartsPrimitive.ResponsiveContainer
          initialDimension={initialDimension}
        >
          {children}
        </RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

function getPayloadConfigFromPayload(
  config: ChartConfig,
  payload: unknown,
  key: string
): ChartConfig[string] | undefined {
  if (typeof payload !== "object" || payload === null) {
    return config[key];
  }

  const payloadPayload: unknown =
    "payload" in payload ? payload.payload : undefined;
  const own: unknown = Reflect.get(payload, key);
  const nested: unknown =
    typeof payloadPayload === "object" && payloadPayload !== null
      ? Reflect.get(payloadPayload, key)
      : undefined;

  let configLabelKey = key;
  if (typeof own === "string") {
    configLabelKey = own;
  } else if (typeof nested === "string") {
    configLabelKey = nested;
  }

  return configLabelKey in config ? config[configLabelKey] : config[key];
}

const ChartTooltip = RechartsPrimitive.Tooltip;

type TooltipEntry = RechartsPrimitive.TooltipPayloadEntry<
  TooltipValueType,
  TooltipNameType
>;

type ChartTooltipContentProps = Omit<React.ComponentProps<"div">, "color"> &
  Omit<
    RechartsPrimitive.DefaultTooltipContentProps<
      TooltipValueType,
      TooltipNameType
    >,
    "accessibilityLayer" | "color"
  > & {
    active?: boolean;
    hideLabel?: boolean;
    hideIndicator?: boolean;
    indicator?: "line" | "dot" | "dashed";
    nameKey?: string;
    labelKey?: string;
    /** Every marker's colour, instead of each series' own. */
    color?: ChartColor;
  };

/** A config key or a series' data key, as text. */
const keyText = (...candidates: unknown[]): string => {
  const found = candidates.find(
    (candidate) =>
      typeof candidate === "string" || typeof candidate === "number"
  );
  return typeof found === "string" || typeof found === "number"
    ? String(found)
    : "value";
};

function ChartTooltipLabel({
  config,
  payload,
  label,
  labelKey,
  labelFormatter,
  labelClassName,
}: Pick<
  ChartTooltipContentProps,
  "label" | "labelKey" | "labelFormatter" | "labelClassName"
> & { config: ChartConfig; payload: readonly TooltipEntry[] }) {
  const [item] = payload;
  const itemConfig = getPayloadConfigFromPayload(
    config,
    item,
    keyText(labelKey, item?.dataKey, item?.name)
  );
  const value =
    labelKey === undefined && typeof label === "string"
      ? (config[label]?.label ?? label)
      : itemConfig?.label;

  if (labelFormatter) {
    return (
      <div className={cn("font-medium", labelClassName)}>
        {labelFormatter(value, payload)}
      </div>
    );
  }

  if (value === undefined || value === null || value === "") {
    return null;
  }

  return <div className={cn("font-medium", labelClassName)}>{value}</div>;
}

function ChartTooltipMarker({
  color,
  indicator,
  nested,
}: {
  color: ChartColor | undefined;
  indicator: NonNullable<ChartTooltipContentProps["indicator"]>;
  nested: boolean;
}) {
  return (
    <div
      className={cn("shrink-0 rounded-[2px]", markerColor(color), {
        "h-2.5 w-2.5": indicator === "dot",
        "w-1": indicator === "line",
        "w-0 border-[1.5px] border-dashed bg-transparent":
          indicator === "dashed",
        "my-0.5": nested && indicator === "dashed",
      })}
    />
  );
}

function ChartTooltipValue({ value }: { value: TooltipEntry["value"] }) {
  if (value === undefined || value === null) {
    return null;
  }
  return (
    <span className="text-foreground font-mono font-medium tabular-nums">
      {typeof value === "number" ? value.toLocaleString() : String(value)}
    </span>
  );
}

function ChartTooltipContent({
  active,
  payload,
  className,
  indicator = "dot",
  hideLabel = false,
  hideIndicator = false,
  label,
  labelFormatter,
  labelClassName,
  formatter,
  color,
  nameKey,
  labelKey,
}: ChartTooltipContentProps) {
  const { config } = useChart();

  if (active !== true || payload === undefined || payload.length === 0) {
    return null;
  }

  const tooltipLabel = hideLabel ? null : (
    <ChartTooltipLabel
      config={config}
      payload={payload}
      label={label}
      labelKey={labelKey}
      labelFormatter={labelFormatter}
      labelClassName={labelClassName}
    />
  );
  const nestLabel = payload.length === 1 && indicator !== "dot";

  return (
    <div
      className={cn(
        "border-border/50 bg-background grid min-w-32 items-start gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs shadow-xl",
        className
      )}
    >
      {nestLabel ? null : tooltipLabel}
      <div className="grid gap-1.5">
        {payload
          .filter((item) => item.type !== "none")
          .map((item, index) => {
            const key = keyText(nameKey, item.name, item.dataKey);
            const itemConfig = getPayloadConfigFromPayload(config, item, key);
            const fill: unknown =
              typeof item.payload === "object" && item.payload !== null
                ? Reflect.get(item.payload, "fill")
                : undefined;
            return (
              <div
                key={`${key}-${keyText(item.dataKey)}`}
                className={cn(
                  "[&>svg]:text-muted-foreground flex w-full flex-wrap items-stretch gap-2 [&>svg]:h-2.5 [&>svg]:w-2.5",
                  indicator === "dot" && "items-center"
                )}
              >
                {formatter !== undefined &&
                item.value !== undefined &&
                item.name !== undefined ? (
                  formatter(item.value, item.name, item, index, payload)
                ) : (
                  <>
                    {itemConfig?.icon ? <itemConfig.icon /> : null}
                    {itemConfig?.icon === undefined && !hideIndicator ? (
                      <ChartTooltipMarker
                        color={
                          color ??
                          itemConfig?.color ??
                          tokenOf(fill) ??
                          tokenOf(item.color)
                        }
                        indicator={indicator}
                        nested={nestLabel}
                      />
                    ) : null}
                    <div
                      className={cn(
                        "flex flex-1 justify-between leading-none",
                        nestLabel ? "items-end" : "items-center"
                      )}
                    >
                      <div className="grid gap-1.5">
                        {nestLabel ? tooltipLabel : null}
                        <span className="text-muted-foreground">
                          {itemConfig?.label ?? item.name}
                        </span>
                      </div>
                      <ChartTooltipValue value={item.value} />
                    </div>
                  </>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}

const ChartLegend = RechartsPrimitive.Legend;

function ChartLegendContent({
  className,
  hideIcon = false,
  payload,
  // oxlint-disable-next-line typescript/no-deprecated -- recharts still passes it to the content
  verticalAlign = "bottom",
  nameKey,
}: React.ComponentProps<"div"> & {
  hideIcon?: boolean;
  nameKey?: string;
} & RechartsPrimitive.DefaultLegendContentProps) {
  const { config } = useChart();

  if (payload === undefined || payload.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        "flex items-center justify-center gap-4",
        verticalAlign === "top" ? "pb-3" : "pt-3",
        className
      )}
    >
      {payload
        .filter((item) => item.type !== "none")
        .map((item) => {
          const key = keyText(nameKey, item.dataKey);
          const itemConfig = getPayloadConfigFromPayload(config, item, key);

          return (
            <div
              key={`${key}-${keyText(item.value)}`}
              className="[&>svg]:text-muted-foreground flex items-center gap-1.5 [&>svg]:h-3 [&>svg]:w-3"
            >
              {itemConfig?.icon && !hideIcon ? (
                <itemConfig.icon />
              ) : (
                <div
                  className={cn(
                    "h-2 w-2 shrink-0 rounded-[2px]",
                    markerColor(itemConfig?.color ?? tokenOf(item.color))
                  )}
                />
              )}
              {itemConfig?.label}
            </div>
          );
        })}
    </div>
  );
}

export {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  chartColor,
  chartColors,
};

// Screens import only the kit's modules, never recharts itself, so the chart
// module hands on recharts' charts and their parts.
export {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Brush,
  CartesianGrid,
  ComposedChart,
  Funnel,
  FunnelChart,
  Label,
  LabelList,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  RadialBar,
  RadialBarChart,
  ReferenceArea,
  ReferenceDot,
  ReferenceLine,
  Scatter,
  ScatterChart,
  Treemap,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
