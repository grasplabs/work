import { Switch } from "@grasp-os/ui/components/switch";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { deadline, unlessAborted } from "../core.ts";
import {
  SettingsError,
  SettingsRow,
  SettingsSection,
} from "../settings/settings-parts.tsx";

// Settings → Security, as in the prototype (`routes/settings/security.tsx`):
// how the person gets into Grasp, and the link for AI apps outside it.
// Core lists no one's own sessions yet, so the prototype's devices, and
// this device, aren't here; an admin signs someone out everywhere in
// Members and roles. Grasp has no link for AI apps yet: it stays off.

/** The way people sign in here, when there is just the one; core's own name for it. */
const SignedInWith = ({ labels }: { labels: string[] }) => {
  const { t } = useLingui();
  const [only] = labels;
  return labels.length === 1 && only !== undefined ? (
    <span>{only}</span>
  ) : (
    <span>{t`Your organization’s account`}</span>
  );
};

const Security = () => {
  const { t } = useLingui();
  const { identity } = Route.useRouteContext();
  const labels = Route.useLoaderData();
  return (
    <>
      <SettingsSection
        description={t`How you get into Grasp. Passwords and two-step sign-in live with your organization’s account.`}
        title={t`Sign-in`}
      >
        <SettingsRow
          description={t`Your company account, so leaving the company ends access too.`}
          label={t`Signed in with`}
        >
          <SignedInWith labels={labels} />
        </SettingsRow>
        <SettingsRow
          description={t`The account you signed in with.`}
          label={t`Email`}
        >
          <span className="truncate">{identity.email}</span>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        description={t`Let an AI app such as Claude or ChatGPT use Grasp. It reads what Grasp knows, and it can show you a page. For anything else it asks you here first: nothing changes unless you allow it.`}
        title={t`AI apps`}
      >
        <SettingsRow
          description={t`Off. Nothing of this workspace is kept for an AI app.`}
          label={t`Link for AI apps`}
        >
          <Switch aria-label={t`Link for AI apps`} checked={false} disabled />
        </SettingsRow>
      </SettingsSection>
    </>
  );
};

export const Route = createFileRoute("/_shell/settings/security")({
  errorComponent: SettingsError,
  component: Security,
  // How people sign in here; none when core doesn't say in time.
  loader: async ({ context: { core } }): Promise<string[]> => {
    try {
      const signal = deadline();
      const api = await core.api(signal);
      const options = await unlessAborted(
        Promise.resolve(api.signInOptions()),
        signal
      );
      return options.map(({ label }) => label);
    } catch {
      return [];
    }
  },
});
