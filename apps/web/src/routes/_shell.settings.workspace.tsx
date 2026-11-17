import type { GateView } from "@grasp-os/shared/onboarding-gate";
import type { Organization } from "@grasp-os/shared/organization";
import { isAdmin, isMemberAdmin } from "@grasp-os/shared/roles";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { formatList } from "../format.ts";
import { Combobox } from "../grasp/combobox/index.ts";
import { EU, Flag } from "../grasp/flags/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { SettingRow, SettingsRows } from "../grasp/setting-row/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import {
  SectionNotLoaded,
  SettingsError,
  SettingsLoading,
} from "../settings/section.tsx";
import { SignInSection } from "../settings/sign-in-settings.tsx";
import { StaffAccessSection } from "../settings/staff-access.tsx";
import {
  controlStyles,
  LogoField,
  NameField,
  useOrganizationChange,
  useSaveWords,
} from "../settings/workspace-name.tsx";

// Settings → Workspace: the organization's name and the time zone it
// works in, which its admins change, and where its data lives, which the
// deployment decides. Everyone sees them; core refuses a change from
// anyone but the organization's own admins, and everyone else sees the
// values read-only. Then, for admins, how people sign in
// (settings/sign-in-settings.tsx) and Grasp's staff access
// (settings/staff-access.tsx).

/** The time zones to pick from, each by a city in the reader's language. */
const zones: { value: string; label: MessageDescriptor }[] = [
  { value: "UTC", label: msg({ message: "UTC", comment: "A time zone" }) },
  {
    value: "Europe/London",
    label: msg({ message: "London", comment: "A time zone, by its city" }),
  },
  {
    value: "Europe/Dublin",
    label: msg({ message: "Dublin", comment: "A time zone, by its city" }),
  },
  {
    value: "Europe/Lisbon",
    label: msg({ message: "Lisbon", comment: "A time zone, by its city" }),
  },
  {
    value: "Europe/Amsterdam",
    label: msg({ message: "Amsterdam", comment: "A time zone, by its city" }),
  },
  {
    value: "Europe/Brussels",
    label: msg({ message: "Brussels", comment: "A time zone, by its city" }),
  },
  {
    value: "Europe/Paris",
    label: msg({ message: "Paris", comment: "A time zone, by its city" }),
  },
  {
    value: "Europe/Berlin",
    label: msg({ message: "Berlin", comment: "A time zone, by its city" }),
  },
  {
    value: "Europe/Zurich",
    label: msg({ message: "Zurich", comment: "A time zone, by its city" }),
  },
  {
    value: "Europe/Vienna",
    label: msg({ message: "Vienna", comment: "A time zone, by its city" }),
  },
  {
    value: "Europe/Madrid",
    label: msg({ message: "Madrid", comment: "A time zone, by its city" }),
  },
  {
    value: "Europe/Rome",
    label: msg({ message: "Rome", comment: "A time zone, by its city" }),
  },
  {
    value: "Europe/Copenhagen",
    label: msg({ message: "Copenhagen", comment: "A time zone, by its city" }),
  },
  {
    value: "Europe/Stockholm",
    label: msg({ message: "Stockholm", comment: "A time zone, by its city" }),
  },
  {
    value: "Europe/Oslo",
    label: msg({ message: "Oslo", comment: "A time zone, by its city" }),
  },
  {
    value: "Europe/Warsaw",
    label: msg({ message: "Warsaw", comment: "A time zone, by its city" }),
  },
  {
    value: "Europe/Prague",
    label: msg({ message: "Prague", comment: "A time zone, by its city" }),
  },
  {
    value: "Europe/Helsinki",
    label: msg({ message: "Helsinki", comment: "A time zone, by its city" }),
  },
  {
    value: "Europe/Athens",
    label: msg({ message: "Athens", comment: "A time zone, by its city" }),
  },
];
const styles = stylex.create({
  // A place: its flag, then its name.
  place: { display: "inline-flex", alignItems: "center", gap: grasp.space2 },
});

/** `timeZone`'s offset from UTC now, such as "GMT+2", in the reader's language. */
const offsetOf = (timeZone: string, locale: string): string =>
  new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "shortOffset" })
    .formatToParts(new Date())
    .find((part) => part.type === "timeZoneName")?.value ?? "";

/** The time zone Grasp works in, saved as it is chosen, and free to change again at once. */
const TimeZoneField = ({
  timeZone,
  canChange,
}: {
  timeZone: string;
  canChange: boolean;
}) => {
  const { t, i18n } = useLingui();
  const words = useSaveWords();
  const { busy, failure, status, change, idle } = useOrganizationChange();
  // What core last took: the page's read catches up behind it.
  const [saved, setSaved] = useState(timeZone);
  // The zone a failed save tried, kept for Try again.
  const [tried, setTried] = useState<string>();
  const send = (value: string): void => {
    setTried(value);
    change(
      async (api) => await api.update({ timeZone: value }),
      (organization) => {
        setSaved(organization.timeZone);
        setTried(undefined);
      }
    );
  };
  const known = zones.some((zone) => zone.value === saved);
  const items = [
    ...zones.map((zone) => {
      const offset = offsetOf(zone.value, i18n.locale);
      return {
        value: zone.value,
        label:
          zone.value === "UTC"
            ? i18n._(zone.label)
            : `${i18n._(zone.label)} (${offset})`,
        keywords: [zone.value, offset],
      };
    }),
    // A zone set some other way is shown as it is named.
    ...(known ? [] : [{ value: saved, label: saved, keywords: [] }]),
  ];
  return (
    <SettingRow
      {...words}
      {...(failure === undefined ? {} : { error: failure })}
      help={t`For schedules and the times Grasp shows.`}
      label={t`Time zone`}
      onRetry={() => {
        if (tried !== undefined) {
          send(tried);
        }
      }}
      status={status}
    >
      {(field) => (
        <Combobox
          {...field}
          empty={t`No time zone by that name`}
          items={items}
          layout={controlStyles.fill}
          onValueChange={(value) => {
            idle();
            if (value !== null && value !== saved) {
              send(value);
            }
          }}
          placeholder={t`Search time zones`}
          // Read-only while its own save runs, not disabled: a disabled field drops the keyboard's focus.
          readOnly={!canChange || busy}
          triggerLabel={t`Show the time zones`}
          value={saved}
        />
      )}
    </SettingRow>
  );
};

const WorkspaceSettings = ({
  organization,
  canChange,
}: {
  organization: Organization;
  canChange: boolean;
}) => {
  const { t } = useLingui();
  return (
    <>
      <SectionCard density="compact" flush title={t`Organization`}>
        <LogoField
          canChange={canChange}
          logo={organization.logo}
          name={organization.name}
        />
        <SettingsRows>
          <NameField canChange={canChange} name={organization.name} />
          <TimeZoneField
            canChange={canChange}
            timeZone={organization.timeZone}
          />
          <SettingRow
            info={t`People sign in with an address in these. To change them, ask your Grasp contact.`}
            label={t`Sign-in domains`}
          >
            <Text size="sm">{formatList(organization.signInDomains)}</Text>
          </SettingRow>
          <SettingRow
            info={t`Everything Grasp stores for you stays here.`}
            label={t`Data location`}
          >
            <span {...stylex.props(styles.place)}>
              <Flag flag={EU} />
              <Text size="sm">{t`European Union`}</Text>
            </span>
          </SettingRow>
        </SettingsRows>
      </SectionCard>
      <SignInSection organization={organization.name} />
    </>
  );
};

/** Grasp's staff access, as core answered an admin. */
const StaffAccess = ({
  read,
  editable,
}: {
  read: Loaded<GateView["staff"]>;
  editable: boolean;
}) => {
  const { t } = useLingui();
  if (read.state === "ready") {
    return <StaffAccessSection editable={editable} staff={read.data} />;
  }
  return (
    <SectionCard density="compact" title={t`Grasp staff access`}>
      <SectionNotLoaded page={read} />
    </SectionCard>
  );
};

const Workspace = () => {
  const { t } = useLingui();
  const { page, staff } = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  const editable = isMemberAdmin(identity);
  return (
    <>
      {page.state === "ready" ? (
        <WorkspaceSettings canChange={editable} organization={page.data} />
      ) : (
        <SectionCard density="compact" title={t`Organization`}>
          <SectionNotLoaded page={page} />
        </SectionCard>
      )}
      {staff === undefined ? null : (
        <StaffAccess editable={editable} read={staff} />
      )}
    </>
  );
};

export const Route = createFileRoute("/_shell/settings/workspace")({
  pendingComponent: SettingsLoading,
  errorComponent: SettingsError,
  component: Workspace,
  loader: async ({ context: { core, identity } }) => {
    // Staff access is for admins only: nobody else is asked.
    const [page, staff] = await Promise.all([
      loadFromCore(core, async (session) => await session.organization.get()),
      isAdmin(identity.role)
        ? loadFromCore(core, async (session) => {
            const gate = await session.onboardingGate.view();
            return gate.staff;
          })
        : undefined,
    ]);
    return { page, staff };
  },
});
