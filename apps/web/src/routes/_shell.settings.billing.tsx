import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { BillingSettings } from "../settings/billing.tsx";
import {
  SettingsError,
  SettingsGroup,
  SettingsPending,
} from "../settings/section.tsx";

// Settings › Billing, for admins (settings/billing.tsx). Core keeps the
// billing details (`orgSettings.billing()`), which the organization's own
// admins change here; Grasp staff read them.

const BillingPage = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  if (page.state !== "ready") {
    return (
      <SettingsGroup flush={false} title={t`Plan`}>
        <NotLoadedState heading="h3" page={page} />
      </SettingsGroup>
    );
  }
  // Only the organization's own admins change them; Grasp staff read them.
  return (
    <BillingSettings billing={page.data.billing} readOnly={identity.staff} />
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
