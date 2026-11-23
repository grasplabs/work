import type { BillingSettings as Billing } from "@grasp-os/shared/org-settings";
import { Button } from "@grasp-os/ui/components/button";
import { FieldGroup } from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import { Switch } from "@grasp-os/ui/components/switch";
import { useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";

import { BillingCard } from "./billing-card.tsx";
import { useQueuedSave } from "./queued-save.ts";
import {
  FactRow,
  Failure,
  SettingRow,
  SettingsGroup,
  SettingsRows,
  SettingsStack,
} from "./section.tsx";

// Settings › Billing's page (routes/_shell.settings.billing.tsx reads it
// from core): the billing details as a card at its head
// (settings/billing-card.tsx), their form in a dialog from its one button;
// the plan, with the way to what AI costs (on AI and spend, not repeated
// here); and which billing emails go out, each switch saved as it is
// flipped. No payment provider is linked yet, so there is no plan, card or
// invoice, and no way into Stripe: what would only lead there is left out
// until it is.
//
// Core keeps billing whole (`orgSettings.updateBilling` replaces it), so
// the switches and the details' dialog save through one queue, each change
// laid over what core keeps as its turn comes (settings/queued-save.ts):
// neither sends the other's fields as the page last read them.

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
          <Button asChild size="sm" variant="outline">
            <Link to="/settings/ai-providers">{t`AI and spend`}</Link>
          </Button>
        </FactRow>
      </SettingsRows>
    </SettingsGroup>
  );
};

/** The billing details' card, the plan, then the billing emails; `readOnly` for Grasp staff. */
export const BillingSettings = ({
  billing,
  readOnly,
}: {
  billing: Billing;
  readOnly: boolean;
}) => {
  const { t } = useLingui();
  const { failure, save } = useQueuedSave(
    async (session) => await session.orgSettings.billing(),
    async (session, next) => await session.orgSettings.updateBilling(next)
  );
  return (
    <SettingsStack>
      <BillingCard billing={billing} save={readOnly ? undefined : save} />
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
              onCheckedChange={(emailReceipts) => {
                void save({ emailReceipts });
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
