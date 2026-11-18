import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute } from "@tanstack/react-router";

import { Badge } from "../grasp/badge/index.ts";
import { DE, ES, FR, GB, NL } from "../grasp/flags/index.ts";
import type { FlagData } from "../grasp/flags/index.ts";
import {
  InputGroup,
  InputGroupInput,
  InputGroupText,
} from "../grasp/input-group/index.ts";
import { Input } from "../grasp/input/index.ts";
import { LanguageSwitch } from "../grasp/language-switch/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { SettingRow, SettingsRows } from "../grasp/setting-row/index.ts";
import { chooseLocale, isLocale, localeNames } from "../i18n.ts";
import type { Locale } from "../i18n.ts";
import { roleLabel } from "../labels.ts";
import { ProfileName } from "../settings/profile-name.tsx";
import { SettingsError } from "../settings/section.tsx";

// Settings › Profile: who the person is in Grasp and the language it
// speaks to them, as the library's Settings pattern has it: one compact
// card of rows, every control on one edge and as wide as the others. Their
// name is theirs to change; their email is their sign-in's, so it stands in
// a field that only reads, with their role, an admin's to give, as a
// badge at its end: one row for the facts of their sign-in. Their teams
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

/** A value this person reads here but doesn't change, in a field that only reads. */
const ReadOnlyRow = ({ label, value }: { label: string; value: string }) => (
  <SettingRow label={label}>
    {(field) => (
      <Input
        {...field}
        layout={styles.control}
        readOnly
        size="sm"
        value={value}
      />
    )}
  </SettingRow>
);

/** Their sign-in's email, which only reads, with their role at its end. */
const EmailRow = ({ email, role }: { email: string; role: string }) => {
  const { t } = useLingui();
  return (
    <SettingRow info={t`Your sign-in; your admin changes it.`} label={t`Email`}>
      {(field) => (
        // BUILDER: InputGroup has no `sm` size, so this field stands taller than the row's other `sm`
        // controls; asked of the library (Input's `sm` height for InputGroup).
        <InputGroup layout={styles.control}>
          <InputGroupInput {...field} readOnly type="email" value={email} />
          <InputGroupText>
            <Badge size="sm">{role}</Badge>
          </InputGroupText>
        </InputGroup>
      )}
    </SettingRow>
  );
};

/** The language Grasp speaks to this person, chosen as it is picked. */
const LanguageRow = () => {
  const { t, i18n } = useLingui();
  const label = t`Language`;
  return (
    <SettingRow label={label}>
      <LanguageSwitch
        layout={styles.control}
        size="sm"
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
    // One topic: the page's title names it, so the card has none of its own.
    <SectionCard aria-label={t`Profile`} density="compact" flush>
      <SettingsRows>
        {/* Grasp's staff sign in for a while, as Grasp names them. */}
        {identity.staff ? (
          <ReadOnlyRow label={t`Name`} value={identity.name} />
        ) : (
          <ProfileName name={identity.name} />
        )}
        <EmailRow email={identity.email} role={roleLabel(identity.role)} />
        <LanguageRow />
      </SettingsRows>
    </SectionCard>
  );
};

export const Route = createFileRoute("/_shell/settings/profile")({
  errorComponent: SettingsError,
  component: Profile,
});
