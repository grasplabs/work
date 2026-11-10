import {
  paginationOptionsValidator,
  paginationResultValidator,
  v,
} from "@grasp-os/runtime/app";
import type {
  Infer,
  InferInput,
  FunctionReference,
} from "@grasp-os/runtime/app";
import { GraspClient } from "@grasp-os/runtime/page";
import { GraspProvider } from "@grasp-os/runtime/react";
import { DataGrid } from "@grasp-os/ui/components/data-grid";
import {
  RecordGrid,
  RecordGridHeader,
  RecordGridValue,
} from "@grasp-os/ui/components/record-grid";
import type { RecordGridColumn } from "@grasp-os/ui/components/record-grid";
import { Skeleton } from "@grasp-os/ui/components/skeleton";
import { HashIcon, TypeIcon } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import type { ComponentType } from "react";

// The data grid over a stand-in App: its query answers a fixed list of
// people from memory, searched and filtered as an App's query would, so
// the gallery shows the grid working without a host behind it.

const person = v.object({
  _id: v.string(),
  name: v.string(),
  team: v.enum(["sales", "support"]),
  active: v.boolean(),
});

const args = v.object({
  pagination: paginationOptionsValidator,
  search: v.string(),
  team: v.enum(["sales", "support"]).optional(),
});

const page = paginationResultValidator(person);

const listPeople: FunctionReference<
  "query",
  "public",
  InferInput<typeof args>,
  Infer<typeof page>
> = { name: "people.list" };

/** The demo's functions, as a page's build hands them its client. */
const functions = {
  "people.list": {
    kind: "query",
    args: args.descriptor,
    returns: page.descriptor,
  },
};

const people = [
  "Ada",
  "Grace",
  "Linus",
  "Margaret",
  "Ken",
  "Barbara",
  "Dennis",
].map((name, index) => ({
  _id: String(index),
  name,
  team: index % 2 === 0 ? ("sales" as const) : ("support" as const),
  active: index % 3 !== 0,
}));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** A window of the people `body` asks for, searched and filtered, as core would push it. */
const pageFor = (body: string) => {
  const request: unknown = JSON.parse(body);
  const sent = isRecord(request) && isRecord(request.args) ? request.args : {};
  const window =
    isRecord(request) && isRecord(request.window) ? request.window : {};
  const extent =
    typeof window.extent === "number" ? window.extent : people.length;
  const search =
    typeof sent.search === "string" ? sent.search.toLowerCase() : "";
  const found = people.filter(
    (each) =>
      each.name.toLowerCase().includes(search) &&
      (sent.team === undefined || each.team === sent.team)
  );
  const hasMore = found.length > extent;
  return {
    items: found.slice(0, extent),
    hasMore,
    nextCursor: hasMore ? "more" : null,
  };
};

const demoClient = (): GraspClient =>
  new GraspClient(
    {
      call: async () => {
        await Promise.resolve();
        throw new Error("The demo saves nothing.");
      },
      watch: async (body, onSnapshot) => {
        await Promise.resolve();
        onSnapshot({ revision: 1, result: { ok: true, value: pageFor(body) } });
        return {
          release: () => {
            // Nothing to let go of: the demo pushes once.
          },
        };
      },
    },
    functions
  );

const noChange = (): (() => void) => () => {
  // Whether this is a browser never changes.
};

const DataGridDemo = () => {
  // One client for the demo's life.
  // oxlint-disable-next-line react/hook-use-state -- see above
  const [client] = useState(demoClient);
  // A live list follows its query in the browser; rendered on a server
  // (the gallery's smoke test), it shows a placeholder.
  const inBrowser = useSyncExternalStore(
    noChange,
    () => true,
    () => false
  );
  if (!inBrowser) {
    return <Skeleton className="h-40 w-full" />;
  }
  return (
    <GraspProvider client={client}>
      <DataGrid
        args={({ search, filters }) => ({ search, team: filters.team })}
        bulkActions={[{ label: "Archive", onSelect: () => null }]}
        columns={[
          "name",
          { field: "team", filter: { sales: "Sales", support: "Support" } },
          "active",
        ]}
        label="People"
        pageSize={3}
        query={listPeople}
        rowActions={[{ label: "Open", onSelect: () => null }]}
        search="Search people"
      />
    </GraspProvider>
  );
};

/** A hundred thousand orders: only those in view are drawn. */
const orders = Array.from({ length: 100_000 }, (_, index) => ({
  id: `order-${index + 1}`,
  customer: ["Ada", "Grace", "Alan", "Edsger"][index % 4] ?? "",
  amount: (index * 37) % 1000,
}));

/** The orders' columns: a required customer, and an amount. */
const orderColumns: RecordGridColumn<(typeof orders)[number]>[] = [
  {
    id: "customer",
    header: (
      <RecordGridHeader icon={<TypeIcon />} required requiredLabel="Required">
        customer
      </RecordGridHeader>
    ),
    cell: (order) => <RecordGridValue>{order.customer}</RecordGridValue>,
  },
  {
    id: "amount",
    width: 140,
    header: <RecordGridHeader icon={<HashIcon />}>amount</RecordGridHeader>,
    cell: (order) => <RecordGridValue>{order.amount}</RecordGridValue>,
  },
];

const RecordGridDemo = () => (
  <div className="flex h-80 flex-col border">
    <RecordGrid
      columns={orderColumns}
      label="Orders"
      rowKey={(order) => order.id}
      rows={orders}
    />
  </div>
);

export const dataGridDemos: Record<string, ComponentType> = {
  "data-grid": DataGridDemo,
  "record-grid": RecordGridDemo,
};
