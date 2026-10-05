import { Avatar, AvatarFallback } from "@grasp-os/ui/components/avatar";
import { Badge } from "@grasp-os/ui/components/badge";
import { Input } from "@grasp-os/ui/components/input";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { formatList } from "../format.ts";
import { initials } from "../frame/person-menu.tsx";
import { roleLabel } from "../labels.ts";
import { LanguageSelect } from "../language-picker.tsx";
import {
  SettingsError,
  SettingsRow,
  SettingsSection,
} from "../settings/settings-parts.tsx";

// Settings → Profile, as in the prototype (`routes/settings/profile.tsx`):
// how the person appears in Grasp. Their name and email come from their
// organization's sign-in, their role from an admin, so they are shown,
// not changed, here; the language is theirs to pick.

const Profile = () => {
  const { t } = useLingui();
  const { identity } = Route.useRouteContext();
  const teams = identity.teams.map(({ name }) => name);
  return (
    <SettingsSection
      description={t`How you appear in Grasp: on workflows you own, and in the audit trail.`}
      title={t`Profile`}
    >
      <div className="flex items-center gap-3 border-t px-5 py-4">
        <Avatar className="size-10">
          <AvatarFallback>{initials(identity.name)}</AvatarFallback>
        </Avatar>
        <div className="flex flex-col">
          <span>{identity.name}</span>
          <span className="text-muted-foreground">{identity.email}</span>
        </div>
      </div>
      <SettingsRow
        description={t`Set by your organization’s sign-in.`}
        htmlFor="profile-name"
        label={t`Name`}
      >
        <Input disabled id="profile-name" readOnly value={identity.name} />
      </SettingsRow>
      <SettingsRow
        description={t`Set by your organization’s sign-in.`}
        htmlFor="profile-email"
        label={t`Email`}
      >
        <Input disabled id="profile-email" readOnly value={identity.email} />
      </SettingsRow>
      <SettingsRow
        description={
          identity.staff
            ? t`You are signed in as Grasp staff, for a limited time.`
            : t`An admin changes it, in Members and roles.`
        }
        label={t`Role`}
      >
        <Badge variant="secondary">{roleLabel(identity.role)}</Badge>
      </SettingsRow>
      <SettingsRow
        description={t`Set in your organization’s directory.`}
        label={t`Teams`}
      >
        <span className="text-muted-foreground">
          {teams.length === 0 ? <Trans>No teams</Trans> : formatList(teams)}
        </span>
      </SettingsRow>
      <SettingsRow
        description={t`Grasp in your language. Numbers, dates and amounts follow it too.`}
        htmlFor="profile-language"
        label={t`Language`}
      >
        <LanguageSelect id="profile-language" />
      </SettingsRow>
    </SettingsSection>
  );
};

export const Route = createFileRoute("/_shell/settings/profile")({
  errorComponent: SettingsError,
  component: Profile,
});
