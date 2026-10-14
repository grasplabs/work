import { isAdmin } from "@grasp-os/shared/roles";
import { Switch } from "@grasp-os/ui/components/switch";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import {
  SettingsError,
  SettingsRow,
  SettingsSection,
} from "../settings/settings-parts.tsx";

// Settings → Notifications, as in the prototype
// (`routes/settings/notifications.tsx`): which emails Grasp sends the
// person. Core sends no email yet, so each is off, and can't be switched
// on until it does.

const Notifications = () => {
  const { t } = useLingui();
  const { identity } = Route.useRouteContext();
  return (
    <SettingsSection
      description={t`Which emails Grasp sends you. Only to you; nobody else’s change.`}
      title={t`Email`}
    >
      <SettingsRow
        description={t`A workflow to check or approve, a run waiting on you, or a change to a live workflow.`}
        htmlFor="notify-needs-you"
        label={t`When something needs you`}
      >
        <Switch checked={false} disabled id="notify-needs-you" />
      </SettingsRow>
      <SettingsRow
        description={t`Every Monday: hours, runs, and what is waiting.`}
        htmlFor="notify-weekly"
        label={t`Weekly summary`}
      >
        <Switch checked={false} disabled id="notify-weekly" />
      </SettingsRow>
      {/* Only admins can fix billing, so only they are told when it goes wrong. */}
      {isAdmin(identity.role) ? (
        <SettingsRow
          description={t`When a payment fails or the card is about to run out, so you can fix it in time.`}
          htmlFor="notify-billing"
          label={t`Billing problems`}
        >
          <Switch checked={false} disabled id="notify-billing" />
        </SettingsRow>
      ) : null}
    </SettingsSection>
  );
};

export const Route = createFileRoute("/_shell/settings/notifications")({
  errorComponent: SettingsError,
  component: Notifications,
});
