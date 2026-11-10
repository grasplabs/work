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
  NumberField,
  SubmitButton,
  TextareaField,
  TextField,
} from "@grasp-os/ui/form";
import { api } from "@server/_generated/api";
import { useState } from "react";

export const NewRequest = () => {
  const [open, setOpen] = useState(false);
  const form = useForm(api.requests.submit, {
    defaultValues: { title: "", details: "", amount: 0 },
    resetOnSuccess: true,
    onSuccess: () => {
      setOpen(false);
    },
  });
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger render={<Button variant="highlight" />}>
        New request
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New request</DialogTitle>
        </DialogHeader>
        <Form aria-label="New request" form={form}>
          <TextField form={form} label="What for" name="title" />
          <NumberField form={form} label="Amount in euros" name="amount" />
          <TextareaField form={form} label="Why" name="details" />
          <FormError form={form} />
          <SubmitButton form={form}>Ask for approval</SubmitButton>
        </Form>
      </DialogContent>
    </Dialog>
  );
};
