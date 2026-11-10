import { useForm } from "@grasp-os/runtime/react";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@grasp-os/ui/components/dialog";
import { Form, FormError, SubmitButton, TextField } from "@grasp-os/ui/form";
import { api } from "@server/_generated/api";
import { useState } from "react";

export const AddContact = () => {
  const [open, setOpen] = useState(false);
  const form = useForm(api.contacts.add, {
    defaultValues: { name: "", company: "" },
    resetOnSuccess: true,
    onSuccess: () => {
      setOpen(false);
    },
  });
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger render={<Button />}>Add contact</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New contact</DialogTitle>
        </DialogHeader>
        <Form aria-label="New contact" form={form}>
          <TextField form={form} label="Name" name="name" />
          <TextField form={form} label="Company" name="company" />
          <TextField form={form} label="Email" name="email" />
          <FormError form={form} />
          <SubmitButton form={form}>Add contact</SubmitButton>
        </Form>
      </DialogContent>
    </Dialog>
  );
};
