import { DataGrid } from "@grasp-os/ui/components/data-grid";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderContent,
  PageHeaderTitle,
} from "@grasp-os/ui/components/page-header";
import { api } from "@server/_generated/api";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { AddContact } from "../components/add-contact";
import { Pipeline } from "../components/pipeline";

const Contacts = () => {
  const navigate = useNavigate();
  return (
    <main className="flex flex-col gap-6 p-6">
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>Contacts</PageHeaderTitle>
        </PageHeaderContent>
        <PageHeaderActions>
          <AddContact />
        </PageHeaderActions>
      </PageHeader>
      <Pipeline />
      <DataGrid
        args={({ search }) => ({ search })}
        columns={["name", "company", "email"]}
        label="Contacts"
        query={api.contacts.list}
        rowActions={[
          {
            label: "Open",
            onSelect: async (contact) =>
              await navigate({
                to: "/contacts/$contactId",
                params: { contactId: contact._id },
              }),
          },
        ]}
        search="Search contacts"
      />
    </main>
  );
};

export const Route = createFileRoute("/")({ component: Contacts });
