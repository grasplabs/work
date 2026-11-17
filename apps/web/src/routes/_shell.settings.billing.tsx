import { failureText } from "@grasp-os/shared/errors";
import { noBilling } from "@grasp-os/shared/org-settings";
import { roleErrors } from "@grasp-os/shared/roles";
import type { MonthBilled } from "@grasp-os/shared/stephen-requests";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute, Link } from "@tanstack/react-router";

import type { Session } from "../core.ts";
import { formatNumber } from "../format.ts";
import { Button } from "../grasp/button/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { Switch } from "../grasp/switch/index.ts";
import { loadFromCore } from "../load-from-core.tsx";
import { useQueuedSave } from "../settings/queued-save.ts";
import { SavedField } from "../settings/saved-field.tsx";
import {
  FactRow,
  RowAlert,
  SectionNotLoaded,
  SettingRow,
  SettingsError,
  SettingsLoading,
  SettingsRows,
  SwitchRow,
} from "../settings/section.tsx";

// Settings → Billing, for admins: the plan, Stephen's requests outside
// Grasp this month (which the plan bills, with the way to how they are
// used), and the billing details. Core keeps the billing details
// (`orgSettings.billing()`), which the organization's own admins change
// here, each field saved as it is left; Grasp staff read them. No payment
// provider is linked yet, so there is no plan, card or invoice: what
// would only lead into Stripe (change plan, the card, invoices) is left
// out until it is. Which emails Stripe sends is kept with the details.

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

/** Stephen's requests outside Grasp this month, against what the plan includes when it says; or why they can't be read. */
const RequestsRow = ({
  requests,
}: {
  requests: Exclude<RequestsRead, { state: "refused" }>;
}) => {
  const { t } = useLingui();
  if (requests.state === "failed") {
    return <RowAlert variant="danger">{requests.reason}</RowAlert>;
  }
  const used = formatNumber(requests.billed.billed);
  const { included } = requests.billed;
  const of = included === null ? "" : formatNumber(included);
  return (
    <FactRow
      help={
        included === null
          ? t`Outside Grasp this month.`
          : t`Outside Grasp this month, against what the plan includes.`
      }
      label={t`Stephen’s requests`}
    >
      {included === null ? used : t`${used} of ${of}`}
    </FactRow>
  );
};

/** The plan, that Stripe isn't linked yet, and Stephen's requests where the viewer may see them. */
const Plan = ({ requests }: { requests: RequestsRead }) => {
  const { t } = useLingui();
  const shown = requests.state !== "refused";
  return (
    <SectionCard
      {...(shown
        ? {
            actions: (
              <Button render={<Link to="/workflows/requests" />} size="sm">
                {t`See usage`}
              </Button>
            ),
          }
        : {})}
      description={t`What the workspace pays for Grasp.`}
      flush
      title={t`Plan`}
    >
      <SettingsRows>
        <RowAlert variant="neutral">
          {t`Stripe isn’t linked yet: no plan, card or invoice until it is.`}
        </RowAlert>
        <FactRow label={t`Current plan`}>
          {t({ message: "None", context: "nothing set" })}
        </FactRow>
        {requests.state === "refused" ? null : (
          <RequestsRow requests={requests} />
        )}
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
      <SectionCard title={t`Plan`}>
        <SectionNotLoaded page={page} />
      </SectionCard>
    );
  }
  // Only the organization's own admins change them; Grasp staff read them.
  const readOnly = identity.staff;
  return (
    <>
      <Plan requests={page.data.requests} />
      <SectionCard
        description={t`What appears on every invoice.`}
        flush
        title={t`Billing details`}
      >
        <SettingsRows>
          {failure === undefined ? null : (
            <RowAlert variant="danger">{failure}</RowAlert>
          )}
          <SettingRow
            help={t`Invoices and receipts go here.`}
            label={t`Billing email`}
          >
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
          <SettingRow help={t`As invoices show it.`} label={t`VAT number`}>
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
          <SwitchRow>
            <Switch
              checked={billing.emailInvoices}
              description={t`Each invoice as a PDF, as soon as it is issued.`}
              label={t`Email invoices`}
              onCheckedChange={(emailInvoices) => {
                save({ emailInvoices });
              }}
              readOnly={readOnly}
            />
          </SwitchRow>
          <SwitchRow>
            <Switch
              checked={billing.emailReceipts}
              description={t`A receipt each time a payment goes through.`}
              label={t`Email payment receipts`}
              onCheckedChange={(emailReceipts) => {
                save({ emailReceipts });
              }}
              readOnly={readOnly}
            />
          </SwitchRow>
        </SettingsRows>
      </SectionCard>
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
