/**
 * Linking an organization to its customer in Grasp's Stripe, under its
 * Billing: a person at Grasp gives the customer's id as Stripe shows it
 * (`cus_...`), or unlinks it. Never matched by name or email
 * (src/billing/link.ts). Saved, audited, and the admin read again, so
 * Billing shows what Stripe says of the customer just linked.
 */
import { Button } from "@grasp-os/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import { useRouter } from "@tanstack/react-router";

import { setStripeCustomerFn } from "../billing/functions.ts";
import type { StripeLinkChange } from "../billing/functions.ts";
import type { StripeLinkErrorCode } from "../billing/link.ts";
import { thenRefresh, useAction } from "../use-action.ts";

/** What staff read when linking is refused, by its code. */
const refusals: Readonly<Record<StripeLinkErrorCode, string>> = {
  unknown_client: "There’s no such organization.",
  customer_id_invalid:
    "That isn’t a Stripe customer’s id: it starts with cus_, as Stripe shows it on the customer’s page.",
};

/** The form: the linked customer's id, to save, change or take away. */
export const StripeLink = ({
  clientId,
  customerId,
}: {
  clientId: string;
  customerId: string | null;
}) => {
  const router = useRouter();
  const { busy, failure, run } = useAction(refusals);
  const save = (next: string | null) => {
    void run(
      async (): Promise<StripeLinkChange> =>
        await thenRefresh(
          async () =>
            await setStripeCustomerFn({
              data: { clientId, customerId: next },
            }),
          async () => {
            await router.invalidate({ sync: true });
          }
        )
    );
  };
  return (
    <form
      className="flex flex-col gap-3 border-t px-5 py-4"
      onSubmit={(event) => {
        event.preventDefault();
        const value = new FormData(event.currentTarget).get("customerId");
        save(typeof value === "string" ? value.trim() : "");
      }}
    >
      <Field>
        <FieldLabel htmlFor={`stripe-${clientId}`}>
          Its customer in Stripe
        </FieldLabel>
        <Input
          defaultValue={customerId ?? ""}
          id={`stripe-${clientId}`}
          // Keyed by the link: the field starts again from it after a save.
          key={customerId ?? ""}
          maxLength={254}
          name="customerId"
          pattern="cus_[A-Za-z0-9]+"
          placeholder="cus_..."
          required
        />
        <FieldDescription>
          The customer’s id, as Stripe shows it on the customer’s page. Check it
          is this company: its invoices show here.
        </FieldDescription>
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={busy} size="sm" type="submit" variant="outline">
          {customerId === null ? "Link" : "Save"}
        </Button>
        {customerId === null ? null : (
          <Button
            disabled={busy}
            onClick={() => {
              save(null);
            }}
            size="sm"
            type="button"
            variant="ghost"
          >
            Unlink
          </Button>
        )}
        {failure === null ? null : (
          <p className="text-destructive text-sm" role="alert">
            {failure}
          </p>
        )}
      </div>
    </form>
  );
};
