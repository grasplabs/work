import { DataGrid } from "@grasp-os/app-kit/components/data-grid";
import { api } from "@server/_generated/api";
import { createFileRoute, Link } from "@tanstack/react-router";

const Greeted = () => (
  <main className="flex flex-col gap-6 p-6">
    <h1 className="text-2xl font-semibold tracking-tight">Greeted</h1>
    <DataGrid
      args={() => ({})}
      columns={["name"]}
      label="Greetings"
      query={api.greeted.list}
    />
    <Link to="/">Greet someone</Link>
  </main>
);

export const Route = createFileRoute("/greeted")({ component: Greeted });
