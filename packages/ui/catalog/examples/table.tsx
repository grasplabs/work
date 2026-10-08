// A table of records: a labelled search above it, a caption that names it,
// numbers aligned right, and pages below it. The table scrolls sideways on
// a narrow screen instead of the page.
import { Badge } from "@grasp-os/ui/components/badge";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@grasp-os/ui/components/input-group";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@grasp-os/ui/components/pagination";
import { Stack } from "@grasp-os/ui/components/stack";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { SearchIcon } from "lucide-react";

const orders = [
  {
    id: "1042",
    customer: "Acme Corp",
    items: 3,
    total: "€1,250.00",
    status: "Shipped",
  },
  {
    id: "1041",
    customer: "Globex",
    items: 1,
    total: "€89.00",
    status: "Packing",
  },
  {
    id: "1040",
    customer: "Initech",
    items: 12,
    total: "€4,310.00",
    status: "Shipped",
  },
] as const;

export const TableExample = () => (
  <Stack>
    <InputGroup>
      <InputGroupAddon>
        <SearchIcon />
      </InputGroupAddon>
      <InputGroupInput aria-label="Search orders" placeholder="Search orders" />
    </InputGroup>
    <Table>
      <TableCaption>Orders this week</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Order</TableHead>
          <TableHead>Customer</TableHead>
          <TableHead className="text-right">Items</TableHead>
          <TableHead className="text-right">Total</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {orders.map((order) => (
          <TableRow key={order.id}>
            <TableCell>
              <span className="font-medium">{order.id}</span>
            </TableCell>
            <TableCell>{order.customer}</TableCell>
            <TableCell>
              <span className="block text-right tabular-nums">
                {order.items}
              </span>
            </TableCell>
            <TableCell>
              <span className="block text-right tabular-nums">
                {order.total}
              </span>
            </TableCell>
            <TableCell>
              <Badge
                variant={order.status === "Shipped" ? "secondary" : "outline"}
              >
                {order.status}
              </Badge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
    <Pagination>
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious href="#orders-page-1" />
        </PaginationItem>
        <PaginationItem>
          <PaginationLink href="#orders-page-1" isActive>
            1
          </PaginationLink>
        </PaginationItem>
        <PaginationItem>
          <PaginationLink href="#orders-page-2">2</PaginationLink>
        </PaginationItem>
        <PaginationItem>
          <PaginationNext href="#orders-page-2" />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  </Stack>
);
