import type {
  EmailPreferenceChanges,
  EmailPreferences,
} from "@grasp-os/shared/email-preferences";
import { isMemberAdmin } from "@grasp-os/shared/roles";
import { Switch } from "@grasp-os/ui/components/switch";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { ErrorText } from "../error-text.tsx";
import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import {
  SettingsError,
  SettingsLoading,
  SettingsRow,
  SettingsSection,
} from "../settings/settings-parts.tsx";
import { useCoreAction } from "../use-core-action.ts";

// Settings → Notifications, as in the prototype
// (`routes/settings/notifications.tsx`): which emails Grasp sends the
// person, kept in their own Workspace object (core's
// email-preferences-rpc.ts). Core sends none of them yet, which the
// section says; what the person picks is kept for when it does. The
// switches are off while one is saved.

/** The person's switches, saved as each is flipped. */
const EmailSwitches = ({
  saved,
  billing,
}: {
  saved: EmailPreferences;
  /** Only the organization's admins can fix billing, so only they are asked about it. */
  billing: boolean;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  // The switch being saved shows its new place until core's preferences
  // are read again; a save sends only that switch, so a page showing an
  // older read never puts back what was saved since.
  const [saving, setSaving] = useState<EmailPreferenceChanges>({});
  const preferences = { ...saved, ...saving };
  const flip = async (which: keyof EmailPreferences, on: boolean) => {
    const changes = { [which]: on };
    setSaving(changes);
    await run(async (session) => {
      await changeThenRefresh(
        async () => {
          await session.emailPreferences.save(changes);
        },
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
    setSaving({});
  };
  return (
    <>
      <SettingsRow
        description={t`A workflow to check or approve, a run waiting on you, or a change to a live workflow.`}
        htmlFor="notify-needs-you"
        label={t`When something needs you`}
      >
        <Switch
          checked={preferences.needsYou}
          disabled={busy}
          id="notify-needs-you"
          onCheckedChange={(on) => {
            void flip("needsYou", on);
          }}
        />
      </SettingsRow>
      <SettingsRow
        description={t`Every Monday: hours, runs, and what is waiting.`}
        htmlFor="notify-weekly"
        label={t`Weekly summary`}
      >
        <Switch
          checked={preferences.weeklySummary}
          disabled={busy}
          id="notify-weekly"
          onCheckedChange={(on) => {
            void flip("weeklySummary", on);
          }}
        />
      </SettingsRow>
      {billing ? (
        <SettingsRow
          description={t`When a payment fails or the card is about to run out, so you can fix it in time.`}
          htmlFor="notify-billing"
          label={t`Billing problems`}
        >
          <Switch
            checked={preferences.billingProblems}
            disabled={busy}
            id="notify-billing"
            onCheckedChange={(on) => {
              void flip("billingProblems", on);
            }}
          />
        </SettingsRow>
      ) : null}
      {failure === undefined ? null : (
        <div className="border-t px-5 py-4">
          <ErrorText>{failure}</ErrorText>
        </div>
      )}
    </>
  );
};

const Notifications = () => {
  const { t } = useLingui();
  const { identity } = Route.useRouteContext();
  const page = Route.useLoaderData();
  return (
    <SettingsSection
      description={
        <>
          <p>{t`Which emails Grasp sends you. Only to you; nobody else’s change.`}</p>
          <p>{t`Grasp doesn’t send these emails yet. What you choose here applies once it does.`}</p>
        </>
      }
      title={t`Email`}
    >
      {page.state === "ready" ? (
        <EmailSwitches billing={isMemberAdmin(identity)} saved={page.data} />
      ) : (
        <NotLoadedState heading="h3" page={page} />
      )}
    </SettingsSection>
  );
};

export const Route = createFileRoute("/_shell/settings/notifications")({
  pendingComponent: SettingsLoading,
  errorComponent: SettingsError,
  component: Notifications,
  loader: async ({ context: { core } }) =>
    await loadFromCore(
      core,
      async (session) => await session.emailPreferences.get()
    ),
});
