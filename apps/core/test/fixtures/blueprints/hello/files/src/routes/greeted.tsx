import { DataGrid } from "@grasp-os/app-kit/components/data-grid";
import {
  PageHeader,
  PageHeaderContent,
  PageHeaderTitle,
} from "@grasp-os/app-kit/components/page-header";
import { api } from "@server/_generated/api";
import { createFileRoute, Link } from "@tanstack/react-router";

const Greeted = () => (
  <main className="flex flex-col gap-6 p-6">
    <PageHeader>
      <PageHeaderContent>
        <PageHeaderTitle>Greeted</PageHeaderTitle>
      </PageHeaderContent>
    </PageHeader>
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
