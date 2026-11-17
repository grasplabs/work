import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { formatList } from "../format.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { Select } from "../grasp/select/index.ts";
import { chooseLocale, isLocale, localeNames } from "../i18n.ts";
import { roleLabel } from "../labels.ts";
import {
  FactRow,
  SettingRow,
  SettingsError,
  SettingsRows,
} from "../settings/section.tsx";

// Settings → Profile: who the person is in Grasp, and how Grasp is for
// them. Their name and email come from their organization's sign-in,
// their role and teams from an admin, so they are shown, not changed,
// here. The language is theirs to pick.

const languages = Object.entries(localeNames).map(([value, label]) => ({
  value,
  label,
}));

/** The language Grasp speaks to this person, chosen as it is picked. */
const LanguageRow = () => {
  const { t, i18n } = useLingui();
  return (
    <SettingRow
      help={t`Numbers, dates and amounts follow it too.`}
      label={t`Language`}
    >
      {(field) => (
        <Select
          {...field}
          items={languages}
          onValueChange={(value) => {
            if (isLocale(value)) {
              void chooseLocale(value);
            }
          }}
          value={i18n.locale}
        />
      )}
    </SettingRow>
  );
};

const Profile = () => {
  const { t } = useLingui();
  const { identity } = Route.useRouteContext();
  const teams = identity.teams.map(({ name }) => name);
  return (
    <SectionCard
      flush
      footer={
        identity.staff
          ? t`You are signed in as Grasp staff, for a limited time.`
          : t`Your organization’s sign-in sets your name and email; an admin, your role and teams.`
      }
      title={t`Profile`}
    >
      <SettingsRows>
        <FactRow label={t`Name`}>{identity.name}</FactRow>
        <FactRow label={t`Email`}>{identity.email}</FactRow>
        <FactRow label={t`Role`}>{roleLabel(identity.role)}</FactRow>
        <FactRow label={t`Teams`}>
          {teams.length === 0 ? t`No teams` : formatList(teams)}
        </FactRow>
        <LanguageRow />
      </SettingsRows>
    </SectionCard>
  );
};

export const Route = createFileRoute("/_shell/settings/profile")({
  errorComponent: SettingsError,
  component: Profile,
});
