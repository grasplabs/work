import {
  RecordGrid,
  RecordGridHeader,
  RecordGridValue,
} from "@grasp-os/app-kit/components/record-grid";
import type { RecordGridColumn } from "@grasp-os/app-kit/components/record-grid";
import { HashIcon, TypeIcon } from "lucide-react";
import type { ComponentType } from "react";

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

export const recordGridDemos: Record<string, ComponentType> = {
  "record-grid": RecordGridDemo,
};
