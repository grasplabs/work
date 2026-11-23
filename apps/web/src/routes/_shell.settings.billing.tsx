import { noBilling } from "@grasp-os/shared/org-settings";
import { Button } from "@grasp-os/ui/components/button";
import { FieldGroup } from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import { Switch } from "@grasp-os/ui/components/switch";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute, Link } from "@tanstack/react-router";

import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { BillingCard } from "../settings/billing-card.tsx";
import { useQueuedSave } from "../settings/queued-save.ts";
import {
  FactRow,
  Failure,
  SettingRow,
  SettingsError,
  SettingsGroup,
  SettingsPending,
  SettingsRows,
  SettingsStack,
} from "../settings/section.tsx";

// Settings › Billing, for admins: the billing details as a card at its
// head (settings/billing-card.tsx), their form in a dialog from its one
// button; the plan, with the way to what AI costs (on AI and spend, not
// repeated here); and which billing emails go out. Core keeps the billing
// details (`orgSettings.billing()`), which the organization's own admins
// change here; Grasp staff read them. No payment provider is linked yet,
// so there is no plan, card or invoice, and no way into Stripe: what would
// only lead there is left out until it is. Which emails Stripe sends is
// kept with the details, each switch saved as it is flipped.

/** The plan: none until Grasp links Stripe and sets one up. */
const Plan = () => {
  const { t } = useLingui();
  return (
    <SettingsGroup title={t`Plan`}>
      <SettingsRows>
        <SettingRow help={t`Grasp sets it up with you`} label={t`Current plan`}>
          <Input readOnly size="sm" value={t`None yet`} />
        </SettingRow>
        {/* What AI costs this month stands on its own page: the way there. */}
        <FactRow help={t`What AI costs this month`} label={t`AI spend`}>
          <Button asChild size="sm" variant="secondary">
            <Link to="/settings/ai-providers">{t`AI and spend`}</Link>
          </Button>
        </FactRow>
      </SettingsRows>
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
      <SettingsGroup flush={false} title={t`Plan`}>
        <NotLoadedState heading="h3" page={page} />
      </SettingsGroup>
    );
  }
  // Only the organization's own admins change them; Grasp staff read them.
  const readOnly = identity.staff;
  return (
    <SettingsStack>
      <BillingCard billing={billing} canChange={!readOnly} />
      <Plan />
      <SettingsGroup title={t`Billing emails`}>
        <FieldGroup controls="fit">
          <SettingRow
            help={t`Each invoice to your billing email`}
            label={t`Email invoices`}
          >
            <Switch
              checked={billing.emailInvoices}
              onCheckedChange={(emailInvoices) => {
                save({ emailInvoices });
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
              onCheckedChange={(emailReceipts) => {
                save({ emailReceipts });
              }}
              readOnly={readOnly}
            />
          </SettingRow>
        </FieldGroup>
        <Failure>{failure}</Failure>
      </SettingsGroup>
    </SettingsStack>
  );
};

/** The billing details' card, the plan, then the billing emails. */
const BillingPending = () => <SettingsPending groups={[2, 2, 2]} />;

export const Route = createFileRoute("/_shell/settings/billing")({
  pendingComponent: BillingPending,
  errorComponent: SettingsError,
  component: BillingPage,
  loader: async ({ context: { core } }) =>
    await loadFromCore(core, async (session) => ({
      billing: await session.orgSettings.billing(),
    })),
});
