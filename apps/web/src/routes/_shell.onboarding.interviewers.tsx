import type { InterviewPhase } from "@grasp-os/shared/interview-turn";
import { interviewerNames } from "@grasp-os/shared/onboarding";
import type { Interviewer } from "@grasp-os/shared/onboarding";
import type {
  StaffAnswerDay,
  StaffInterviewer,
  StaffInterviewerText,
  StaffInterviewers,
} from "@grasp-os/shared/onboarding-staff";
import { Progress } from "@grasp-os/ui/components/progress";
import { Stat } from "@grasp-os/ui/components/stat";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { cn } from "@grasp-os/ui/lib/utils";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { formatDay, formatNumber, formatPercent } from "../format.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import { localeNames } from "../i18n.ts";
import { loadFromCore } from "../load-from-core.tsx";
import {
  BarList,
  Figure,
  formatDecimal,
} from "../onboarding/staff-figures.tsx";
import { phaseTitles } from "../onboarding/staff-words.ts";
import {
  SettingsBody,
  SettingsError,
  SettingsSection,
} from "../settings/settings-parts.tsx";

// How Stephen and Claire are doing in this onboarding (GRA-324), as in
// the prototype's "How he is doing" (`components/admin/org-stephen.tsx`),
// each apart: what the people who talked to them thought of it, how many
// who started also finished, how long it takes, how much of what they
// wrote down people left in, where people stop, and the text each
// interview ran on. Then how long people wait for the first sound of an
// answer, day by day. Numbers only, never who said what: core sends no
// more (onboarding/interviewer-numbers.ts).

/** The parts someone can stop in: the hello has no question yet. */
const stopPhases: readonly InterviewPhase[] = [
  "you",
  "anchor",
  "story",
  "steps",
  "exceptions",
  "numbers",
  "result",
  "readback",
];

/** A wait in seconds, as the page's language writes it: "1.2 s". */
const formatSeconds = (ms: number, locale: string): string =>
  new Intl.NumberFormat(locale, {
    style: "unit",
    unit: "second",
    unitDisplay: "short",
    maximumFractionDigits: 1,
  }).format(ms / 1000);

/** How the start of a text's mark shows: enough to tell it apart. */
const markShown = 12;

const Rating = ({ numbers }: { numbers: StaffInterviewer }) => {
  const { t } = useLingui();
  const name = interviewerNames[numbers.interviewer];
  const { count, average, by } = numbers.rating;
  const { finished } = numbers;
  const full = Math.round(average ?? 0);
  const score = formatDecimal(average ?? 0);
  return (
    <div className="bg-card flex flex-col gap-4 px-5 py-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 className="font-medium">{t`What people thought of ${name}`}</h2>
        <p className="text-muted-foreground">
          {count === 0
            ? t`Nobody has said yet. At the end of their interview, people can say how it was: from 1 to 5.`
            : t`${count} of ${finished} said how it was, at the end of their interview.`}
        </p>
      </div>
      {average === null ? null : (
        <div className="grid items-center gap-x-8 gap-y-4 sm:grid-cols-[auto_minmax(0,1fr)]">
          <div className="flex flex-col gap-1.5">
            <Stat>{t`${score} of 5`}</Stat>
            <span aria-hidden className="flex gap-1">
              {[1, 2, 3, 4, 5].map((rating) => (
                <span
                  className={cn(
                    "size-2.5 rounded-full",
                    rating <= full ? "bg-foreground" : "bg-border"
                  )}
                  key={rating}
                />
              ))}
            </span>
          </div>
          <BarList
            label={t`How many gave each`}
            rows={[5, 4, 3, 2, 1].map((rating) => {
              let label = String(rating);
              if (rating === 5) {
                label = t`5, very good`;
              } else if (rating === 1) {
                label = t`1, not good`;
              }
              return { id: String(rating), label, value: by[rating - 1] ?? 0 };
            })}
          />
        </div>
      )}
    </div>
  );
};

/** What the minutes of an interview come with: a lead's, beside someone's own. */
const MinutesFigure = ({ numbers }: { numbers: StaffInterviewer }) => {
  const { t } = useLingui();
  const own =
    numbers.minutes.own === null ? null : Math.round(numbers.minutes.own);
  const lead =
    numbers.minutes.lead === null ? null : Math.round(numbers.minutes.lead);
  return (
    <Figure
      label={t`Minutes an interview`}
      sub={
        own !== null && lead !== null ? t`${lead} for a team lead` : undefined
      }
      value={own ?? lead ?? "–"}
    />
  );
};

const Doing = ({ numbers }: { numbers: StaffInterviewer }) => {
  const { t } = useLingui();
  const { started, finished, leftIn, byVoice } = numbers;
  return (
    <section className="bg-border grid gap-px overflow-hidden rounded-xl border text-sm lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <Rating numbers={numbers} />
      <div className="bg-border grid grid-cols-2 gap-px">
        <Figure
          label={t`Finished`}
          ring={{ value: finished, of: started }}
          sub={t`who started also agreed`}
          value={t`${finished} of ${started}`}
        />
        <MinutesFigure numbers={numbers} />
        <Figure
          label={t`Left in`}
          ring={leftIn === null ? undefined : { value: leftIn, of: 1 }}
          sub={t`of what they wrote down`}
          value={leftIn === null ? "–" : formatPercent(leftIn)}
        />
        <Figure
          label={t`By voice`}
          ring={byVoice === null ? undefined : { value: byVoice, of: 1 }}
          sub={t`the rest typed`}
          value={byVoice === null ? "–" : formatPercent(byVoice)}
        />
      </div>
    </section>
  );
};

/** Who people chose to talk with, as bars on one scale, and what the ones who said so thought of it. */
const Chose = ({ all }: { all: StaffInterviewer[] }) => {
  const { t } = useLingui();
  const most = Math.max(1, ...all.map((each) => each.started));
  return (
    <SettingsSection
      description={t`Everyone chooses at the start of their interview. The questions are the same, whoever asks them.`}
      title={t`Who people chose`}
    >
      <ul
        aria-label={t`Who people chose`}
        className="grid grid-cols-[minmax(0,max-content)_minmax(4rem,1fr)_auto_auto] items-center gap-x-4 gap-y-3 border-t px-5 py-4"
      >
        {all.map((each) => {
          const name = interviewerNames[each.interviewer];
          const { average } = each.rating;
          const score = formatDecimal(average ?? 0);
          return (
            <li
              className="col-span-4 grid grid-cols-subgrid items-center"
              key={each.interviewer}
            >
              <span>{name}</span>
              <Progress aria-label={name} max={most} value={each.started} />
              <span className="text-right tabular-nums">{each.started}</span>
              <span className="text-muted-foreground text-right tabular-nums">
                {average === null ? "–" : t`${score} of 5`}
              </span>
            </li>
          );
        })}
      </ul>
    </SettingsSection>
  );
};

const Stops = ({ numbers }: { numbers: StaffInterviewer }) => {
  const { t, i18n } = useLingui();
  const { stopped } = numbers;
  return (
    <SettingsSection
      description={
        stopped === 0
          ? t`Nobody stopped halfway.`
          : plural(stopped, {
              one: "# interview stopped halfway and was not picked up again.",
              other:
                "# interviews stopped halfway and were not picked up again.",
            })
      }
      title={t`Where people stop`}
    >
      {stopped === 0 ? null : (
        <SettingsBody>
          <BarList
            label={t`Where people stop`}
            rows={stopPhases.map((phase) => ({
              id: phase,
              label: i18n._(phaseTitles[phase]),
              value: numbers.stops[phase],
            }))}
          />
        </SettingsBody>
      )}
    </SettingsSection>
  );
};

const Lengths = ({ numbers }: { numbers: StaffInterviewer }) => {
  const { t } = useLingui();
  const { lengths } = numbers;
  return (
    <SettingsSection
      description={t`The interviews people agreed to, by how many minutes they took.`}
      title={t`How long they take`}
    >
      <SettingsBody>
        <BarList
          label={t`How long they take`}
          rows={lengths.map(({ upTo, count }, index) => {
            const from = index === 0 ? 0 : (lengths[index - 1]?.upTo ?? 0);
            const next = from + 1;
            let label = t`${next}–${upTo} minutes`;
            if (upTo === null) {
              label = t`Over ${from} minutes`;
            } else if (index === 0) {
              label = t`Up to ${upTo} minutes`;
            }
            return { id: String(upTo), label, value: count };
          })}
        />
      </SettingsBody>
    </SettingsSection>
  );
};

/** One text the interviews ran on: its mark, what and in which language, and how they went. */
const TextRow = ({ text }: { text: StaffInterviewerText }) => {
  const { t } = useLingui();
  const { started, finished } = text;
  const { average } = text.rating;
  const score = formatDecimal(average ?? 0);
  let kind = "";
  if (text.kind === "own") {
    kind = t`Someone's own work`;
  } else if (text.kind === "lead") {
    kind = t`A lead's team`;
  }
  const language = text.locale === null ? "" : localeNames[text.locale];
  return (
    <TableRow>
      <TableCell variant="section">
        {text.mark === null ? (
          <span className="text-muted-foreground">{t`From before marks were kept`}</span>
        ) : (
          <code className="font-mono text-xs" title={text.mark}>
            {text.mark.slice(0, markShown)}
          </code>
        )}
      </TableCell>
      <TableCell variant="section">
        {[kind, language].filter((each) => each !== "").join(" · ")}
      </TableCell>
      <TableCell className="text-right" variant="section">
        <span className="tabular-nums">{started}</span>
      </TableCell>
      <TableCell className="text-right" variant="section">
        <span className="tabular-nums">{finished}</span>
      </TableCell>
      <TableCell className="text-right" variant="section">
        <span className="tabular-nums">
          {average === null ? "–" : t`${score} of 5`}
        </span>
      </TableCell>
    </TableRow>
  );
};

const Texts = ({ numbers }: { numbers: StaffInterviewer }) => {
  const { t } = useLingui();
  const name = interviewerNames[numbers.interviewer];
  return (
    <SettingsSection
      description={t`What ${name} is told changes only through the Stephen Lab, a version at a time. Each version has a mark, the same here and in the lab.`}
      title={t`The text each interview ran on`}
    >
      <div className="border-t">
        <Table aria-label={t`The text each interview ran on`}>
          <TableHeader>
            <TableRow>
              <TableHead variant="section">{t`Version`}</TableHead>
              <TableHead variant="section">{t`For`}</TableHead>
              <TableHead
                className="text-right"
                variant="section"
              >{t`Started`}</TableHead>
              <TableHead
                className="text-right"
                variant="section"
              >{t`Finished`}</TableHead>
              <TableHead
                className="text-right"
                variant="section"
              >{t`Rating`}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {numbers.texts.map((text) => (
              <TextRow key={text.mark ?? "before"} text={text} />
            ))}
          </TableBody>
        </Table>
      </div>
    </SettingsSection>
  );
};

/** How long people waited for the first sound of an answer, day by day, the newest first. */
const Waits = ({ days }: { days: StaffAnswerDay[] }) => {
  const { t, i18n } = useLingui();
  return (
    <SettingsSection
      description={t`From the end of what someone said to the first sound of the answer, measured on their own page while they talk by voice: the middle answer of each day, and the one nine in ten were faster than.`}
      title={t`Waiting for the answer`}
    >
      {days.length === 0 ? (
        <SettingsBody>
          <p className="text-muted-foreground">{t`Nothing measured yet.`}</p>
        </SettingsBody>
      ) : (
        <div className="border-t">
          <Table aria-label={t`Waiting for the answer`}>
            <TableHeader>
              <TableRow>
                <TableHead variant="section">{t`Day`}</TableHead>
                <TableHead
                  className="text-right"
                  variant="section"
                >{t`Answers`}</TableHead>
                <TableHead
                  className="text-right"
                  variant="section"
                >{t`Middle`}</TableHead>
                <TableHead
                  className="text-right"
                  variant="section"
                >{t`Nine in ten`}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {days.toReversed().map((day) => (
                <TableRow key={day.day}>
                  <TableCell variant="section">{formatDay(day.day)}</TableCell>
                  <TableCell className="text-right" variant="section">
                    <span className="tabular-nums">
                      {formatNumber(day.answers)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right" variant="section">
                    <span className="tabular-nums">
                      {formatSeconds(day.middle, i18n.locale)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right" variant="section">
                    <span className="tabular-nums">
                      {formatSeconds(day.slow, i18n.locale)}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </SettingsSection>
  );
};

const Numbers = ({ numbers }: { numbers: StaffInterviewers }) => {
  const { t } = useLingui();
  const [shown, setShown] = useState<Interviewer>("stephen");
  const all = numbers.interviewers;
  const one = all.find((each) => each.interviewer === shown);
  if (all.every((each) => each.started === 0)) {
    return (
      <>
        <SettingsSection
          description={t`Their numbers show once the first person starts their interview.`}
          title={t`No interviews yet`}
        />
        <Waits days={numbers.answers} />
      </>
    );
  }
  return (
    <>
      <Chose all={all} />
      <ToggleGroup
        aria-label={t`Whose numbers to show`}
        onValueChange={(chosen: string[]) => {
          const next = all.find((each) => each.interviewer === chosen[0]);
          if (next !== undefined) {
            setShown(next.interviewer);
          }
        }}
        size="sm"
        spacing={0}
        value={[shown]}
        variant="outline"
      >
        {all.map((each) => (
          <ToggleGroupItem key={each.interviewer} value={each.interviewer}>
            {interviewerNames[each.interviewer]}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {one === undefined ? null : (
        <>
          <Doing numbers={one} />
          <div className="grid items-start gap-6 lg:grid-cols-2">
            <Stops numbers={one} />
            <Lengths numbers={one} />
          </div>
          {one.texts.length === 0 ? null : <Texts numbers={one} />}
        </>
      )}
      <Waits days={numbers.answers} />
    </>
  );
};

const Interviewers = () => {
  const loaded = Route.useLoaderData();
  if (loaded.state !== "ready") {
    return (
      <div className="bg-card overflow-hidden rounded-xl border">
        <NotLoadedState heading="h2" page={loaded} />
      </div>
    );
  }
  return <Numbers numbers={loaded.data} />;
};

export const Route = createFileRoute("/_shell/onboarding/interviewers")({
  loader: async ({ context: { core } }) =>
    await loadFromCore(
      core,
      async (session) => await session.onboardingStaff.interviewers()
    ),
  errorComponent: SettingsError,
  component: Interviewers,
});
