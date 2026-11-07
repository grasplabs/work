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
  DateField,
  Form,
  FormError,
  NumberField,
  SubmitButton,
  TextField,
} from "@grasp-os/ui/form";
import { api } from "@server/_generated/api";
import { useState } from "react";

/** Today, as a date field holds it: the moment the day starts in UTC. */
const today = (): number => Date.parse(new Date().toISOString().slice(0, 10));

export const RecordSale = () => {
  const [open, setOpen] = useState(false);
  const form = useForm(api.sales.record, {
    defaultValues: { customer: "", amount: 0, closedAt: today() },
    resetOnSuccess: true,
    onSuccess: () => {
      setOpen(false);
    },
  });
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger render={<Button variant="highlight" />}>
        Record a sale
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New sale</DialogTitle>
        </DialogHeader>
        <Form aria-label="New sale" form={form}>
          <TextField form={form} label="Customer" name="customer" />
          <NumberField form={form} label="Amount in euros" name="amount" />
          <DateField form={form} label="Closed on" name="closedAt" />
          <FormError form={form} />
          <SubmitButton form={form}>Record sale</SubmitButton>
        </Form>
      </DialogContent>
    </Dialog>
  );
};
