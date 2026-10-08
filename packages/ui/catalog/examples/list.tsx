// A list of records: a page header with its main action, one item per
// record with its status, and an empty state for when there are none.
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@grasp-os/ui/components/page-header";
import { Stack } from "@grasp-os/ui/components/stack";
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
  <Stack gap="lg">
    <PageHeader>
      <PageHeaderContent>
        <PageHeaderTitle>Invoices</PageHeaderTitle>
        <PageHeaderDescription>
          What customers owe, newest first.
        </PageHeaderDescription>
      </PageHeaderContent>
      <PageHeaderActions>
        <Button>
          <PlusIcon data-icon="inline-start" />
          New invoice
        </Button>
      </PageHeaderActions>
    </PageHeader>
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
  </Stack>
);
