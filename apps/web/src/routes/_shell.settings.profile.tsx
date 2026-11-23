import { Badge } from "@grasp-os/ui/components/badge";
import { Input } from "@grasp-os/ui/components/input";
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
import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import { chooseLocale, isLocale, localeNames } from "../i18n.ts";
import { roleLabel } from "../labels.ts";
import { ProfileName } from "../settings/profile-name.tsx";
import {
  SettingRow,
  SettingsCard,
  SettingsError,
  SettingsRows,
} from "../settings/section.tsx";

// Settings › Profile: who the person is in Grasp and the language it
// speaks to them, as Damsko's settings pattern has it: one compact card of
// rows, every control on one edge and as wide as the others. Their name is
// theirs to change; their email is their sign-in's, so it stands in a
// field that only reads, with their role, an admin's to give, as a badge
// at its end: one row for the facts of their sign-in. Their teams are
// shown where they are managed.

/** The five languages, each by its own name, in the catalogs' order. */
const languages = Object.entries(localeNames).map(([value, label]) => ({
  value,
  label,
}));

/** Their sign-in's email, which only reads, with their role at its end. */
const EmailRow = ({ email, role }: { email: string; role: string }) => {
  const { t } = useLingui();
  return (
    <SettingRow
      help={t`Your sign-in, which your admin changes`}
      label={t`Email`}
    >
      <InputGroup size="sm">
        <InputGroupInput readOnly type="email" value={email} />
        <InputGroupAddon align="inline-end">
          <Badge size="sm" variant="secondary">
            {role}
          </Badge>
        </InputGroupAddon>
      </InputGroup>
    </SettingRow>
  );
};

/** The language Grasp speaks to this person, chosen as it is picked. */
const LanguageRow = () => {
  const { t, i18n } = useLingui();
  return (
    <SettingRow help={t`The language Grasp speaks to you`} label={t`Language`}>
      <Select
        items={languages}
        onValueChange={(code) => {
          if (code !== null && isLocale(code)) {
            void chooseLocale(code);
          }
        }}
        value={i18n.locale}
      >
        <SelectTrigger size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {languages.map(({ value, label }) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingRow>
  );
};

const Profile = () => {
  const { t } = useLingui();
  const { identity } = Route.useRouteContext();
  return (
    // One topic: the page's title names it, so the card has none of its own.
    <SettingsCard aria-label={t`Profile`}>
      <SettingsRows>
        {/* Grasp's staff sign in for a while, as Grasp names them. */}
        {identity.staff ? (
          <SettingRow
            help={t`How Grasp and your colleagues see you`}
            label={t`Name`}
          >
            <Input readOnly size="sm" value={identity.name} />
          </SettingRow>
        ) : (
          <ProfileName name={identity.name} />
        )}
        <EmailRow email={identity.email} role={roleLabel(identity.role)} />
        <LanguageRow />
      </SettingsRows>
    </SettingsCard>
  );
};

export const Route = createFileRoute("/_shell/settings/profile")({
  errorComponent: SettingsError,
  component: Profile,
});
