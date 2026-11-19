import { noBilling } from "@grasp-os/shared/org-settings";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute, Link } from "@tanstack/react-router";

import { SettingsSkeleton } from "../frame/page-skeletons-a.tsx";
import { Button } from "../grasp/button/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import {
  RowAlert,
  SettingRow,
  SettingsRows,
} from "../grasp/setting-row/index.ts";
import { Switch } from "../grasp/switch/index.ts";
import { loadFromCore } from "../load-from-core.tsx";
import { BillingCard } from "../settings/billing-card.tsx";
import { useQueuedSave } from "../settings/queued-save.ts";
import { ReadOnlyRow } from "../settings/read-only-row.tsx";
import { SectionNotLoaded, SettingsError } from "../settings/section.tsx";

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
    <SectionCard variant="grouped" density="compact" flush title={t`Plan`}>
      <SettingsRows>
        <ReadOnlyRow
          info={t`Grasp links Stripe and sets up your plan with you.`}
          label={t`Current plan`}
          value={t`None yet`}
        />
        {/* What AI costs this month stands on its own page: the way there. */}
        <SettingRow label={t`AI spend`}>
          <Button
            render={<Link to="/settings/ai-providers" />}
            size="sm"
            variant="quiet"
          >
            {t`AI and spend`}
          </Button>
        </SettingRow>
      </SettingsRows>
    </SectionCard>
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
      <SectionCard variant="grouped" density="compact" title={t`Plan`}>
        <SectionNotLoaded page={page} />
      </SectionCard>
    );
  }
  // Only the organization's own admins change them; Grasp staff read them.
  const readOnly = identity.staff;
  return (
    <>
      <BillingCard billing={billing} canChange={!readOnly} />
      <Plan />
      <SectionCard
        variant="grouped"
        density="compact"
        flush
        title={t`Billing emails`}
      >
        <SettingsRows>
          {failure === undefined ? null : (
            <RowAlert variant="danger">{failure}</RowAlert>
          )}
          <SettingRow label={t`Email invoices`}>
            <Switch
              checked={billing.emailInvoices}
              aria-label={t`Email invoices`}
              onCheckedChange={(emailInvoices) => {
                save({ emailInvoices });
              }}
              readOnly={readOnly}
            />
          </SettingRow>
          <SettingRow label={t`Email payment receipts`}>
            <Switch
              checked={billing.emailReceipts}
              aria-label={t`Email payment receipts`}
              onCheckedChange={(emailReceipts) => {
                save({ emailReceipts });
              }}
              readOnly={readOnly}
            />
          </SettingRow>
        </SettingsRows>
      </SectionCard>
    </>
  );
};

/** The billing details' card, the plan, then the billing emails. */
const BillingPending = () => (
  <SettingsSkeleton sections={[{ rows: 2, titled: false }, 2, 2]} />
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
