import { noBilling } from "@grasp-os/shared/org-settings";
import { Button } from "@grasp-os/ui/components/button";
import { FieldGroup } from "@grasp-os/ui/components/field";
import { Switch } from "@grasp-os/ui/components/switch";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute, Link } from "@tanstack/react-router";

import { NotLoadedState } from "../frame/page-states.tsx";
import { PageSkeletonSettings } from "../frame/skeletons/settings.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { BillingCard } from "../settings/billing-card.tsx";
import { useQueuedSave } from "../settings/queued-save.ts";
import { ReadOnlyRow } from "../settings/read-only-row.tsx";
import {
  RowAlert,
  SettingRow,
  SettingsError,
  SettingsGroup,
} from "../settings/section.tsx";

// Settings → Billing, for admins: the billing details as a card at its
// head (settings/billing-card.tsx), their form in a dialog from its one
// button; the plan, with the way to what AI costs (on AI and spend, not
// repeated here); and which billing emails go out. Core keeps the
// billing details (`orgSettings.billing()`), which the organization's own
// admins change here, each field saved as it is left; Grasp staff read
// them. No payment
// provider is linked yet, so there is no plan, card or invoice, and no
// way into Stripe: what would only lead there is left out until it is.
// Which emails Stripe sends is kept with the details.

/** The plan: none until Grasp links Stripe and sets one up. */
const Plan = () => {
  const { t } = useLingui();
  return (
    <SettingsGroup flush title={t`Plan`}>
      <FieldGroup>
        <ReadOnlyRow
          help={t`Grasp sets it up with you`}
          label={t`Current plan`}
          value={t`None yet`}
        />
        {/* What AI costs this month stands on its own page: the way there. */}
        <SettingRow help={t`What AI costs this month`} label={t`AI spend`}>
          <Button asChild size="sm" variant="outline">
            <Link to="/settings/ai-providers">{t`AI and spend`}</Link>
          </Button>
        </SettingRow>
      </FieldGroup>
    </SettingsGroup>
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
      <SettingsGroup title={t`Plan`}>
        <NotLoadedState heading="h3" page={page} />
      </SettingsGroup>
    );
  }
  // Only the organization's own admins change them; Grasp staff read them.
  const readOnly = identity.staff;
  return (
    <>
      <BillingCard billing={billing} canChange={!readOnly} save={save} />
      <Plan />
      <SettingsGroup flush title={t`Billing emails`}>
        <FieldGroup controls="fit">
          {failure === undefined ? null : (
            <RowAlert variant="destructive">{failure}</RowAlert>
          )}
          <SettingRow
            help={t`Each invoice to your billing email`}
            label={t`Email invoices`}
          >
            <Switch
              checked={billing.emailInvoices}
              aria-label={t`Email invoices`}
              onCheckedChange={(emailInvoices) => {
                void save({ emailInvoices });
              }}
              readOnly={readOnly}
            />
          </SettingRow>
          <SettingRow
            help={t`A receipt for each payment`}
            label={t`Email payment receipts`}
          >
            <Switch
              checked={billing.emailReceipts}
              aria-label={t`Email payment receipts`}
              onCheckedChange={(emailReceipts) => {
                void save({ emailReceipts });
              }}
              readOnly={readOnly}
            />
          </SettingRow>
        </FieldGroup>
      </SettingsGroup>
    </>
  );
};

/** The billing details' card, the plan, then the billing emails. */
const BillingPending = () => (
  <PageSkeletonSettings sections={[{ rows: 2, title: false }, 2, 2]} />
);

export const Route = createFileRoute("/_shell/settings/billing")({
  pendingComponent: BillingPending,
  errorComponent: SettingsError,
  component: BillingPage,
  loader: async ({ context: { core } }) =>
    await loadFromCore(core, async (session) => ({
      billing: await session.orgSettings.billing(),
    })),
});
