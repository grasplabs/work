import { useForm } from "@grasp-os/sdk/react";
import { Grid } from "@grasp-os/ui/components/grid";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderContent,
  PageHeaderTitle,
} from "@grasp-os/ui/components/page-header";
import { Form, FormError, SubmitButton, TextField } from "@grasp-os/ui/form";
import { api } from "@server/_generated/api";
import { createFileRoute } from "@tanstack/react-router";

import { Column, columns } from "../components/column";

const AddCard = () => {
  const form = useForm(api.cards.add, {
    defaultValues: { title: "" },
    resetOnSuccess: true,
  });
  return (
    <Form aria-label="New card" className="flex-row items-end" form={form}>
      <TextField form={form} label="New card" name="title" />
      <SubmitButton form={form}>Add</SubmitButton>
      <FormError form={form} />
    </Form>
  );
};

const Board = () => (
  <main className="flex flex-col gap-6 p-6">
    <PageHeader>
      <PageHeaderContent>
        <PageHeaderTitle>Board</PageHeaderTitle>
      </PageHeaderContent>
      <PageHeaderActions>
        <AddCard />
      </PageHeaderActions>
    </PageHeader>
    <Grid columns={3}>
      {columns.map(({ id, title }) => (
        <Column id={id} key={id} title={title} />
      ))}
    </Grid>
  </main>
);

export const Route = createFileRoute("/")({ component: Board });
