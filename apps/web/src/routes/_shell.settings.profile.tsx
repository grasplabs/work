import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute } from "@tanstack/react-router";

import { languageOptions } from "../frame/language-options.ts";
import { Badge } from "../grasp/badge/index.ts";
import { Flag } from "../grasp/flags/index.ts";
import {
  InputGroup,
  InputGroupInput,
  InputGroupText,
} from "../grasp/input-group/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../grasp/select/index.ts";
import { SettingRow, SettingsRows } from "../grasp/setting-row/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { chooseLocale, isLocale } from "../i18n.ts";
import { roleLabel } from "../labels.ts";
import { ProfileName } from "../settings/profile-name.tsx";
import { ReadOnlyRow } from "../settings/read-only-row.tsx";
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
  language: { display: "flex", alignItems: "center", gap: grasp.space2 },
});

/** Their sign-in's email, which only reads, with their role at its end. */
const EmailRow = ({ email, role }: { email: string; role: string }) => {
  const { t } = useLingui();
  return (
    <SettingRow
      help={t`Your sign-in, which your admin changes`}
      label={t`Email`}
    >
      {(field) => (
        <InputGroup size="sm" layout={styles.control}>
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
  const chosen = languageOptions.find(({ code }) => code === i18n.locale);
  return (
    <SettingRow help={t`The language Grasp speaks to you`} label={label}>
      {(field) => (
        // The rows' own Select at their fields' height and words, the
        // chosen language's flag before its name.
        <Select
          items={languageOptions.map(({ code, name }) => ({
            value: code,
            label: name,
          }))}
          onValueChange={(code) => {
            if (code !== null && isLocale(code)) {
              void chooseLocale(code);
            }
          }}
          value={i18n.locale}
        >
          <SelectTrigger {...field} layout={styles.control} size="sm">
            {chosen === undefined ? null : (
              <Flag flag={chosen.flag} size="sm" />
            )}
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {languageOptions.map(({ code, name, flag }) => (
              <SelectItem key={code} label={name} value={code}>
                <span {...stylex.props(styles.language)}>
                  <Flag flag={flag} size="sm" />
                  {name}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
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
          <ReadOnlyRow
            help={t`How Grasp and your colleagues see you`}
            label={t`Name`}
            value={identity.name}
          />
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
