import { missingOf } from "@grasp-os/shared/admin/admin-missing";
import type {
  OrgView,
  WorkEvidence,
} from "@grasp-os/shared/admin/onboarding-admin";
import { recordOf } from "@grasp-os/shared/admin/onboarding-admin-record";
import type { StaffWorks } from "@grasp-os/shared/onboarding-staff";
import { Button } from "@grasp-os/ui/components/button";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { Progress } from "@grasp-os/ui/components/progress";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { cn } from "@grasp-os/ui/lib/utils";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { SlidersHorizontalIcon } from "lucide-react";
import { useState } from "react";

import { WorkRules } from "./work-rules.tsx";
import {
  isKnown,
  standingOf,
  standings,
  standingTitles,
} from "./work-words.ts";
import type { Standing } from "./work-words.ts";

// Every piece of work in Grasp's onboarding area (prototype
// `org-workflows.tsx`): how far each is known, who of the people who do
// it talked, how many of its steps enough of them told, and how much is
// still missing. A piece of work opens its record and its canvas. When
// one counts as known follows the organization's own rules, behind their
// own button.

/** Where a piece of work stands, as its dot. */
const standingDot: Record<Standing, string> = {
  complete: "bg-status-agreed",
  variants: "bg-status-agreed",
  saturating: "bg-foreground",
  mapping: "bg-border",
  blocked: "bg-status-attention",
  split: "bg-status-attention",
};

export const StandingDot = ({ standing }: { standing: Standing }) => (
  <span
    aria-hidden="true"
    className={cn("size-2 flex-none rounded-full", standingDot[standing])}
  />
);

const all = "all";

/** One piece of work as the list shows it. */
interface Card {
  work: WorkEvidence;
  standing: Standing;
  missing: number;
}

const cardsOf = (view: OrgView, works: StaffWorks): Card[] =>
  view.works.map((work) => {
    const record = recordOf(view, work.id);
    const open = works.works.find(({ id }) => id === work.id)?.drawn?.open;
    return {
      work,
      standing: standingOf(work),
      missing: record === null ? 0 : missingOf(record, open).length,
    };
  });

/** So many of so many, as a number and a bar. */
const Meter = ({
  label,
  value,
  of,
}: {
  label: string;
  value: number;
  of: number;
}) => {
  const { t } = useLingui();
  return (
    <span className="flex flex-col gap-1">
      <span className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums">
          {of === 0 ? "–" : t`${value} of ${of}`}
        </span>
      </span>
      <Progress aria-label={label} max={Math.max(of, 1)} value={value} />
    </span>
  );
};

/** How many pieces of work are known, of all of them, as a ring: dark for the known part. */
const KnownRing = ({ known, of }: { known: number; of: number }) => {
  const { t } = useLingui();
  const share = of === 0 ? 0 : known / of;
  return (
    <div className="relative size-28 flex-none">
      {/* The ring is 100 around, so the dark part is the percentage itself. */}
      <svg aria-hidden className="size-28 -rotate-90" viewBox="0 0 36 36">
        <circle
          className="stroke-border"
          cx="18"
          cy="18"
          fill="none"
          r="15.9155"
          strokeWidth="3"
        />
        {share > 0 ? (
          <circle
            className="stroke-status-agreed"
            cx="18"
            cy="18"
            fill="none"
            r="15.9155"
            strokeDasharray={`${share * 100} 100`}
            strokeWidth="3"
          />
        ) : null}
      </svg>
      <span className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl leading-tight font-medium tabular-nums">
          {known}
        </span>
        <span className="text-muted-foreground text-xs">{t`of ${of}`}</span>
      </span>
    </div>
  );
};

/** How far the work is, all of it: how many are known, where the rest stand, and what is still missing. */
const Summary = ({ cards }: { cards: Card[] }) => {
  const { t, i18n } = useLingui();
  const known = cards.filter(({ work }) => isKnown(work)).length;
  const missing = cards.reduce((sum, card) => sum + card.missing, 0);
  const workflows = cards.length;
  return (
    <section
      aria-label={t`How far the workflows are`}
      className="bg-card @container overflow-hidden rounded-xl border text-sm"
    >
      <div className="grid items-center gap-x-8 gap-y-4 px-5 py-4 @2xl:grid-cols-[auto_minmax(0,1fr)_auto]">
        <div>
          <span className="sr-only">{t`${known} of ${workflows} workflows known`}</span>
          <KnownRing known={known} of={cards.length} />
        </div>
        <ul
          aria-label={t`Where the workflows stand`}
          className="grid gap-x-8 gap-y-2 @md:grid-cols-2"
        >
          {standings.toReversed().map((each) => (
            <li className="flex items-center justify-between gap-3" key={each}>
              <span className="flex items-center gap-2">
                <StandingDot standing={each} />
                {i18n._(standingTitles[each])}
              </span>
              <span className="text-muted-foreground tabular-nums">
                {cards.filter((card) => card.standing === each).length}
              </span>
            </li>
          ))}
        </ul>
        <div className="flex flex-col gap-0.5 @2xl:items-end @2xl:text-right">
          <span className="text-2xl leading-tight font-medium tabular-nums">
            {missing}
          </span>
          <span className="text-muted-foreground">
            {plural(missing, {
              one: "thing still missing",
              other: "things still missing",
            })}
          </span>
        </div>
      </div>
    </section>
  );
};

/** What a card says is still missing. */
const lacksText = (card: Card): string => {
  const lacks = card.missing;
  if (lacks === 0) {
    return "";
  }
  return isKnown(card.work)
    ? plural(lacks, { one: "# question left", other: "# questions left" })
    : plural(lacks, { one: "# thing missing", other: "# things missing" });
};

/** One piece of work: its name and team, who talked, how many steps are told, and where it stands. */
const WorkCard = ({ card, team }: { card: Card; team: string }) => {
  const { t, i18n } = useLingui();
  const { work, standing } = card;
  const { name } = work.work;
  const lacks = lacksText(card);
  return (
    <li className="flex">
      <Link
        aria-label={t`Open ${name}`}
        className="bg-card hover:bg-muted/50 focus-visible:ring-ring/50 flex w-full min-w-0 flex-col gap-4 rounded-xl border px-5 py-4 text-left text-sm outline-none focus-visible:ring-3"
        params={{ work: work.id }}
        to="/onboarding/workflows/$work"
      >
        <span className="flex flex-col gap-0.5">
          <span className="font-medium">{name}</span>
          <span className="text-muted-foreground text-xs">{team}</span>
        </span>
        <span className="flex flex-col gap-2.5">
          <Meter label={t`Talked`} of={work.doers} value={work.approved} />
          <Meter label={t`Steps told`} of={work.steps} value={work.evidenced} />
        </span>
        <span className="mt-auto flex items-center justify-between gap-3">
          <span className="flex items-center gap-2">
            <StandingDot standing={standing} />
            <span
              className={
                standing === "blocked" || standing === "split"
                  ? "text-status-attention"
                  : undefined
              }
            >
              {work.byHand
                ? t`Counted as known by Grasp`
                : i18n._(standingTitles[standing])}
            </span>
          </span>
          <span className="text-muted-foreground text-xs tabular-nums">
            {lacks === "" ? t`Nothing missing` : lacks}
          </span>
        </span>
      </Link>
    </li>
  );
};

/** The standings a list can be narrowed to: the ones some piece of work is at. */
const standingsIn = (cards: Card[]): Standing[] =>
  standings
    .toReversed()
    .filter((each) => cards.some((card) => card.standing === each));

export const WorkList = ({
  view,
  works,
}: {
  view: OrgView;
  works: StaffWorks;
}) => {
  const { t, i18n } = useLingui();
  const [team, setTeam] = useState(all);
  const [standing, setStanding] = useState<Standing | typeof all>(all);
  const [rulesOpen, setRulesOpen] = useState(false);
  const cards = cardsOf(view, works);
  const teamName = (id: string) =>
    view.teams.find((each) => each.team.id === id)?.team.name ?? "";
  const rules = (
    <WorkRules
      onOpenChange={setRulesOpen}
      open={rulesOpen}
      rules={works.rules}
    />
  );
  if (cards.length === 0) {
    return (
      <section className="bg-card text-muted-foreground rounded-xl border px-5 py-4 text-sm">
        {view.interviews.some(({ approved }) => approved)
          ? t`None drawn yet. They show up here as the interviews come in.`
          : t`None yet. A team's work shows up here once its lead has named it.`}
      </section>
    );
  }
  const teams = view.teams.filter((each) =>
    cards.some(({ work }) => work.team === each.team.id)
  );
  const shown = cards.filter(
    (card) =>
      (team === all || card.work.team === team) &&
      (standing === all || card.standing === standing)
  );
  // One column of its own, so no card in it shrinks to fit the window.
  return (
    <div className="flex flex-col gap-6">
      <Summary cards={cards} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            aria-label={t`How far it is`}
            onValueChange={(value: unknown[]) => {
              const [chosen] = value;
              setStanding(standings.find((each) => each === chosen) ?? all);
            }}
            size="sm"
            spacing={0}
            value={[standing]}
            variant="outline"
          >
            <ToggleGroupItem value={all}>
              {t({ message: "All", context: "filter: every workflow" })}
            </ToggleGroupItem>
            {standingsIn(cards).map((each) => (
              <ToggleGroupItem key={each} value={each}>
                {i18n._(standingTitles[each])}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {teams.length > 1 ? (
            <NativeSelect
              aria-label={t({ message: "Team", context: "workflows filter" })}
              onChange={(event) => {
                setTeam(event.target.value);
              }}
              size="sm"
              value={team}
            >
              <NativeSelectOption value={all}>
                {t`All teams`}
              </NativeSelectOption>
              {teams.map((each) => (
                <NativeSelectOption key={each.team.id} value={each.team.id}>
                  {each.team.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          ) : null}
        </div>
        <Button
          onClick={() => {
            setRulesOpen(true);
          }}
          size="sm"
          variant="ghost"
        >
          <SlidersHorizontalIcon data-icon="inline-start" />
          {t`When one counts as known`}
        </Button>
      </div>
      <ul
        aria-label={t`Workflows`}
        className="grid gap-4 md:grid-cols-2 xl:grid-cols-3"
      >
        {shown.map((card) => (
          <WorkCard
            card={card}
            key={card.work.id}
            team={teamName(card.work.team)}
          />
        ))}
      </ul>
      {shown.length === 0 ? (
        <p className="text-muted-foreground">{t`No workflow matches.`}</p>
      ) : null}
      {rules}
    </div>
  );
};
