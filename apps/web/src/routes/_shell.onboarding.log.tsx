import { logActors } from "@grasp-os/shared/onboarding-staff";
import type {
  LogFilter,
  StaffLogEntry,
} from "@grasp-os/shared/onboarding-staff";
import { Button } from "@grasp-os/ui/components/button";
import { Input } from "@grasp-os/ui/components/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { DownloadIcon } from "lucide-react";
import type { ReactNode } from "react";

import { downloadText } from "../export/export-file.tsx";
import { formatDate, formatDateTime } from "../format.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore } from "../load-from-core.tsx";
import { logCsv, logSearchOf, perDay } from "../onboarding/staff-log.ts";
import { actorTitles } from "../onboarding/staff-words.ts";
import {
  SettingsBody,
  SettingsError,
  SettingsSection,
} from "../settings/settings-parts.tsx";

// The onboarding area's log (prototype `org-log.tsx`): what happened at
// the company and what Grasp's staff did, the newest first, narrowed by
// who, what, team and day (in the address), with how much happened on
// each day, and its export as CSV.

/** What the log can be narrowed to by what happened. */
const whatChoices = ["interview", "onboarding"] as const;

interface LogData {
  entries: StaffLogEntry[];
  /** The teams by id, as the roster names them. */
  teams: { id: string; name: string }[];
}

/** One filter: its label above its control. */
const Filter = ({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) => (
  <label className="flex flex-col gap-1">
    <span className="text-muted-foreground text-xs">{label}</span>
    {children}
  </label>
);

const Filters = ({
  filter,
  teams,
}: {
  filter: LogFilter;
  teams: LogData["teams"];
}) => {
  const { t, i18n } = useLingui();
  const navigate = useNavigate({ from: "/onboarding/log" });
  const set = (change: Partial<Record<keyof LogFilter, string>>): void => {
    void navigate({
      replace: true,
      search: (last) => logSearchOf({ ...last, ...change }),
    });
  };
  return (
    <div className="flex flex-wrap gap-3">
      <Filter label={t({ message: "Who", context: "log filter" })}>
        <NativeSelect
          onChange={(event) => {
            set({ actor: event.target.value });
          }}
          value={filter.actor ?? ""}
        >
          <NativeSelectOption value="">
            {t({ message: "Anyone", context: "log filter: who" })}
          </NativeSelectOption>
          {logActors.map((actor) => (
            <NativeSelectOption key={actor} value={actor}>
              {i18n._(actorTitles[actor])}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Filter>
      <Filter label={t({ message: "What", context: "log filter" })}>
        <NativeSelect
          onChange={(event) => {
            set({ what: event.target.value });
          }}
          value={filter.what ?? ""}
        >
          <NativeSelectOption value="">
            {t({ message: "Anything", context: "log filter: what" })}
          </NativeSelectOption>
          {whatChoices.map((what) => (
            <NativeSelectOption key={what} value={what}>
              {what === "interview"
                ? t({ message: "Interviews", context: "log filter: what" })
                : t({ message: "The onboarding", context: "log filter: what" })}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Filter>
      <Filter label={t({ message: "Team", context: "log filter" })}>
        <NativeSelect
          onChange={(event) => {
            set({ team: event.target.value });
          }}
          value={filter.team ?? ""}
        >
          <NativeSelectOption value="">
            {t({ message: "Any team", context: "log filter: team" })}
          </NativeSelectOption>
          {teams.map(({ id, name }) => (
            <NativeSelectOption key={id} value={id}>
              {name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Filter>
      <Filter label={t({ message: "Day", context: "log filter" })}>
        <Input
          className="w-40"
          onChange={(event) => {
            set({ day: event.target.value });
          }}
          type="date"
          value={filter.day ?? ""}
        />
      </Filter>
    </div>
  );
};

/** How much happened on each day, as bars, the oldest on the left. */
const DayChart = ({ entries }: { entries: StaffLogEntry[] }) => {
  const days = perDay(entries);
  const most = Math.max(1, ...days.map(({ count }) => count));
  if (days.length === 0) {
    return null;
  }
  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="text-muted-foreground text-xs">
        <Trans>Per day</Trans>
      </figcaption>
      {/* The entries below say the same in words; the bars are for the eye. */}
      <svg
        aria-hidden="true"
        className="h-24 w-full"
        preserveAspectRatio="none"
        viewBox={`0 0 ${days.length} ${most}`}
      >
        {days.map(({ day, count }, index) => {
          const date = formatDate(`${day}T12:00:00Z`);
          return (
            <rect
              className="fill-primary/70"
              height={count}
              key={day}
              width={0.8}
              x={index + 0.1}
              y={most - count}
            >
              <title>
                {plural(count, {
                  one: `${date}: # entry`,
                  other: `${date}: # entries`,
                })}
              </title>
            </rect>
          );
        })}
      </svg>
    </figure>
  );
};

const LogExport = ({ entries }: { entries: StaffLogEntry[] }) => (
  <Button
    disabled={entries.length === 0}
    onClick={() => {
      const day = new Date().toISOString().slice(0, 10);
      downloadText(
        `onboarding-log-${day}.csv`,
        logCsv(entries),
        "text/csv;charset=utf-8"
      );
    }}
    variant="outline"
  >
    <DownloadIcon aria-hidden="true" />
    <Trans>Export CSV</Trans>
  </Button>
);

const Entries = ({ data }: { data: LogData }) => {
  const { i18n } = useLingui();
  const teamName = new Map(data.teams.map(({ id, name }) => [id, name]));
  if (data.entries.length === 0) {
    return (
      <p className="text-muted-foreground border-t px-5 py-4">
        <Trans>Nothing happened that matches.</Trans>
      </p>
    );
  }
  return (
    <ol>
      {data.entries.map((entry) => (
        <li
          className="flex flex-col gap-0.5 border-t px-5 py-3 sm:flex-row sm:items-baseline sm:gap-4"
          key={entry.seq}
        >
          <time
            className="text-muted-foreground w-40 flex-none text-xs"
            dateTime={entry.at}
          >
            {formatDateTime(entry.at)}
          </time>
          <span className="w-44 flex-none">
            {i18n._(actorTitles[entry.actor])}
          </span>
          <code className="min-w-0 flex-1 truncate text-xs">{entry.what}</code>
          {entry.person === null ? null : (
            <span className="text-muted-foreground truncate">
              {entry.team === null
                ? entry.person.name
                : `${entry.person.name} · ${teamName.get(entry.team) ?? entry.team}`}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
};

const Log = () => {
  const { t } = useLingui();
  const log = Route.useLoaderData();
  const filter = Route.useSearch();
  return (
    <SettingsSection
      action={
        log.state === "ready" ? <LogExport entries={log.data.entries} /> : null
      }
      description={t`What happened at the company and what Grasp's staff did, the newest first.`}
      title={t`Log`}
    >
      <SettingsBody>
        <Filters
          filter={filter}
          teams={log.state === "ready" ? log.data.teams : []}
        />
        {log.state === "ready" ? <DayChart entries={log.data.entries} /> : null}
      </SettingsBody>
      {log.state === "ready" ? (
        <Entries data={log.data} />
      ) : (
        <div className="border-t">
          <NotLoadedState heading="h3" page={log} />
        </div>
      )}
    </SettingsSection>
  );
};

export const Route = createFileRoute("/_shell/onboarding/log")({
  validateSearch: (search: Record<string, unknown>): LogFilter =>
    logSearchOf(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ context: { core }, deps }) =>
    await loadFromCore(core, async (session): Promise<LogData> => {
      const [entries, view] = await Promise.all([
        session.onboardingStaff.log(deps),
        session.onboarding.view(),
      ]);
      return {
        entries,
        teams: (view.roster?.teams ?? []).map(({ id, name }) => ({ id, name })),
      };
    }),
  errorComponent: SettingsError,
  component: Log,
});
