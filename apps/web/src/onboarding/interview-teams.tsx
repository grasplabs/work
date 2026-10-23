import { funnelOf, talkedByDay } from "@grasp-os/shared/admin/admin-interviews";
import type { Funnel } from "@grasp-os/shared/admin/admin-interviews";
import {
  listenDays,
  REMIND_AFTER,
} from "@grasp-os/shared/admin/onboarding-admin";
import type {
  OrgView,
  TeamView,
} from "@grasp-os/shared/admin/onboarding-admin";
import { Button } from "@grasp-os/ui/components/button";
import { Progress } from "@grasp-os/ui/components/progress";
import { cn } from "@grasp-os/ui/lib/utils";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { BellIcon } from "lucide-react";

import { ErrorText } from "../error-text.tsx";
import { SettingsSection } from "../settings/settings-parts.tsx";
import {
  dayDate,
  funnelSteps,
  funnelTitles,
  standsText,
  talkedText,
} from "./interview-words.ts";
import { useInterviewAction } from "./use-interview-action.ts";

// The interviews team by team (prototype `org-progress.tsx`): how far
// everyone who is asked has come with their link, how many had talked by
// each day, and every team with the one thing to do there: the one
// reminder, or asking in a team that was left out.

/** How far everyone has come, as five bars: each as long as its share of everyone who is asked. */
const FunnelBars = ({ funnel }: { funnel: Funnel }) => {
  const { t, i18n } = useLingui();
  return (
    <ul
      aria-label={t`How far everyone has come`}
      className="bg-card flex flex-col justify-center gap-2.5 px-5 py-5"
    >
      {funnelSteps.map((step) => {
        const label = i18n._(funnelTitles[step]);
        return (
          <li
            className="grid grid-cols-[5.5rem_minmax(0,1fr)_2.5rem] items-center gap-3"
            key={step}
          >
            <span
              className={cn(
                "truncate",
                step === "talked" ? undefined : "text-muted-foreground"
              )}
            >
              {label}
            </span>
            <Progress
              aria-label={label}
              max={Math.max(funnel.asked, 1)}
              value={funnel[step]}
            />
            <span className="text-right tabular-nums">{funnel[step]}</span>
          </li>
        );
      })}
    </ul>
  );
};

/** How many had talked by each day so far, against everyone who is asked. */
const TalkedDays = ({ view, asked }: { view: OrgView; asked: number }) => {
  const { t } = useLingui();
  if (!view.told) {
    return (
      <div className="bg-card flex flex-col justify-center gap-1 px-5 py-5">
        <span className="font-medium">{t`Talked, day by day`}</span>
        <span className="text-muted-foreground">
          {t`Starts the day the company tells its team.`}
        </span>
      </div>
    );
  }
  const days = talkedByDay(view);
  const talked = days.findLast((each) => each.total !== null)?.total ?? 0;
  const { day } = view;
  const of = listenDays(view.org);
  const most = Math.max(asked, 1);
  return (
    <figure className="bg-card flex flex-col gap-3 px-5 py-4">
      <figcaption className="flex items-baseline justify-between gap-3">
        <span className="font-medium">{t`Talked, day by day`}</span>
        <span className="text-muted-foreground text-xs tabular-nums">
          {t`${talked} of ${asked} by day ${day} of ${of}`}
        </span>
      </figcaption>
      {/* The numbers above say it in words; the bars, against everyone asked, are for the eye. */}
      <svg
        aria-hidden="true"
        className="h-24 w-full"
        preserveAspectRatio="none"
        viewBox={`0 0 ${days.length} ${most}`}
      >
        {days.map((each) => (
          <rect
            className={each.total === null ? "fill-muted" : "fill-primary/70"}
            height={each.total ?? most}
            key={each.day}
            width={0.8}
            x={each.day + 0.1}
            y={most - (each.total ?? most)}
          >
            <title>{`${dayDate(view, each.day)}: ${each.total ?? "–"}`}</title>
          </rect>
        ))}
      </svg>
    </figure>
  );
};

/** The one thing to do for a team: ask it in, or remind whoever may be. */
const TeamAction = ({ view, team }: { view: OrgView; team: TeamView }) => {
  const { t } = useLingui();
  const { busy, failure, act } = useInterviewAction();
  const { name } = team.team;
  const waiting = team.people
    .filter((each) => each.mayRemind)
    .map((each) => each.person.id);
  const count = waiting.length;
  let button = null;
  if (team.off) {
    button = (
      <Button
        aria-label={t`Ask ${name} in`}
        disabled={busy || view.closed}
        onClick={() => {
          act(async (staff) => {
            await staff.askIn(team.team.id);
          });
        }}
        size="sm"
        variant="outline"
      >
        {t`Ask it in`}
      </Button>
    );
  } else if (count > 0) {
    button = (
      <Button
        aria-label={t`Note the reminder for ${name}`}
        disabled={busy}
        onClick={() => {
          act(async (staff) => {
            await staff.remind(waiting);
          });
        }}
        size="sm"
        variant="ghost"
      >
        <BellIcon data-icon="inline-start" />
        {t`Mark ${count} reminded`}
      </Button>
    );
  }
  return (
    <span className="col-start-2 row-start-1 flex flex-col items-end gap-1 md:col-start-auto md:row-start-auto">
      {button}
      <ErrorText>{failure}</ErrorText>
    </span>
  );
};

/** One team in the list: who leads it and where it stands, how many talked, and what to do. */
const TeamRow = ({ view, team }: { view: OrgView; team: TeamView }) => {
  const { i18n } = useLingui();
  const { lead, next } = team;
  const talked = team.counts.completed;
  const people = team.people.length;
  const line = [
    lead !== null && next.kind !== "lead" ? lead.person.name : "",
    standsText(i18n, view, team),
  ]
    .filter((part) => part !== "")
    .join(" · ");
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-5 gap-y-2 border-t px-5 py-3 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_minmax(0,9rem)]">
      <span className="flex min-w-0 flex-col">
        <span className={cn("truncate", team.off && "text-muted-foreground")}>
          {team.team.name}
        </span>
        <span
          className={cn(
            "truncate text-xs",
            next.kind === "lead" && next.reminded
              ? "text-status-attention"
              : "text-muted-foreground"
          )}
        >
          {line}
        </span>
      </span>
      <span className="col-span-2 row-start-2 flex min-w-0 items-center gap-4 md:col-span-1 md:row-start-auto">
        {team.off || !view.told ? (
          <span className="text-muted-foreground text-xs tabular-nums">
            {plural(people, { one: "# person", other: "# people" })}
          </span>
        ) : (
          <>
            <Progress
              aria-label={talkedText(i18n, talked, team.asked)}
              className="min-w-0 flex-1"
              max={Math.max(team.asked, 1)}
              value={talked}
            />
            <span
              aria-hidden="true"
              className="text-muted-foreground flex-none text-xs tabular-nums"
            >
              {talkedText(i18n, talked, team.asked)}
            </span>
          </>
        )}
      </span>
      <TeamAction team={team} view={view} />
    </li>
  );
};

/**
 * Where the interviews stand, in one look: how far everyone who is asked
 * has come, how many had talked by each day, and every team.
 */
export const InterviewTeams = ({ view }: { view: OrgView }) => {
  const { t } = useLingui();
  const { busy, failure, act } = useInterviewAction();
  if (view.teams.length === 0) {
    return (
      <p className="bg-card text-muted-foreground rounded-xl border px-5 py-4 text-sm">
        {t`Nobody is known here yet. The people come with the company's own list.`}
      </p>
    );
  }
  const funnel = funnelOf(view);
  const after = REMIND_AFTER;
  // The links close at the end of the plan's last day, counting its first as day 0.
  const lastDay = dayDate(view, listenDays(view.org) - 1);
  let links = t`The links go out once the company has told its team.`;
  if (view.closed) {
    links = t`The links closed after ${lastDay}.`;
  } else if (view.told) {
    links = t`The links work until ${lastDay}.`;
  }
  const count = funnel.toRemind.length;
  return (
    <>
      <SettingsSection
        action={
          count > 0 ? (
            <span className="flex flex-col items-end gap-1">
              <Button
                disabled={busy}
                onClick={() => {
                  act(async (staff) => {
                    await staff.remind(funnel.toRemind);
                  });
                }}
                size="sm"
                variant="outline"
              >
                <BellIcon data-icon="inline-start" />
                {t`Mark ${count} reminded`}
              </Button>
              <ErrorText>{failure}</ErrorText>
            </span>
          ) : null
        }
        description={`${t`Team leads go first, then their team. One reminder after ${after} working days, sent by hand with their own link, then nothing.`} ${links}`}
        title={t`Where everyone stands`}
      >
        <div className="bg-border grid gap-px border-t lg:grid-cols-2">
          <FunnelBars funnel={funnel} />
          <TalkedDays asked={funnel.asked} view={view} />
        </div>
      </SettingsSection>
      <SettingsSection
        description={t`Every team, whether it takes part or not. A team that was left out can be asked in: its lead gets a link first.`}
        title={t({ message: "Teams", context: "every team of the company" })}
      >
        <ul className="flex flex-col">
          {view.teams.map((team) => (
            <TeamRow key={team.team.id} team={team} view={view} />
          ))}
        </ul>
      </SettingsSection>
    </>
  );
};
