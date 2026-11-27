import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/app-kit/components/table";
import { usePaginatedQuery } from "@grasp-os/sdk/react";
import { api } from "@server/_generated/api";
import { createFileRoute, Link } from "@tanstack/react-router";

const Greeted = () => {
  const greetings = usePaginatedQuery(
    api.greeted.list,
    {},
    { initialPageSize: 25 }
  );
  return (
    <main className="flex flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold tracking-tight">Greeted</h1>
      <Table>
        <TableCaption>Greetings</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {greetings.items.map((greeting) => (
            <TableRow key={greeting._id}>
              <TableCell>{greeting.name}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Link to="/">Greet someone</Link>
    </main>
  );
};

export const Route = createFileRoute("/greeted")({ component: Greeted });
