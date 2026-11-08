import { useForm } from "@grasp-os/sdk/react";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@grasp-os/ui/components/dialog";
import {
  Form,
  FormError,
  SelectField,
  SubmitButton,
  TextareaField,
} from "@grasp-os/ui/form";
import { api } from "@server/_generated/api";
import type { Id } from "@server/_generated/dataModel";
import { useState } from "react";

export const Decide = ({
  id,
  title,
}: {
  id: Id<"requests">;
  title: string;
}) => {
  const [open, setOpen] = useState(false);
  const form = useForm(api.requests.decide, {
    defaultValues: { id, outcome: "approved", note: "" },
    onSuccess: () => {
      setOpen(false);
    },
  });
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger render={<Button size="sm" />}>Decide</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <Form aria-label="Decision" form={form}>
          <SelectField
            form={form}
            label="Decision"
            name="outcome"
            options={{ approved: "Approve", rejected: "Reject" }}
          />
          <TextareaField form={form} label="Note" name="note" />
          <FormError form={form} />
          <SubmitButton form={form}>Decide</SubmitButton>
        </Form>
      </DialogContent>
    </Dialog>
  );
};
