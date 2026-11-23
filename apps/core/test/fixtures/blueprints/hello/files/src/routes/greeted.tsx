import { Button } from "@grasp-os/app-kit/components/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/app-kit/components/table";
import { usePaginatedQuery } from "@grasp-os/sdk/react";
import { api } from "@server/_generated/api";
import { createFileRoute, Link } from "@tanstack/react-router";

const Greeted = () => {
  const greeted = usePaginatedQuery(
    api.greeted.list,
    {},
    { initialPageSize: 25 }
  );
  return (
    <main className="flex flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Greeted</h1>
      <Table aria-label="Greetings">
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {greeted.items.map((greeting) => (
            <TableRow key={greeting._id}>
              <TableCell>{greeting.name}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {greeted.hasMore ? (
        <Button
          disabled={greeted.isLoading}
          onClick={() => {
            greeted.loadMore();
          }}
          variant="outline"
        >
          Load more
        </Button>
      ) : null}
      <Link to="/">Greet someone</Link>
    </main>
  );
};

export const Route = createFileRoute("/greeted")({ component: Greeted });
