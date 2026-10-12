import type { Organization } from "@grasp-os/shared/organization";
import { isAdmin } from "@grasp-os/shared/roles";
import { Badge } from "@grasp-os/ui/components/badge";
import { Input } from "@grasp-os/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatList } from "../format.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import {
  SettingsError,
  SettingsLoading,
  SettingsRow,
  SettingsSection,
} from "../settings/settings-parts.tsx";
import { useCoreAction } from "../use-core-action.ts";

// Settings → Workspace, as in the prototype (`routes/settings/workspace.tsx`):
// the organization's name and the time zone it works in, which its admins
// change, and where its data lives, which the deployment decides. Everyone
// sees them; core refuses a change from anyone but the organization's own
// admins.

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

/** `timeZone`'s offset from UTC now, such as "GMT+2", in the reader's language. */
const offsetOf = (timeZone: string, locale: string): string =>
  new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "shortOffset" })
    .formatToParts(new Date())
    .find((part) => part.type === "timeZoneName")?.value ?? "";

type Change = (organization: Session["organization"]) => Promise<unknown>;

/** The organization's name: saved when the field is left, or on Enter. */
const NameField = ({
  name,
  disabled,
  onSave,
}: {
  name: string;
  disabled: boolean;
  onSave: (name: string) => void;
}) => {
  const [draft, setDraft] = useState<string | null>(null);
  const save = (): void => {
    const next = draft?.trim();
    setDraft(null);
    if (next !== undefined && next !== "" && next !== name) {
      onSave(next);
    }
  };
  return (
    <Input
      disabled={disabled}
      id="workspace-name"
      maxLength={80}
      onBlur={save}
      onChange={(event) => {
        setDraft(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        }
        if (event.key === "Escape") {
          setDraft(null);
        }
      }}
      value={draft ?? name}
    />
  );
};

const WorkspaceSettings = ({
  organization,
  canChange,
}: {
  organization: Organization;
  canChange: boolean;
}) => {
  const { t, i18n } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const change = (update: Change): void => {
    void run(async (session) => {
      await changeThenRefresh(
        async () => await update(session.organization),
        async () => {
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  const known = zones.some((zone) => zone.value === organization.timeZone);
  const timeZones = [
    ...zones.map((zone) => ({
      value: zone.value,
      label:
        zone.value === "UTC"
          ? i18n._(zone.label)
          : `${i18n._(zone.label)} (${offsetOf(zone.value, i18n.locale)})`,
    })),
    // A zone set some other way is shown as it is named.
    ...(known
      ? []
      : [{ value: organization.timeZone, label: organization.timeZone }]),
  ];
  const domains = organization.signInDomains;
  return (
    <>
      <SettingsSection
        description={t`How your organization is named in Grasp.`}
        title={t({ message: "Workspace", context: "settings section" })}
      >
        <SettingsRow
          description={
            canChange
              ? t`Your company’s name in Grasp.`
              : t`Your company’s name in Grasp. An admin changes it.`
          }
          htmlFor="workspace-name"
          label={t`Name`}
        >
          <NameField
            disabled={!canChange || busy}
            name={organization.name}
            onSave={(name) => {
              change(async (api) => await api.update({ name }));
            }}
          />
        </SettingsRow>
        <SettingsRow
          description={t`People sign in with an address in these domains, through your organization’s account.`}
          label={t`Sign-in domains`}
        >
          <span className="text-muted-foreground">{formatList(domains)}</span>
        </SettingsRow>
      </SettingsSection>
      <SettingsSection
        description={t`Where your data lives, and the time Grasp uses.`}
        title={t`Region`}
      >
        <SettingsRow
          description={t`Everything Grasp stores for your organization stays here.`}
          label={t`Data location`}
        >
          <Badge variant="outline">
            <Trans>European Union</Trans>
          </Badge>
        </SettingsRow>
        <SettingsRow
          description={t`For schedules and the times Grasp shows.`}
          htmlFor="workspace-time-zone"
          label={t`Time zone`}
        >
          <Select
            disabled={!canChange || busy}
            items={timeZones}
            onValueChange={(value: unknown) => {
              if (
                typeof value === "string" &&
                value !== organization.timeZone
              ) {
                change(async (api) => await api.update({ timeZone: value }));
              }
            }}
            value={organization.timeZone}
          >
            <SelectTrigger className="w-full" id="workspace-time-zone">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {timeZones.map((zone) => (
                <SelectItem key={zone.value} value={zone.value}>
                  {zone.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        {failure === undefined ? null : (
          <div className="border-t px-5 py-3">
            <ErrorText>{failure}</ErrorText>
          </div>
        )}
      </SettingsSection>
    </>
  );
};

const Workspace = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  if (page.state !== "ready") {
    return (
      <SettingsSection
        title={t({ message: "Workspace", context: "settings section" })}
      >
        <NotLoadedState heading="h3" page={page} />
      </SettingsSection>
    );
  }
  return (
    <WorkspaceSettings
      canChange={isAdmin(identity.role) && !identity.staff}
      organization={page.data}
    />
  );
};

export const Route = createFileRoute("/_shell/settings/workspace")({
  pendingComponent: SettingsLoading,
  errorComponent: SettingsError,
  component: Workspace,
  loader: async ({ context: { core } }) =>
    await loadFromCore(
      core,
      async (session) => await session.organization.get()
    ),
});
