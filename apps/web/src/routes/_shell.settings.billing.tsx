import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@grasp-os/ui/components/alert";
import { Button } from "@grasp-os/ui/components/button";
import { Switch } from "@grasp-os/ui/components/switch";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";
import { ExternalLinkIcon, InfoIcon } from "lucide-react";

import {
  SettingsError,
  SettingsRow,
  SettingsSection,
} from "../settings/settings-parts.tsx";

// Settings → Billing, for admins, as in the prototype
// (`routes/settings/billing.tsx`): the plan, the card, the billing details
// and the invoices, as Stripe keeps them, every change made in Stripe's
// billing portal. Core has no link to Stripe yet, so this is the
// prototype's page before Stripe is linked: what can be seen, with nothing
// in it, and every way into Stripe shown but not usable.

/** A way into Stripe's billing portal; shown but not usable without the link. */
const StripeButton = ({ label }: { label: string }) => (
  <Button disabled size="sm" variant="outline">
    {label}
    <ExternalLinkIcon data-icon="inline-end" />
  </Button>
);

/** What a row shows while Stripe keeps nothing for it. */
const Nothing = () => (
  <span className="text-muted-foreground">
    <Trans context="nothing set">None</Trans>
  </span>
);

const Billing = () => {
  const { t } = useLingui();
  return (
    <>
      <Alert>
        <InfoIcon />
        <AlertTitle>
          <Trans>Stripe is not linked yet</Trans>
        </AlertTitle>
        <AlertDescription>
          <Trans>Until it is, billing can be seen here but not changed.</Trans>
        </AlertDescription>
      </Alert>

      <SettingsSection
        action={<StripeButton label={t`Change plan`} />}
        description={t`Billing runs through Stripe. You see it here and change it there.`}
        title={t`Plan`}
      >
        <SettingsRow
          description={t`What the workspace pays for Grasp.`}
          label={t`Current plan`}
        >
          <Nothing />
        </SettingsRow>
        <SettingsRow
          description={t`Nothing is due while the plan is not running.`}
          label={t`Next invoice`}
        >
          <Nothing />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        action={<StripeButton label={t`Add a card`} />}
        description={t`The card Stripe charges for each invoice.`}
        title={t`Payment method`}
      >
        <SettingsRow
          description={t`Add one so invoices are paid when they come.`}
          label={t`Card`}
        >
          <span className="text-muted-foreground">
            <Trans>No card on file</Trans>
          </span>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        action={<StripeButton label={t`Edit details`} />}
        description={t`What appears on every invoice.`}
        title={t`Billing details`}
      >
        <SettingsRow
          description={t`Invoices and receipts go here.`}
          label={t`Billing email`}
        >
          <Nothing />
        </SettingsRow>
        <SettingsRow label={t`Company`}>
          <Nothing />
        </SettingsRow>
        <SettingsRow label={t`Address`}>
          <Nothing />
        </SettingsRow>
        <SettingsRow
          description={t`Your company’s VAT number, as invoices show it.`}
          label={t`VAT number`}
        >
          <Nothing />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        description={t`What Stripe emails to the billing email.`}
        title={t`Billing emails`}
      >
        <SettingsRow
          description={t`Each invoice as a PDF, as soon as it is issued.`}
          htmlFor="billing-email-invoices"
          label={t`Invoices`}
        >
          <Switch checked={false} disabled id="billing-email-invoices" />
        </SettingsRow>
        <SettingsRow
          description={t`A receipt each time a payment goes through.`}
          htmlFor="billing-email-receipts"
          label={t`Payment receipts`}
        >
          <Switch checked={false} disabled id="billing-email-receipts" />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        action={<StripeButton label={t`All invoices`} />}
        description={t`No invoices yet.`}
        title={t`Invoices`}
      />
    </>
  );
};

export const Route = createFileRoute("/_shell/settings/billing")({
  errorComponent: SettingsError,
  component: Billing,
});
