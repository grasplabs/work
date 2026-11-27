/**
 * Linking an organization to its customer in Grasp's Stripe, under its
 * Billing: a person at Grasp gives the customer's id as Stripe shows it
 * (`cus_...`), or unlinks it. Never matched by name or email
 * (src/billing/link.ts). Saved, audited, and the admin read again, so
 * Billing shows what Stripe says of the customer just linked.
 */
import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
import { Button } from "@grasp-os/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import { size, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";

import { setStripeCustomerFn } from "../billing/functions.ts";
import type { StripeLinkChange } from "../billing/functions.ts";
import type { StripeLinkErrorCode } from "../billing/link.ts";
import { thenRefresh, useAction } from "../use-action.ts";

const styles = stylex.create({
  // The form in a measure a field can be read at.
  form: {
    display: "flex",
    flexDirection: "column",
    gap: space["3"],
    maxWidth: size.formWidth,
  },
  buttons: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["3"],
  },
});

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
      {...stylex.props(styles.form)}
      onSubmit={(event) => {
        event.preventDefault();
        const value = new FormData(event.currentTarget).get("customerId");
        save(typeof value === "string" ? value.trim() : "");
      }}
    >
      <Field>
        <FieldLabel>Its customer in Stripe</FieldLabel>
        <Input
          defaultValue={customerId ?? ""}
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
      <div {...stylex.props(styles.buttons)}>
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
            variant="outline"
          >
            Unlink
          </Button>
        )}
      </div>
      {failure === null ? null : (
        <Alert appearance="subtle" variant="destructive">
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      )}
    </form>
  );
};
