import { employeeDomainsMax, quietPulse } from "@grasp-os/shared/org-settings";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Input } from "@grasp-os/ui/components/input";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import {
  noPeopleFilters,
  PulseCoverage,
  PulseTable,
} from "../settings/pulse-people.tsx";
import type { PeopleFilters } from "../settings/pulse-people.tsx";
import type { PulsePerson } from "../settings/pulse.ts";
import { useQueuedSave } from "../settings/queued-save.ts";
import {
  SettingsError,
  SettingsLoading,
  SettingsRow,
  SettingsSection,
} from "../settings/settings-parts.tsx";
import { WeekHours } from "../settings/week-hours.tsx";

// Settings → Pulse, for admins, as in the prototype
// (`routes/settings/pulse.tsx`): who has it, when it may report, who counts
// as an employee, and every person and device. Core keeps when it may
// report and the employee domains (`orgSettings.pulse()`), which the
// organization's own admins change here, each change saved at once; no
// device reports to core yet, so nobody is listed as having it.

/** Nobody has Pulse until core knows of the devices it runs on. */
const directory: readonly PulsePerson[] = [];

/** A domain as typed: lowercase, without spaces or a leading `@`. */
const typedDomain = (typed: string): string =>
  typed.trim().toLowerCase().replace(/^@/u, "");

/** The domains as chips, each removable, and a field to add one. */
const Domains = ({
  domains,
  disabled,
  onChange,
}: {
  domains: readonly string[];
  disabled: boolean;
  onChange: (domains: string[]) => void;
}) => {
  const { t } = useLingui();
  const [draft, setDraft] = useState("");
  const add = (): void => {
    const domain = typedDomain(draft);
    setDraft("");
    if (domain !== "" && !domains.includes(domain)) {
      onChange([...domains, domain]);
    }
  };
  const full = domains.length >= employeeDomainsMax;
  return (
    <div className="flex w-full flex-col gap-2">
      {domains.length === 0 ? (
        <span className="text-muted-foreground">
          <Trans context="nothing set">None</Trans>
        </span>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {domains.map((domain) => (
            <Badge key={domain} variant="secondary">
              {domain}
              {disabled ? null : (
                <button
                  aria-label={t`Remove ${domain}`}
                  onClick={() => {
                    onChange(domains.filter((each) => each !== domain));
                  }}
                  type="button"
                >
                  <XIcon />
                </button>
              )}
            </Badge>
          ))}
        </div>
      )}
      {disabled || full ? null : (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
        >
          <Input
            aria-label={t`Employee email domain`}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            placeholder="acme.com"
            value={draft}
          />
          <Button
            disabled={typedDomain(draft) === ""}
            size="sm"
            type="submit"
            variant="outline"
          >
            <Trans>Add</Trans>
          </Button>
        </form>
      )}
    </div>
  );
};

/**
 * Pulse: who has it, when it may report, and every person and device.
 * It sees which apps are used, never what is in them.
 */
const PulsePage = () => {
  const { t } = useLingui();
  const page = Route.useLoaderData();
  const { identity } = Route.useRouteContext();
  const { failure, save } = useQueuedSave(
    page.state === "ready" ? page.data : quietPulse,
    async (session, next) => await session.orgSettings.updatePulse(next)
  );
  const [filters, setFilters] = useState<PeopleFilters>(noPeopleFilters);
  const people = directory.length;
  if (page.state !== "ready") {
    return (
      <SettingsSection title="Pulse">
        <NotLoadedState heading="h3" page={page} />
      </SettingsSection>
    );
  }
  const settings = page.data;
  // Only the organization's own admins change them; Grasp staff read them.
  const canChange = !identity.staff;

  return (
    <>
      <ErrorText>{failure}</ErrorText>
      <SettingsSection
        description={t`Runs on company laptops and sees which apps and AI tools are used, never what is in them. Not rolled out yet.`}
        title="Pulse"
      >
        <PulseCoverage
          onShow={(status) => {
            setFilters({ ...noPeopleFilters, status: [status] });
          }}
          people={directory}
        />
      </SettingsSection>

      <SettingsSection
        description={t`Per day, the hours it may report in. Outside them, Pulse stays quiet.`}
        title={t`When Pulse may report`}
      >
        <WeekHours
          onChange={
            canChange
              ? (schedule) => {
                  save({ schedule });
                }
              : undefined
          }
          value={settings.schedule}
        />
      </SettingsSection>

      <SettingsSection
        description={t`People with these email addresses count as employees.`}
        title={t`Who counts`}
      >
        <SettingsRow
          description={t`Add a domain for a second brand or an old one.`}
          label={t`Employee email domains`}
        >
          <Domains
            disabled={!canChange}
            domains={settings.employeeDomains}
            onChange={(employeeDomains) => {
              save({ employeeDomains });
            }}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        description={t`${plural(people, {
          one: "Everyone in your directory, # person. Problems first.",
          other: "Everyone in your directory, # people. Problems first.",
        })}`}
        title={t`People and devices`}
      >
        <PulseTable
          filters={filters}
          onFiltersChange={setFilters}
          people={directory}
        />
      </SettingsSection>
    </>
  );
};

export const Route = createFileRoute("/_shell/settings/pulse")({
  pendingComponent: SettingsLoading,
  errorComponent: SettingsError,
  component: PulsePage,
  loader: async ({ context: { core } }) =>
    await loadFromCore(
      core,
      async (session) => await session.orgSettings.pulse()
    ),
});
