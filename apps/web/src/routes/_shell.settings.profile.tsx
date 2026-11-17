import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute } from "@tanstack/react-router";

import { Badge } from "../grasp/badge/index.ts";
import { DE, ES, FR, GB, NL } from "../grasp/flags/index.ts";
import type { FlagData } from "../grasp/flags/index.ts";
import { Input } from "../grasp/input/index.ts";
import { LanguageSwitch } from "../grasp/language-switch/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import {
  FactRow,
  SettingRow,
  SettingsRows,
} from "../grasp/setting-row/index.ts";
import { chooseLocale, isLocale, localeNames } from "../i18n.ts";
import type { Locale } from "../i18n.ts";
import { roleLabel } from "../labels.ts";
import { ProfileName } from "../settings/profile-name.tsx";
import { SettingsError } from "../settings/section.tsx";

// Settings › Profile: who the person is in Grasp and the language it
// speaks to them, as the library's Settings pattern has it: one compact
// card of rows, every control on one edge and as wide as the others. Their
// name is theirs to change; their email is their sign-in's, so it stands in
// a field that only reads; their role is an admin's to give. Their teams
// are shown where they are managed.

const styles = stylex.create({
  // Every control fills the rows' shared control column.
  control: { width: "100%" },
});

/** The flag that stands for each language Grasp speaks: its home region's. */
const flags: Record<Locale, FlagData> = {
  en: GB,
  de: DE,
  nl: NL,
  es: ES,
  fr: FR,
};

const languages = Object.entries(localeNames).flatMap(([code, name]) =>
  isLocale(code) ? [{ code, name, flag: flags[code] }] : []
);

/** The language Grasp speaks to this person, chosen as it is picked. */
const LanguageRow = () => {
  const { t, i18n } = useLingui();
  const label = t`Language`;
  return (
    <SettingRow label={label}>
      <LanguageSwitch
        label={label}
        layout={styles.control}
        onValueChange={(code) => {
          if (isLocale(code)) {
            void chooseLocale(code);
          }
        }}
        options={languages}
        value={i18n.locale}
      />
    </SettingRow>
  );
};

const Profile = () => {
  const { t } = useLingui();
  const { identity } = Route.useRouteContext();
  return (
    <SectionCard density="compact" flush title={t`Your details`}>
      <SettingsRows>
        {/* Grasp's staff sign in for a while, as Grasp names them. */}
        {identity.staff ? (
          <FactRow label={t`Name`}>{identity.name}</FactRow>
        ) : (
          <ProfileName name={identity.name} />
        )}
        <SettingRow label={t`Email`}>
          {(field) => (
            <Input
              {...field}
              layout={styles.control}
              readOnly
              type="email"
              value={identity.email}
            />
          )}
        </SettingRow>
        <FactRow label={t`Role`}>
          <Badge size="sm">{roleLabel(identity.role)}</Badge>
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
