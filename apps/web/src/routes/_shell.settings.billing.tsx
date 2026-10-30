import { failureText } from "@grasp-os/shared/errors";
import { noBilling } from "@grasp-os/shared/org-settings";
import { roleErrors } from "@grasp-os/shared/roles";
import type { MonthBilled } from "@grasp-os/shared/stephen-requests";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@grasp-os/ui/components/alert";
import { Button } from "@grasp-os/ui/components/button";
import { Switch } from "@grasp-os/ui/components/switch";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ExternalLinkIcon, InfoIcon } from "lucide-react";

import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatNumber } from "../format.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { useQueuedSave } from "../settings/queued-save.ts";
import { SavedField } from "../settings/saved-field.tsx";
import {
  SettingsError,
  SettingsLoading,
  SettingsRow,
  SettingsSection,
} from "../settings/settings-parts.tsx";

// Settings → Billing, for admins, as in the prototype
// (`routes/settings/billing.tsx`): the plan, the card, the billing details
// and the invoices. Core keeps the billing details and which billing
// emails go out (`orgSettings.billing()`), which the organization's own
// admins change here, each field saved as it is left. No payment provider
// is linked yet, so there is no plan, card or invoice, and every way into
// Stripe is shown but not usable. Beside the plan, Stephen's requests
// outside Grasp this month, which the plan bills, with the way to how they
// are used: left out when core refuses them to the viewer, and saying why
// when they can't be read otherwise.

/** Stephen's requests this month as the page read them: the count, refused to the viewer, or why not read. */
type RequestsRead =
  | { state: "ready"; billed: MonthBilled }
  | { state: "refused" }
  | { state: "failed"; reason: string };

/**
 * Reads Stephen's requests this month on its own, so the page stands
 * without them: core refuses them to whoever may not see them.
 */
const readRequests = async (session: Session): Promise<RequestsRead> => {
  try {
    return { state: "ready", billed: await session.stephenRequests.billed() };
  } catch (error) {
    if (roleErrors.codeOf(error) === "role.forbidden") {
      return { state: "refused" };
    }
    return { state: "failed", reason: failureText(error) };
  }
};

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

/** Stephen's requests outside Grasp this month, against what the plan includes when it says; or why they can't be read. */
const RequestsRow = ({
  requests,
}: {
  requests: Exclude<RequestsRead, { state: "refused" }>;
}) => {
  const { t } = useLingui();
  if (requests.state === "failed") {
    return (
      <SettingsRow label={t`Stephen’s requests`}>
        <ErrorText>{requests.reason}</ErrorText>
      </SettingsRow>
    );
  }
  const used = formatNumber(requests.billed.billed);
  const { included } = requests.billed;
  const of = included === null ? "" : formatNumber(included);
  return (
    <SettingsRow
      description={
        included === null
          ? t`Outside Grasp this month.`
          : t`Outside Grasp this month, against what the plan includes.`
      }
      label={t`Stephen’s requests`}
    >
      <span className="flex items-center gap-3">
        <span className="tabular-nums">
          {included === null ? used : t`${used} of ${of}`}
        </span>
        <Button
          nativeButton={false}
          render={<Link to="/workflows/requests" />}
          size="sm"
          variant="outline"
        >
          {t`See usage`}
        </Button>
      </span>
    </SettingsRow>
  );
};

const BillingPage = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  const billing = page.state === "ready" ? page.data.billing : noBilling;
  const { failure, save } = useQueuedSave(
    billing,
    async (session, next) => await session.orgSettings.updateBilling(next)
  );
  if (page.state !== "ready") {
    return (
      <SettingsSection title={t`Billing`}>
        <NotLoadedState heading="h3" page={page} />
      </SettingsSection>
    );
  }
  // Only the organization's own admins change them; Grasp staff read them.
  const disabled = identity.staff;
  return (
    <>
      <Alert>
        <InfoIcon />
        <AlertTitle>
          <Trans>Stripe is not linked yet</Trans>
        </AlertTitle>
        <AlertDescription>
          <Trans>
            Until it is, there is no plan, card or invoice. The billing details
            and emails below are kept for when it is.
          </Trans>
        </AlertDescription>
      </Alert>
      <ErrorText>{failure}</ErrorText>

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
        {page.data.requests.state === "refused" ? null : (
          <RequestsRow requests={page.data.requests} />
        )}
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
        description={t`What appears on every invoice.`}
        title={t`Billing details`}
      >
        <SettingsRow
          description={t`Invoices and receipts go here.`}
          htmlFor="billing-email"
          label={t`Billing email`}
        >
          <SavedField
            disabled={disabled}
            id="billing-email"
            maxLength={254}
            onSave={(email) => {
              save({ email });
            }}
            type="email"
            value={billing.email}
          />
        </SettingsRow>
        <SettingsRow htmlFor="billing-company" label={t`Company`}>
          <SavedField
            disabled={disabled}
            id="billing-company"
            maxLength={120}
            onSave={(company) => {
              save({ company });
            }}
            value={billing.company}
          />
        </SettingsRow>
        <SettingsRow htmlFor="billing-address" label={t`Address`}>
          <SavedField
            disabled={disabled}
            id="billing-address"
            maxLength={500}
            multiline
            onSave={(address) => {
              save({ address });
            }}
            value={billing.address}
          />
        </SettingsRow>
        <SettingsRow
          description={t`Your company’s VAT number, as invoices show it.`}
          htmlFor="billing-vat"
          label={t`VAT number`}
        >
          <SavedField
            disabled={disabled}
            id="billing-vat"
            maxLength={14}
            onSave={(vatNumber) => {
              save({ vatNumber });
            }}
            value={billing.vatNumber}
          />
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
          <Switch
            checked={billing.emailInvoices}
            disabled={disabled}
            id="billing-email-invoices"
            onCheckedChange={(emailInvoices) => {
              save({ emailInvoices });
            }}
          />
        </SettingsRow>
        <SettingsRow
          description={t`A receipt each time a payment goes through.`}
          htmlFor="billing-email-receipts"
          label={t`Payment receipts`}
        >
          <Switch
            checked={billing.emailReceipts}
            disabled={disabled}
            id="billing-email-receipts"
            onCheckedChange={(emailReceipts) => {
              save({ emailReceipts });
            }}
          />
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
  pendingComponent: SettingsLoading,
  errorComponent: SettingsError,
  component: BillingPage,
  loader: async ({ context: { core } }) =>
    await loadFromCore(core, async (session) => {
      const [billing, requests] = await Promise.all([
        session.orgSettings.billing(),
        readRequests(session),
      ]);
      return { billing, requests };
    }),
});
