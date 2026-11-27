// A list of records: a page header with its main action, one item per
// record with its status, and an empty state for when there are none.
import { Badge } from "@grasp-os/app-kit/components/badge";
import { Button } from "@grasp-os/app-kit/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@grasp-os/app-kit/components/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/app-kit/components/item";
import { ChevronRightIcon, PlusIcon } from "lucide-react";

interface Invoice {
  id: string;
  customer: string;
  due: string;
  status: "Paid" | "Due" | "Overdue";
}

const invoices: Invoice[] = [
  { id: "INV-104", customer: "Acme Corp", due: "12 Oct", status: "Due" },
  { id: "INV-103", customer: "Globex", due: "3 Oct", status: "Overdue" },
  { id: "INV-102", customer: "Initech", due: "28 Sep", status: "Paid" },
];

const statusVariant = {
  Paid: "secondary",
  Due: "outline",
  Overdue: "destructive",
} as const;

export const ListExample = () => (
  <div className="flex flex-col gap-6">
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-semibold tracking-tight">Invoices</h2>
        <p className="text-muted-foreground text-sm">
          What customers owe, newest first.
        </p>
      </div>
      <Button>
        <PlusIcon data-icon="inline-start" />
        New invoice
      </Button>
    </header>
    {invoices.length === 0 ? (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No invoices yet</EmptyTitle>
          <EmptyDescription>New invoices show up here.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    ) : (
      <ItemGroup>
        {invoices.map((invoice) => (
          <Item key={invoice.id} variant="outline">
            <ItemContent>
              <ItemTitle>{invoice.customer}</ItemTitle>
              <ItemDescription>
                {invoice.id}, due {invoice.due}
              </ItemDescription>
            </ItemContent>
            <ItemActions>
              <Badge variant={statusVariant[invoice.status]}>
                {invoice.status}
              </Badge>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Open ${invoice.id}`}
              >
                <ChevronRightIcon />
              </Button>
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
    )}
  </div>
);
