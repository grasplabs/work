import { Badge } from "@grasp-os/ui/components/badge";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import {
  noPeopleFilters,
  PulseCoverage,
  PulseTable,
} from "../settings/pulse-people.tsx";
import type { PeopleFilters } from "../settings/pulse-people.tsx";
import { quietWeek } from "../settings/pulse.ts";
import type { PulsePerson } from "../settings/pulse.ts";
import {
  SettingsError,
  SettingsRow,
  SettingsSection,
} from "../settings/settings-parts.tsx";
import { WeekHours } from "../settings/week-hours.tsx";

// Settings → Pulse, for admins, as in the prototype
// (`routes/settings/pulse.tsx`): who has it, when it may report, who counts
// as an employee, and every person and device. Pulse isn't part of Grasp
// OS yet: core knows no device, schedule or employee domain, so the page
// is the prototype's with nobody in it, and nothing can be changed.

/** Nobody has Pulse until core knows of the devices it runs on. */
const directory: readonly PulsePerson[] = [];
/** The employee email domains, once core keeps them. */
const domains: readonly string[] = [];

/** The domains as chips, or none. */
const Domains = ({ domains: listed }: { domains: readonly string[] }) => (
  <div className="flex w-full flex-col gap-2">
    {listed.length === 0 ? (
      <span className="text-muted-foreground">
        <Trans>None</Trans>
      </span>
    ) : (
      <div className="flex flex-wrap gap-1.5">
        {listed.map((domain) => (
          <Badge key={domain} variant="secondary">
            {domain}
          </Badge>
        ))}
      </div>
    )}
  </div>
);

/**
 * Pulse: who has it, when it may report, and every person and device.
 * It sees which apps are used, never what is in them.
 */
const Pulse = () => {
  const { t } = useLingui();
  const [filters, setFilters] = useState<PeopleFilters>(noPeopleFilters);
  const people = directory.length;

  return (
    <>
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
        <WeekHours value={quietWeek} />
      </SettingsSection>

      <SettingsSection
        description={t`People with these email addresses count as employees.`}
        title={t`Who counts`}
      >
        <SettingsRow
          description={t`Add a domain for a second brand or an old one.`}
          label={t`Employee email domains`}
        >
          <Domains domains={domains} />
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
  errorComponent: SettingsError,
  component: Pulse,
});
