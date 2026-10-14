import { defaultTimeZone } from "@grasp-os/shared/workflows";
import { Badge } from "@grasp-os/ui/components/badge";
import { Input } from "@grasp-os/ui/components/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";

import {
  SettingsError,
  SettingsRow,
  SettingsSection,
} from "../settings/settings-parts.tsx";

// Settings → Workspace, for admins, as in the prototype
// (`routes/settings/workspace.tsx`): how the workspace is named, and where
// its data lives and what time it keeps. Core keeps no name, domain or
// time zone of a workspace yet, so the fields stand empty and can't be
// changed: the time zone is the one core runs schedules in. What is true
// already is that everything stays in the EU, where every deployment is.

// City names follow the reader's language; UTC stays as it is.
const zones: { value: string; label: MessageDescriptor | string }[] = [
  {
    value: "Europe/Amsterdam",
    label: msg({
      message: "Amsterdam (CET)",
      comment: "A time zone, by its city",
    }),
  },
  {
    value: "Europe/Brussels",
    label: msg({
      message: "Brussels (CET)",
      comment: "A time zone, by its city",
    }),
  },
  {
    value: "Europe/Berlin",
    label: msg({
      message: "Berlin (CET)",
      comment: "A time zone, by its city",
    }),
  },
  {
    value: "Europe/London",
    label: msg({
      message: "London (GMT)",
      comment: "A time zone, by its city",
    }),
  },
  { value: "UTC", label: "UTC" },
];

const Workspace = () => {
  const { t, i18n } = useLingui();
  const timezones = zones.map((zone) => ({
    value: zone.value,
    label: typeof zone.label === "string" ? zone.label : i18n._(zone.label),
  }));
  return (
    <>
      <SettingsSection
        description={t`How the workspace is named across Grasp and in emails.`}
        title={t`Workspace`}
      >
        <SettingsRow
          description={t`Your company’s name in Grasp.`}
          htmlFor="workspace-name"
          label={t`Name`}
        >
          <Input disabled id="workspace-name" readOnly value="" />
        </SettingsRow>
        <SettingsRow
          description={t`Who can be invited, and where the logo comes from.`}
          htmlFor="workspace-domain"
          label={t`Company domain`}
        >
          <Input
            disabled
            id="workspace-domain"
            placeholder="company.com"
            readOnly
            value=""
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        description={t`Where your data lives, and the time Grasp uses.`}
        title={t`Region`}
      >
        <SettingsRow
          description={t`Everything Grasp stores stays here.`}
          label={t`Data location`}
        >
          <Badge variant="outline">
            <Trans>European Union</Trans>
          </Badge>
        </SettingsRow>
        <SettingsRow
          description={t`The time zone a schedule uses when it names none of its own.`}
          htmlFor="workspace-timezone"
          label={t`Time zone`}
        >
          <Select disabled items={timezones} value={defaultTimeZone}>
            <SelectTrigger className="w-full" id="workspace-timezone">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {timezones.map((zone) => (
                  <SelectItem key={zone.value} value={zone.value}>
                    {zone.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsSection>
    </>
  );
};

export const Route = createFileRoute("/_shell/settings/workspace")({
  errorComponent: SettingsError,
  component: Workspace,
});
