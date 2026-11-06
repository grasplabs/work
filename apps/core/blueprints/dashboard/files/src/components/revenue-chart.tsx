import type { MoneyValue } from "@grasp-os/sdk";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  XAxis,
  chartColor,
} from "@grasp-os/ui/components/chart";
import type { ChartConfig } from "@grasp-os/ui/components/chart";

import { formatMoney } from "../lib/money";

const config: ChartConfig = { revenue: { label: "Revenue", color: "chart-1" } };

export const RevenueChart = ({
  months,
}: {
  months: readonly { month: string; revenue: MoneyValue }[];
}) => {
  const currency = months[0]?.revenue.currency ?? "EUR";
  return (
    <ChartContainer
      aria-label="Revenue by month"
      className="aspect-auto h-64 w-full"
      config={config}
    >
      <BarChart
        data={months.map(({ month, revenue }) => ({
          month,
          revenue: revenue.minorUnits,
        }))}
      >
        <CartesianGrid vertical={false} />
        <XAxis axisLine={false} dataKey="month" tickLine={false} />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(value) =>
                formatMoney({ currency, minorUnits: Number(value) })
              }
            />
          }
        />
        <Bar dataKey="revenue" fill={chartColor("chart-1")} radius={4} />
      </BarChart>
    </ChartContainer>
  );
};
