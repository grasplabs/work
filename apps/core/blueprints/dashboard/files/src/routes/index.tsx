import { useMutation, useQuery } from "@grasp-os/runtime/react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import { DataGrid } from "@grasp-os/ui/components/data-grid";
import { Grid } from "@grasp-os/ui/components/grid";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderContent,
  PageHeaderTitle,
} from "@grasp-os/ui/components/page-header";
import { Skeleton } from "@grasp-os/ui/components/skeleton";
import { Stat } from "@grasp-os/ui/components/stat";
import { api } from "@server/_generated/api";
import { createFileRoute } from "@tanstack/react-router";

import { RecordSale } from "../components/record-sale";
import { RevenueChart } from "../components/revenue-chart";
import { formatMoney } from "../lib/money";

const Figure = ({ label, value }: { label: string; value: string }) => (
  <Card size="sm">
    <CardHeader>
      <CardDescription>{label}</CardDescription>
    </CardHeader>
    <CardContent>
      <Stat>{value}</Stat>
    </CardContent>
  </Card>
);

const Dashboard = () => {
  const through = new Date().toISOString().slice(0, 7);
  const months = useQuery(api.months.lastYear, { through });
  const remove = useMutation(api.sales.remove);
  const thisMonth = months?.find(({ month }) => month === through);
  const revenue = thisMonth?.revenue ?? { currency: "EUR", minorUnits: 0 };
  const sales = thisMonth?.sales ?? 0;
  return (
    <main className="flex flex-col gap-6 p-6">
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>Sales</PageHeaderTitle>
        </PageHeaderContent>
        <PageHeaderActions>
          <RecordSale />
        </PageHeaderActions>
      </PageHeader>
      <Grid columns={3}>
        <Figure label="Revenue this month" value={formatMoney(revenue)} />
        <Figure label="Sales this month" value={String(sales)} />
        <Figure
          label="Average sale"
          value={formatMoney({
            ...revenue,
            minorUnits:
              sales === 0 ? 0 : Math.round(revenue.minorUnits / sales),
          })}
        />
      </Grid>
      <Card>
        <CardHeader>
          <CardTitle>Revenue by month</CardTitle>
        </CardHeader>
        <CardContent>
          {months === undefined ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <RevenueChart months={months} />
          )}
        </CardContent>
      </Card>
      <DataGrid
        args={() => ({})}
        columns={[
          "customer",
          "amount",
          { field: "closedAt", label: "Closed on", day: true },
        ]}
        label="Latest sales"
        query={api.sales.list}
        rowActions={[
          {
            label: "Remove",
            destructive: true,
            onSelect: async (sale) => await remove({ id: sale._id }),
          },
        ]}
      />
    </main>
  );
};

export const Route = createFileRoute("/")({ component: Dashboard });
