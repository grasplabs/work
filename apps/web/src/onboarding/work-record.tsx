import { missingOf } from "@grasp-os/shared/admin/admin-missing";
import type { Missing } from "@grasp-os/shared/admin/admin-missing";
import type { OrgView } from "@grasp-os/shared/admin/onboarding-admin";
import type {
  StepWay,
  WorkRecord as RecordOfWork,
} from "@grasp-os/shared/admin/onboarding-admin-record";
import type {
  DrawnNumber,
  StaffDrawing,
} from "@grasp-os/shared/admin/org-record";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { cn } from "@grasp-os/ui/lib/utils";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  BellIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleHelpIcon,
  HashIcon,
  ListOrderedIcon,
  MessageCircleQuestionIcon,
  RefreshCcwIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import { ErrorText } from "../error-text.tsx";
import { formatList, formatPercent } from "../format.ts";
import { SettingsSection } from "../settings/settings-parts.tsx";
import { dayDate, tagTitles } from "./interview-words.ts";
import { useInterviewAction } from "./use-interview-action.ts";
import { WorkCanvas } from "./work-canvas.tsx";
import { StandingDot } from "./work-list.tsx";
import { isKnown, standingOf, standingTitles } from "./work-words.ts";

// One piece of work in Grasp's onboarding area (prototype
// `work-record.tsx`): its steps on the canvas as it runs today, and beside
// them what is still missing before it counts as known, with who could
// say it. A step opens who told it, and how. Under the canvas, the record
// it rests on: who told which step, what goes around the steps, the
// numbers as the range people gave and each person's own beside it, and
// who it was heard from. Nothing here is averaged. Grasp can count the
// work as known by hand, leave it to the rules again, or draw it again.

/** How one person told a step, as a dot: as most do, the other way, or not at all. */
const wayClass: Record<StepWay, string> = {
  main: "bg-foreground",
  other: "border-foreground border-2",
  none: "bg-border",
};

const WayDot = ({ way }: { way: StepWay }) => (
  <span
    aria-hidden="true"
    className={cn("size-2 flex-none rounded-full", wayClass[way])}
  />
);

/** Something done, in the colour of agreed. */
const Done = ({ children }: { children: ReactNode }) => (
  <span className="text-muted-foreground flex items-center gap-1.5">
    <CheckIcon
      aria-hidden="true"
      className="text-status-agreed size-4 flex-none"
    />
    {children}
  </span>
);

/** One number and what it counts. */
const Tile = ({ value, label }: { value: ReactNode; label: string }) => (
  <div className="bg-card flex flex-col gap-0.5 px-5 py-4">
    <span className="text-2xl leading-tight font-medium tabular-nums">
      {value}
    </span>
    <span className="text-muted-foreground">{label}</span>
  </div>
);

const missingIcons: Record<Missing["kind"], LucideIcon> = {
  difference: CircleAlertIcon,
  people: UsersIcon,
  step: ListOrderedIcon,
  steps: ListOrderedIcon,
  number: HashIcon,
  around: CircleHelpIcon,
  question: MessageCircleQuestionIcon,
};

/** A line of what is still missing: what it is, a line under it, and what can be done. */
interface MissingLine {
  text: string;
  sub?: string;
  action?: ReactNode;
}

/**
 * What a piece of work still lacks, one a line, the most pressing first:
 * who could say it, the one reminder to whoever has not talked, and a
 * step that opens on the canvas.
 */
const MissingList = ({
  missing,
  waiting,
  remindable,
  busy,
  onRemind,
  onStep,
}: {
  missing: Missing[];
  /** The names of who does it and has not talked. */
  waiting: string[];
  /** How many of them the one reminder can still go to. */
  remindable: number;
  busy: boolean;
  onRemind: () => void;
  onStep: (index: number) => void;
}) => {
  const { t } = useLingui();
  if (missing.length === 0) {
    return <Done>{t`Nothing is missing.`}</Done>;
  }
  const lineOf = (each: Missing): MissingLine => {
    if (each.kind === "difference") {
      const number = each.step + 1;
      return {
        text: t`Step ${number} is told two ways, and nobody can say why`,
        sub: each.text,
      };
    }
    if (each.kind === "people") {
      const notTalked = each.count;
      // How many the one reminder can still be marked for.
      const count = remindable;
      return {
        text: plural(notTalked, {
          one: "# person who does it has not talked",
          other: "# people who do it have not talked",
        }),
        sub: formatList(waiting),
        action:
          remindable > 0 ? (
            <Button
              disabled={busy}
              onClick={onRemind}
              size="xs"
              variant="outline"
            >
              <BellIcon data-icon="inline-start" />
              {t`Mark ${count} reminded`}
            </Button>
          ) : undefined,
      };
    }
    if (each.kind === "step") {
      const number = each.step + 1;
      const { people, needed } = each;
      return {
        text: t`Step ${number}: ${people} of ${needed} needed told it`,
        sub: each.text,
        action: (
          <Button
            aria-label={t`Show step ${number}`}
            onClick={() => {
              onStep(each.step);
            }}
            size="xs"
            variant="ghost"
          >
            {t`Show`}
          </Button>
        ),
      };
    }
    if (each.kind === "steps") {
      const { count } = each;
      const { of, needed } = each;
      return {
        text: t`${count} of ${of} steps are told by too few people`,
        sub: plural(needed, {
          one: "A step counts once # person told it.",
          other:
            "A step counts once # people told it. Who told which is below.",
        }),
      };
    }
    if (each.kind === "number") {
      const numbers = {
        volume: t`Nobody said how many there are`,
        takes: t`Nobody said how long one takes`,
        wrong: t`Nobody said how often one comes in wrong`,
      };
      return { text: numbers[each.which] };
    }
    if (each.kind === "around") {
      const parts = {
        starts: t`Nobody said what starts it`,
        right: t`Nobody said what done right looks like`,
        next: t`Nobody said who gets it next`,
      };
      return { text: parts[each.which] };
    }
    return { text: each.text, sub: t`For the next interview about it.` };
  };
  return (
    <ul aria-label={t`Still missing`} className="-my-1 flex flex-col">
      {missing.map((each, index) => {
        const Icon = missingIcons[each.kind];
        const { text, sub, action } = lineOf(each);
        return (
          <li
            className="flex items-start justify-between gap-3 border-b py-2.5 last:border-b-0"
            key={`${each.kind} ${index}`}
          >
            <span className="flex min-w-0 items-start gap-2.5">
              <Icon
                aria-hidden="true"
                className={cn(
                  "mt-0.5 size-4 flex-none",
                  each.kind === "difference"
                    ? "text-status-attention"
                    : "text-muted-foreground"
                )}
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span>{text}</span>
                {sub === undefined || sub === "" ? null : (
                  <span className="text-muted-foreground text-xs">{sub}</span>
                )}
              </span>
            </span>
            {action === undefined ? null : (
              <span className="flex-none">{action}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
};

/** One step, as the interviews have it: how many told it, and, of a sample's made-up people, who and how. */
const StepEvidence = ({
  record,
  index,
}: {
  record: RecordOfWork;
  index: number;
}) => {
  const { t } = useLingui();
  const step = record.steps[index];
  if (step === undefined) {
    return null;
  }
  const toldAs: Record<StepWay, string> = {
    main: t`Told it`,
    other: t`Another way`,
    none: t`Did not mention it`,
  };
  const { people } = step;
  const { needed } = record;
  return (
    <>
      <div className="flex flex-col gap-2">
        <p>{step.text === "" ? t`Step ${index + 1}` : step.text}</p>
        <p
          className={
            step.enough ? "text-muted-foreground" : "text-status-attention"
          }
        >
          {step.enough
            ? t`${people} told it: enough for it to count.`
            : t`${people} of the ${needed} needed told it.`}
        </p>
      </div>
      {step.other === null ? null : (
        <div className="flex flex-col gap-1">
          <span className="font-medium">{t`Another way`}</span>
          <p>{step.other.text}</p>
          {step.other.explained ? (
            <p className="text-muted-foreground">
              {step.other.because === undefined || step.other.because === ""
                ? t`It depends on the case or the place, so it is a second way the step goes.`
                : step.other.because}
            </p>
          ) : (
            <p className="text-status-attention">
              {t`Nobody can say why. It waits until someone explains it.`}
            </p>
          )}
        </div>
      )}
      {/* Who told what shows only of a sample's made-up people: a real organization's staff see how many, never who (GRA-1084). */}
      {record.byPerson ? (
        <div className="flex flex-col gap-1">
          <span className="font-medium">{t`Who said what`}</span>
          {record.interviews.length === 0 ? (
            <p className="text-muted-foreground">{t`Nobody yet.`}</p>
          ) : (
            <ul className="flex flex-col">
              {record.interviews.map((interview, at) => {
                const way = step.ways[at] ?? "none";
                return (
                  <li
                    className="flex items-center gap-2.5 border-b py-1.5 last:border-b-0"
                    key={interview.id}
                  >
                    <WayDot way={way} />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{interview.person.name}</span>
                      <span className="text-muted-foreground text-xs">
                        {toldAs[way]}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </>
  );
};

/** What the dots beside a step mean, in the same marks. */
const WayLegend = () => {
  const { t } = useLingui();
  const marks: [StepWay, string][] = [
    ["main", t`Told it`],
    ["other", t`Another way`],
    ["none", t`Did not mention it`],
  ];
  return (
    <ul className="text-muted-foreground flex flex-wrap justify-end gap-x-4 gap-y-1 text-xs max-sm:hidden">
      {marks.map(([way, label]) => (
        <li className="flex items-center gap-1.5" key={way}>
          <WayDot way={way} />
          {label}
        </li>
      ))}
    </ul>
  );
};

/** One of the numbers: what it is, the range people gave, and how many gave it. Nobody gave it: it stays unknown. */
const NumberRow = ({
  label,
  people,
  children,
}: {
  label: string;
  people: number;
  children: ReactNode;
}) => {
  const { t } = useLingui();
  return (
    <div className="flex flex-col gap-0.5 border-t px-5 py-2.5">
      <span className="text-muted-foreground flex items-baseline justify-between gap-3 text-xs">
        {label}
        <span>
          {people > 0
            ? plural(people, { one: "From # person.", other: "From # people." })
            : ""}
        </span>
      </span>
      {children === null ? (
        <span className="text-muted-foreground">{t`Not known: nobody said it.`}</span>
      ) : (
        <span>{children}</span>
      )}
    </div>
  );
};

/** How many people a shown number rests on; none for one held back. */
const restsOn = (number: DrawnNumber<unknown>): number =>
  number.value === null ? 0 : (number.people ?? 0);

/**
 * The numbers as staff see them (GRA-1079): the median over everyone who gave one, once at least
 * 5 people did; fewer, and only that shows. Never a lowest or a highest, never one person's own.
 */
const Numbers = ({ record }: { record: RecordOfWork }) => {
  const { t } = useLingui();
  const { volume, takes, wrong } = record;
  const { per, unit } = record.evidence.work;
  const fewer = t`Fewer than 5 people gave it.`;
  // What a number reads as: nothing when nobody gave it, `fewer` below the threshold.
  const shown = <Value,>(
    number: DrawnNumber<Value>,
    text: (value: Value) => string
  ): string | null => {
    if (number.people === 0) {
      return null;
    }
    return number.value === null ? fewer : text(number.value);
  };
  return (
    <SettingsSection
      description={t`The middle of what people gave once at least 5 did, never an average of a few or one person's own.`}
      title={t`The numbers`}
    >
      <NumberRow label={t`How many`} people={restsOn(volume)}>
        {shown(volume, ({ quiet, busy }) =>
          per === "month"
            ? t`About ${quiet} in a quiet month, ${busy} in a busy one.`
            : t`About ${quiet} in a quiet week, ${busy} in a busy one.`
        )}
      </NumberRow>
      <NumberRow label={t`How long`} people={restsOn(takes)}>
        {shown(takes, (normal) =>
          unit === "hours"
            ? t`A normal one takes about ${normal} hours.`
            : t`A normal one takes about ${normal} minutes.`
        )}
      </NumberRow>
      <NumberRow label={t`How often it comes in wrong`} people={restsOn(wrong)}>
        {shown(wrong, (outOfTen) => t`About ${outOfTen} in 10.`)}
      </NumberRow>
    </SettingsSection>
  );
};

/** What goes around the steps: what starts it, where it waits, when it goes differently, and what right looks like. */
const Around = ({ record }: { record: RecordOfWork }) => {
  const { t, i18n } = useLingui();
  const talked = record.interviews.length;
  const lines: {
    label: string;
    text: string;
    people: number;
    more?: string;
  }[] = [
    { label: t`What starts it`, ...record.starts },
    ...record.waits.map((wait) => ({
      label: i18n._(tagTitles.wait),
      ...wait,
    })),
    ...record.differently.map((each) => {
      const share = each.outOfTen;
      return {
        label: i18n._(tagTitles.exception),
        text: each.text,
        people: each.people,
        ...(share === null ? {} : { more: t`About ${share} in 10.` }),
      };
    }),
    ...(record.decides === null
      ? []
      : [{ label: i18n._(tagTitles.judgment), ...record.decides }]),
    ...(record.own === null
      ? []
      : [{ label: i18n._(tagTitles.workaround), ...record.own }]),
    ...(record.ai === null
      ? []
      : [{ label: i18n._(tagTitles.ai), ...record.ai }]),
    { label: i18n._(tagTitles.done), ...record.right },
    ...(record.ask === null
      ? []
      : [{ label: i18n._(tagTitles.stop), ...record.ask }]),
    { label: i18n._(tagTitles.next), ...record.next },
    ...(record.term === null
      ? []
      : [
          {
            label: i18n._(tagTitles.term),
            text: `“${record.term.word}”: ${record.term.text}`,
            people: record.term.people,
          },
        ]),
  ].filter(({ text }) => text !== "");
  return (
    <SettingsSection
      description={t`What starts it, where it waits, when it goes differently, and what right looks like.`}
      title={t`Around the steps`}
    >
      {lines.length === 0 ? (
        <p className="text-muted-foreground border-t px-5 py-4">{t`Nobody said yet.`}</p>
      ) : (
        <ul className="flex flex-col">
          {lines.map((each) => {
            const { people } = each;
            return (
              <li
                className="flex flex-col gap-0.5 border-t px-5 py-2.5"
                key={`${each.label} ${each.text}`}
              >
                <span className="text-muted-foreground flex items-baseline justify-between gap-3 text-xs">
                  {each.label}
                  <span className="tabular-nums">{t`${people} of ${talked}`}</span>
                </span>
                <span
                  className={people === 0 ? "text-muted-foreground" : undefined}
                >
                  {each.text}{" "}
                  {each.more === undefined ? null : (
                    <span className="text-muted-foreground">{each.more}</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </SettingsSection>
  );
};

/** Who told which step, and how: a dot per person, in the order they talked. */
const StepsTold = ({ record }: { record: RecordOfWork }) => {
  const { t } = useLingui();
  const talked = record.interviews.length;
  const { needed } = record;
  return (
    <SettingsSection
      action={<WayLegend />}
      description={
        record.evidence.everyone
          ? t`Everyone who does it has talked, so a step one of them told counts.`
          : plural(needed, {
              one: "A step counts once # person told it.",
              other:
                "A step counts once # people told it, or one fewer and a document.",
            })
      }
      title={t`Who told which step`}
    >
      <ol className="flex flex-col">
        {record.steps.map((each, index) => {
          const number = index + 1;
          const { people } = each;
          const otherWay = each.other?.text ?? "";
          return (
            <li
              className="flex flex-col gap-2 border-t px-5 py-3"
              key={`${number} ${each.text}`}
            >
              <div className="grid items-center gap-x-6 gap-y-1.5 sm:grid-cols-[minmax(0,1fr)_auto_4.5rem]">
                <span className="flex min-w-0 gap-3">
                  <span className="text-muted-foreground w-4 flex-none text-right tabular-nums">
                    {number}
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span
                      className={
                        each.enough ? undefined : "text-muted-foreground"
                      }
                    >
                      {each.text === "" ? t`Step ${number}` : each.text}
                    </span>
                    {each.documented ? (
                      <span className="text-muted-foreground text-xs">
                        {t`A document describes it too.`}
                      </span>
                    ) : null}
                  </span>
                </span>
                <span className="flex flex-wrap gap-1 pl-7 sm:pl-0">
                  {/* Who told it shows only of a sample's made-up people (GRA-1084). */}
                  {(record.byPerson ? each.ways : []).map((way, at) => (
                    <WayDot key={record.interviews[at]?.id ?? at} way={way} />
                  ))}
                </span>
                <span className="text-muted-foreground pl-7 tabular-nums sm:pl-0 sm:text-right">
                  {t`${people} of ${talked}`}
                </span>
              </div>
              {each.other === null ? null : (
                <div className="bg-muted/50 ml-7 flex flex-col gap-1 rounded-md px-3 py-2">
                  <span>{t`Another way: ${otherWay}`}</span>
                  {each.other.explained ? (
                    <span className="text-muted-foreground text-xs">
                      {each.other.because === undefined ||
                      each.other.because === ""
                        ? t`It depends on the case or the place, so it is a second way the step goes.`
                        : each.other.because}
                    </span>
                  ) : (
                    <span className="text-status-attention text-xs">
                      {t`Nobody can say why. It waits until someone explains it.`}
                    </span>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </SettingsSection>
  );
};

/** Who it was heard from, each with where their interview stands a click away. */
const HeardFrom = ({
  view,
  record,
}: {
  view: OrgView;
  record: RecordOfWork;
}) => {
  const { t } = useLingui();
  const { toAsk } = record;
  return (
    <SettingsSection
      description={
        toAsk > 0
          ? plural(toAsk, {
              one: "# person who does this work has not talked yet.",
              other: "# people who do this work have not talked yet.",
            })
          : t`Everyone who does this work has talked.`
      }
      title={t`Heard from`}
    >
      {record.interviews.length === 0 ? (
        <p className="text-muted-foreground border-t px-5 py-4">{t`Nobody yet.`}</p>
      ) : (
        <ul className="flex flex-col">
          {record.interviews.map((interview) => {
            const { name } = interview.person;
            const facts = interview.facts - interview.out;
            return (
              <li
                className="grid items-center gap-x-6 gap-y-0.5 border-t px-5 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,9rem)_minmax(0,9rem)_auto]"
                key={interview.id}
              >
                <span className="min-w-0 truncate">{name}</span>
                <span className="text-muted-foreground">
                  {dayDate(view, interview.day)}
                </span>
                <span className="text-muted-foreground tabular-nums">
                  {plural(facts, {
                    one: "# fact agreed",
                    other: "# facts agreed",
                  })}
                </span>
                <span className="flex justify-end">
                  <Button
                    aria-label={t`See the interview of ${name}`}
                    render={
                      <Link
                        params={{ person: interview.person.id }}
                        to="/onboarding/interviews/$person"
                      />
                    }
                    size="sm"
                    variant="ghost"
                  >
                    <Trans context="button: see an interview">See</Trans>
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </SettingsSection>
  );
};

/** Where it stands, in a line under its name. */
const StandsLine = ({ record }: { record: RecordOfWork }) => {
  const { t, i18n } = useLingui();
  const { evidence } = record;
  if (evidence.byHand) {
    return <Done>{t`Counted as known by Grasp, before the rules did.`}</Done>;
  }
  if (evidence.state === "blocked") {
    return (
      <span className="text-status-attention">
        {t`People tell a step two ways, and nobody can say why.`}
      </span>
    );
  }
  if (isKnown(evidence)) {
    return <Done>{i18n._(standingTitles[standingOf(evidence)])}</Done>;
  }
  return (
    <span className="text-muted-foreground flex items-center gap-2">
      <StandingDot standing={standingOf(evidence)} />
      {evidence.everyone
        ? t`Everyone who does it has talked`
        : i18n._(standingTitles[standingOf(evidence)])}
    </span>
  );
};

/** What staff can do with a piece of work: draw it again, count it as known by hand, or leave it to the rules. */
const Actions = ({
  record,
  stale,
}: {
  record: RecordOfWork;
  stale: boolean;
}) => {
  const { t } = useLingui();
  const { busy, failure, act } = useInterviewAction();
  const { evidence } = record;
  const { id } = evidence;
  // Counted by hand, it can be left to the rules; one that waits on an answer can't be counted.
  const counts =
    evidence.byHand || (!isKnown(evidence) && evidence.state !== "blocked");
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button
          render={<Link to="/onboarding/workflows" />}
          size="sm"
          variant="ghost"
        >
          <ArrowLeftIcon data-icon="inline-start" />
          <Trans>All workflows</Trans>
        </Button>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            disabled={busy || stale}
            onClick={() => {
              act(async (staff) => {
                await staff.drawWorkAgain(id);
              });
            }}
            size="sm"
            variant="ghost"
          >
            <RefreshCcwIcon data-icon="inline-start" />
            {stale ? t`Being drawn again` : t`Draw it again`}
          </Button>
          {counts ? (
            <Button
              disabled={busy}
              onClick={() => {
                act(async (staff) => {
                  await staff.countAsKnown(id, !evidence.byHand);
                });
              }}
              size="sm"
              variant="outline"
            >
              {evidence.byHand ? (
                <Trans>Leave it to the rules</Trans>
              ) : (
                <Trans>Count it as known</Trans>
              )}
            </Button>
          ) : null}
        </div>
      </div>
      <ErrorText>{failure}</ErrorText>
    </>
  );
};

/** Its name and team, where it stands, and its numbers in tiles. */
const Header = ({
  view,
  record,
  lacking,
}: {
  view: OrgView;
  record: RecordOfWork;
  lacking: number;
}) => {
  const { t } = useLingui();
  const { evidence } = record;
  const { work } = evidence;
  const team =
    view.teams.find((each) => each.team.id === work.team)?.team.name ?? "";
  const { approved: talked, doers, evidenced: told, steps } = evidence;
  const newFacts =
    record.interviews.length < 2 || evidence.everyone
      ? "–"
      : formatPercent(evidence.lastNew);
  return (
    <section className="bg-card overflow-hidden rounded-xl border text-sm">
      <div className="flex flex-col gap-0.5 px-5 py-4">
        <h2 className="text-2xl leading-tight font-medium tracking-tight">
          {work.name}
        </h2>
        <p className="text-muted-foreground">{team}</p>
        <p aria-live="polite">
          <StandsLine record={record} />
        </p>
      </div>
      <div className="bg-border grid grid-cols-2 gap-px border-t sm:grid-cols-4">
        <Tile
          label={t`who do it have talked`}
          value={t`${talked} of ${doers}`}
        />
        <Tile
          label={t`steps told by enough people`}
          value={t`${told} of ${steps}`}
        />
        <Tile label={t`new facts in the last interviews`} value={newFacts} />
        <Tile
          label={plural(lacking, {
            one: "thing still missing",
            other: "things still missing",
          })}
          value={lacking}
        />
      </div>
    </section>
  );
};

/** The canvas, and beside it what is still missing, or who told the step that is open. */
const Today = ({
  view,
  record,
  drawn,
  missing,
}: {
  view: OrgView;
  record: RecordOfWork;
  drawn: StaffDrawing | null;
  missing: Missing[];
}) => {
  const { t } = useLingui();
  const { busy, failure, act } = useInterviewAction();
  const [selected, setSelected] = useState<number | null>(null);
  const { id } = record.evidence;
  // Who does it and has not talked, and whom the one reminder can still go to.
  const doers = view.org.real?.doers.get(id) ?? [];
  const waiting = view.people.filter(
    (each) =>
      doers.includes(each.person.id) &&
      each.state !== "completed" &&
      each.state !== "away"
  );
  const remindable = waiting
    .filter(({ mayRemind }) => mayRemind)
    .map(({ person }) => person.id);
  const open =
    selected === null || record.steps[selected] === undefined ? null : selected;
  const number = (open ?? 0) + 1;
  return (
    <section
      aria-label={t`As it runs today`}
      className="bg-card overflow-hidden rounded-xl border text-sm"
    >
      <div className="flex flex-col lg:min-h-96 lg:flex-row">
        <div className="min-w-0 lg:flex-1">
          <WorkCanvas drawn={drawn} onSelect={setSelected} selected={open} />
        </div>
        {/* Beside the canvas, never over it: what is still missing, or the step that is open. */}
        <aside
          aria-label={
            open === null ? t`What is still missing` : t`Who told this step`
          }
          className="flex min-h-0 flex-col border-t lg:w-80 lg:flex-none lg:border-t-0 lg:border-l"
        >
          <div className="flex h-12 flex-none items-center justify-between gap-2 border-b pr-2 pl-4">
            {open === null ? (
              <span className="flex items-center gap-2 font-medium">
                {t`Still missing`}
                <Badge variant="secondary">{missing.length}</Badge>
              </span>
            ) : (
              <>
                <span className="truncate font-medium">
                  {t`Step ${number}`}
                </span>
                <Button
                  aria-label={t`Back to what is still missing`}
                  onClick={() => {
                    setSelected(null);
                  }}
                  size="icon-sm"
                  variant="ghost"
                >
                  <XIcon />
                </Button>
              </>
            )}
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
            {open === null ? (
              <>
                <MissingList
                  busy={busy}
                  missing={missing}
                  onRemind={() => {
                    act(async (staff) => {
                      await staff.remind(remindable);
                    });
                  }}
                  onStep={setSelected}
                  remindable={remindable.length}
                  waiting={waiting.map(({ person }) => person.name)}
                />
                <ErrorText>{failure}</ErrorText>
              </>
            ) : (
              <StepEvidence index={open} record={record} />
            )}
          </div>
        </aside>
      </div>
    </section>
  );
};

export const WorkRecord = ({
  view,
  record,
  drawn,
  stale,
}: {
  view: OrgView;
  record: RecordOfWork;
  /** As drawn from the interviews; null before it is. */
  drawn: StaffDrawing | null;
  /** Someone agreed to more since it was drawn: it is drawn again soon. */
  stale: boolean;
}) => {
  const missing = missingOf(record);
  // One column of its own: the area's column is only as tall as the
  // window, and a card that clips its content would shrink to nothing in it.
  return (
    <div className="flex flex-col gap-6">
      <Actions record={record} stale={stale} />
      <Header lacking={missing.length} record={record} view={view} />
      <Today drawn={drawn} missing={missing} record={record} view={view} />
      {record.interviews.length === 0 ? null : (
        <>
          <StepsTold record={record} />
          <div className="grid items-start gap-6 xl:grid-cols-2">
            <Around record={record} />
            <Numbers record={record} />
          </div>
        </>
      )}
      <HeardFrom record={record} view={view} />
    </div>
  );
};
