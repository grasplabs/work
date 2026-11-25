import { isMemberAdmin } from "@grasp-os/shared/roles";
import { Badge } from "@grasp-os/ui/components/badge";
import { FieldGroup } from "@grasp-os/ui/components/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@grasp-os/ui/components/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute } from "@tanstack/react-router";

import { formatList } from "../format.ts";
import { Flag } from "../frame/flag.tsx";
import { languageOptions } from "../frame/language-options.ts";
import { chooseLocale, isLocale } from "../i18n.ts";
import { roleLabel } from "../labels.ts";
import { ProfileName } from "../settings/profile-name.tsx";
import { ReadOnlyRow } from "../settings/read-only-row.tsx";
import {
  FactRow,
  SettingRow,
  SettingsCard,
  SettingsError,
} from "../settings/section.tsx";

// Settings › Profile: who the person is in Grasp and the language it
// speaks to them, as the library's Settings pattern has it: one compact
// card of rows, every control on one edge and as wide as the others. Their
// name is theirs to change; their email is their sign-in's, so it stands in
// a field that only reads, with their role, an admin's to give, as a
// badge at its end: one row for the facts of their sign-in. An admin finds
// their teams where they are managed (Settings › Teams); anyone else, who
// may not open that page, finds theirs in a last row here.

const styles = stylex.create({
  // Every control fills the rows' shared control column.
  control: { width: "100%" },
  language: { display: "flex", alignItems: "center", gap: space["2"] },
});

/** Their sign-in's email, which only reads, with their role at its end. */
const EmailRow = ({ email, role }: { email: string; role: string }) => {
  const { t } = useLingui();
  return (
    <SettingRow
      help={t`Your sign-in, which your admin changes`}
      label={t`Email`}
    >
      <InputGroup size="sm" style={styles.control}>
        <InputGroupInput readOnly type="email" value={email} />
        <InputGroupAddon align="inline-end">
          <Badge size="sm">{role}</Badge>
        </InputGroupAddon>
      </InputGroup>
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
      {
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
          <SelectTrigger size="sm" style={styles.control}>
            {chosen === undefined ? null : <Flag flag={chosen.flag} />}
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {languageOptions.map(({ code, name, flag }) => (
              <SelectItem key={code} label={name} value={code}>
                <span {...stylex.props(styles.language)}>
                  <Flag flag={flag} />
                  {name}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    </SettingRow>
  );
};

const Profile = () => {
  const { t } = useLingui();
  const { identity } = Route.useRouteContext();
  return (
    // One topic: the page's title names it, so the card has none of its own.
    <SettingsCard aria-label={t`Profile`}>
      <FieldGroup>
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
        {isMemberAdmin(identity) ? null : (
          <FactRow label={t`Teams`}>
            {identity.teams.length === 0 ? (
              <Trans>No teams</Trans>
            ) : (
              formatList(identity.teams.map(({ name }) => name))
            )}
          </FactRow>
        )}
      </FieldGroup>
    </SettingsCard>
  );
};

export const Route = createFileRoute("/_shell/settings/profile")({
  errorComponent: SettingsError,
  component: Profile,
});
