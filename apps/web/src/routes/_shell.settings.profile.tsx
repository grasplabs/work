import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute } from "@tanstack/react-router";

import { Badge } from "../grasp/badge/index.ts";
import { DE, ES, FR, GB, NL } from "../grasp/flags/index.ts";
import type { FlagData } from "../grasp/flags/index.ts";
import { LanguageSwitch } from "../grasp/language-switch/index.ts";
import {
  FactRow,
  SettingRow,
  SettingsRows,
} from "../grasp/setting-row/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { chooseLocale, isLocale, localeNames } from "../i18n.ts";
import type { Locale } from "../i18n.ts";
import { roleLabel } from "../labels.ts";
import { ProfileName } from "../settings/profile-name.tsx";
import { SettingsError } from "../settings/section.tsx";

// Settings › Profile: who the person is in Grasp and the language it
// speaks to them, as rows under the page's one title. Their name is theirs
// to change; their email is their sign-in's, and their role an admin's,
// shown beside it. Their teams are shown where they are managed.

const styles = stylex.create({
  // The email, and the role beside it.
  email: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space2,
  },
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
    <SettingsRows>
      {/* Grasp's staff sign in for a while, as Grasp names them. */}
      {identity.staff ? (
        <FactRow label={t`Name`}>{identity.name}</FactRow>
      ) : (
        <ProfileName name={identity.name} />
      )}
      <FactRow label={t`Email`}>
        <span {...stylex.props(styles.email)}>
          {identity.email}
          <Badge size="sm">{roleLabel(identity.role)}</Badge>
        </span>
      </FactRow>
      <LanguageRow />
    </SettingsRows>
  );
};

export const Route = createFileRoute("/_shell/settings/profile")({
  errorComponent: SettingsError,
  component: Profile,
});
