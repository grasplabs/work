import { useForm, useMutation, useQuery } from "@grasp-os/sdk/react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@grasp-os/ui/components/card";
import { DataGrid } from "@grasp-os/ui/components/data-grid";
import {
  PageHeader,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@grasp-os/ui/components/page-header";
import { Skeleton } from "@grasp-os/ui/components/skeleton";
import {
  Form,
  FormError,
  NumberField,
  SubmitButton,
  TextField,
} from "@grasp-os/ui/form";
import { api } from "@server/_generated/api";
import type { Id } from "@server/_generated/dataModel";
import { createFileRoute, Link } from "@tanstack/react-router";

import { stages } from "../components/stages";

const AddDeal = ({ contact }: { contact: Id<"contacts"> }) => {
  const form = useForm(api.deals.add, {
    defaultValues: { contact, title: "", amount: 0 },
    resetOnSuccess: true,
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>New deal</CardTitle>
      </CardHeader>
      <CardContent>
        <Form aria-label="New deal" form={form}>
          <TextField form={form} label="Title" name="title" />
          <NumberField form={form} label="Value in euros" name="amount" />
          <FormError form={form} />
          <SubmitButton form={form}>Add deal</SubmitButton>
        </Form>
      </CardContent>
    </Card>
  );
};

const Contact = () => {
  const { contactId } = Route.useParams();
  const contact = useQuery(api.contacts.get, { id: contactId });
  const setStage = useMutation(api.deals.setStage);
  if (contact === undefined) {
    return <Skeleton className="m-6 h-9 w-64" />;
  }
  if (contact === null) {
    return (
      <main className="flex flex-col gap-2 p-6">
        <p>This contact is gone.</p>
        <Link to="/">Back to contacts</Link>
      </main>
    );
  }
  return (
    <main className="flex flex-col gap-6 p-6">
      <Link to="/">All contacts</Link>
      <PageHeader>
        <PageHeaderContent>
          <PageHeaderTitle>{contact.name}</PageHeaderTitle>
          <PageHeaderDescription>
            {[contact.company, contact.email].filter(Boolean).join(" · ")}
          </PageHeaderDescription>
        </PageHeaderContent>
      </PageHeader>
      <DataGrid
        args={() => ({ contact: contact._id })}
        columns={[
          "title",
          { field: "value", label: "Value" },
          {
            field: "stage",
            cell: (deal) => stages[deal.stage],
            edit: async (deal, stage) =>
              await setStage({ id: deal._id, stage }),
          },
          { field: "_createdAt", label: "Opened", day: true },
        ]}
        label="Deals"
        query={api.deals.forContact}
      />
      <AddDeal contact={contact._id} />
    </main>
  );
};

export const Route = createFileRoute("/contacts/$contactId")({
  // The ID is text from the address: the server checks it on every call.
  params: {
    parse: ({ contactId }) => ({ contactId: contactId as Id<"contacts"> }),
  },
  component: Contact,
});
