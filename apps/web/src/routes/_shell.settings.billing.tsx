import type { ModelMonthSpend } from "@grasp-os/shared/models";
import { noBilling } from "@grasp-os/shared/org-settings";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute, Link } from "@tanstack/react-router";

import { Button } from "../grasp/button/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import {
  RowAlert,
  SettingRow,
  SettingsRows,
} from "../grasp/setting-row/index.ts";
import { Switch } from "../grasp/switch/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { SpendSummary } from "../settings/ai-spend.tsx";
import { useQueuedSave } from "../settings/queued-save.ts";
import { SavedField } from "../settings/saved-field.tsx";
import {
  SectionNotLoaded,
  SettingsError,
  SettingsLoading,
} from "../settings/section.tsx";

// Settings → Billing, for admins: the plan, this month's AI spend
// (settings/ai-spend.tsx, the same as on AI and spend, with the way
// there for where it went), and the billing details. Core keeps the
// billing details (`orgSettings.billing()`), which the organization's own
// admins change here, each field saved as it is left; Grasp staff read
// them, and are refused the spend, so it isn't asked for them. No payment
// provider is linked yet, so there is no plan, card or invoice, and no
// way into Stripe: what would only lead there is left out until it is.
// Which emails Stripe sends is kept with the details.

const styles = stylex.create({
  body: { display: "grid", gap: grasp.space4 },
});

/** The plan: none until Grasp links Stripe and sets one up. */
const Plan = () => {
  const { t } = useLingui();
  return (
    <SectionCard density="compact" flush title={t`Plan`}>
      <SettingsRows>
        <SettingRow
          info={t`Grasp links Stripe and sets up your plan with you.`}
          label={t`Current plan`}
        >
          <Text size="sm">{t`None yet`}</Text>
        </SettingRow>
      </SettingsRows>
    </SectionCard>
  );
};

/** This month's AI spend, as AI and spend shows it, with the way there. */
const Spend = ({ spend }: { spend: Loaded<ModelMonthSpend> }) => {
  const { t } = useLingui();
  return (
    <SectionCard
      actions={
        <Button
          render={<Link to="/settings/ai-providers" />}
          size="sm"
          variant="ghost"
        >
          {t`AI and spend`}
        </Button>
      }
      density="compact"
      title={t`AI spend`}
    >
      {spend.state === "ready" ? (
        <div {...stylex.props(styles.body)}>
          <SpendSummary spend={spend.data} />
        </div>
      ) : (
        <SectionNotLoaded page={spend} />
      )}
    </SectionCard>
  );
};

const BillingPage = () => {
  const { t } = useLingui();
  const { page, spend } = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  const billing = page.state === "ready" ? page.data.billing : noBilling;
  const { failure, save } = useQueuedSave(
    billing,
    async (session, next) => await session.orgSettings.updateBilling(next)
  );
  if (page.state !== "ready") {
    return (
      <SectionCard title={t`Plan`}>
        <SectionNotLoaded page={page} />
      </SectionCard>
    );
  }
  // Only the organization's own admins change them; Grasp staff read them.
  const readOnly = identity.staff;
  return (
    <>
      <Plan />
      {spend === undefined ? null : <Spend spend={spend} />}
      <SectionCard density="compact" flush title={t`Billing details`}>
        <SettingsRows>
          {failure === undefined ? null : (
            <RowAlert variant="danger">{failure}</RowAlert>
          )}
          <SettingRow label={t`Billing email`}>
            {(field) => (
              <SavedField
                field={field}
                maxLength={254}
                onSave={(email) => {
                  save({ email });
                }}
                readOnly={readOnly}
                type="email"
                value={billing.email}
              />
            )}
          </SettingRow>
          <SettingRow label={t`Company`}>
            {(field) => (
              <SavedField
                field={field}
                maxLength={120}
                onSave={(company) => {
                  save({ company });
                }}
                readOnly={readOnly}
                value={billing.company}
              />
            )}
          </SettingRow>
          <SettingRow label={t`Address`}>
            {(field) => (
              <SavedField
                field={field}
                maxLength={500}
                multiline
                onSave={(address) => {
                  save({ address });
                }}
                readOnly={readOnly}
                value={billing.address}
              />
            )}
          </SettingRow>
          <SettingRow label={t`VAT number`}>
            {(field) => (
              <SavedField
                field={field}
                maxLength={14}
                onSave={(vatNumber) => {
                  save({ vatNumber });
                }}
                readOnly={readOnly}
                value={billing.vatNumber}
              />
            )}
          </SettingRow>
          <SettingRow label={t`Email invoices`}>
            <Switch
              checked={billing.emailInvoices}
              label={t`Email invoices`}
              labelHidden
              onCheckedChange={(emailInvoices) => {
                save({ emailInvoices });
              }}
              readOnly={readOnly}
            />
          </SettingRow>
          <SettingRow label={t`Email payment receipts`}>
            <Switch
              checked={billing.emailReceipts}
              label={t`Email payment receipts`}
              labelHidden
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

export const Route = createFileRoute("/_shell/settings/billing")({
  pendingComponent: SettingsLoading,
  errorComponent: SettingsError,
  component: BillingPage,
  loader: async ({ context: { core, identity } }) => {
    // Core refuses the spend to Grasp staff: they aren't asked.
    const [page, spend] = await Promise.all([
      loadFromCore(core, async (session) => ({
        billing: await session.orgSettings.billing(),
      })),
      identity.staff
        ? undefined
        : loadFromCore(core, async (session) => await session.models.spend()),
    ]);
    return { page, spend };
  },
});
