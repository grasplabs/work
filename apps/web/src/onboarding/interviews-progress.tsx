import { minTalkedShown } from "@grasp-os/shared/onboarding";
import type {
  LinkToSend,
  OnboardingView,
  TeamProgress,
} from "@grasp-os/shared/onboarding";
import { Button } from "@grasp-os/ui/components/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@grasp-os/ui/components/popover";
import { Progress } from "@grasp-os/ui/components/progress";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  DownloadIcon,
  LinkIcon,
} from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import { ErrorText } from "../error-text.tsx";
import { formatDate } from "../format.ts";
import { downloadCsv } from "../landscape/download.ts";
import { useCoreAction } from "../use-core-action.ts";
import { fullLink, linksCsv, linksOf } from "./links-to-send.ts";
import { Callout, Figure } from "./setup-parts.tsx";
import { closesOn, teamNumbersOf } from "./setup.ts";
import type { Listening } from "./setup.ts";

// Where the interviews stand while Stephen talks to the team (prototype
// `RealListening`, `QuietTeam` and `Links` in
// `components/onboarding/onboarding-steps.tsx`): how far the days are,
// three numbers, the team that needs a word from its lead, every team in
// a panel, and everyone's own link to send. On one screen that never
// scrolls: the panels open over it. The onboarding's step shows it, and
// Settings, Onboarding; only on the step does Stephen say its lines.

/** How far the days must be before a team far behind is named. */
const quietAfter = 0.35;
/** A team is far behind while fewer than this share of those asked talked. */
const quietBelow = 0.35;

const firstName = (name: string): string => name.split(" ")[0] ?? name;

/** A date as the page's language writes it, from an ISO day. */
const formatDay = (day: string): string => formatDate(`${day}T12:00:00Z`);

/** Copies text, and says whether it worked: browsers refuse without focus or permission. */
const copyText = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

/** A line that turns up: said by Stephen on the onboarding's step, only shown elsewhere. */
const Line = ({ text, spoken }: { text: string; spoken: boolean }) =>
  spoken ? <Callout text={text} /> : <p>{text}</p>;

/** The one team far behind, named with the lead whose word usually helps. */
const QuietTeam = ({
  team,
  lead,
  spoken,
}: {
  team: string;
  lead: string;
  spoken: boolean;
}) => {
  const { t } = useLingui();
  return (
    <div className="text-muted-foreground">
      <Line
        spoken={spoken}
        text={t`${team} has been quiet so far. A short message from ${lead}, their lead, usually helps. I’ll remind everyone once myself.`}
      />
    </div>
  );
};

/**
 * What keeps the links from going out, before anything else: Grasp's
 * staff paused the interviews (in the words of their own switch), or the
 * agreements are not in place yet. Otherwise, the links new since the
 * admin last took some.
 */
const Waiting = ({
  paused,
  agreed,
  fresh,
  spoken,
}: {
  paused: boolean;
  agreed: boolean;
  fresh: number;
  spoken: boolean;
}) => {
  const { t } = useLingui();
  return (
    <>
      {paused ? (
        <Line
          spoken={spoken}
          text={t`Paused: no link opens and none goes out. The links that are due go out once they run again.`}
        />
      ) : null}
      {agreed ? null : (
        <Line
          spoken={spoken}
          text={t`Grasp is still putting the agreements in place. Your people’s links go out once that is done.`}
        />
      )}
      {agreed && !paused && fresh > 0 ? (
        <Line
          spoken={spoken}
          text={plural(fresh, {
            one: "One new link is ready to send, under “Links to send”.",
            other: "# new links are ready to send, under “Links to send”.",
          })}
        />
      ) : null}
    </>
  );
};

/**
 * One team's row of how far it is: how many talked of how many were
 * asked; while too few talked, how many were asked and whether the lead
 * talked; while too few were asked, only whether the lead talked.
 */
const TeamRow = ({ team }: { team: TeamProgress }) => {
  const { t } = useLingui();
  const numbers = teamNumbersOf(team);
  const least = minTalkedShown;
  let count = t`Under 5`;
  if (numbers.shown === "both") {
    const { talked, asked: of } = numbers;
    count = t`${talked} of ${of}`;
  } else if (numbers.shown === "asked") {
    const { asked: of } = numbers;
    count = t`Fewer than ${least} of ${of}`;
  }
  return (
    <div className="setup-team-row grid items-center gap-3 py-1.5">
      <span className="truncate">{team.name}</span>
      {numbers.shown === "both" ? (
        <Progress
          aria-label={team.name}
          value={
            numbers.asked === 0
              ? 0
              : Math.round((numbers.talked / numbers.asked) * 100)
          }
        />
      ) : (
        <span className="text-muted-foreground text-xs">
          {team.leadTalked ? t`Lead talked` : t`Lead not yet`}
        </span>
      )}
      <span className="text-muted-foreground text-right tabular-nums">
        {count}
      </span>
    </div>
  );
};

/** Every team in a panel over the page: numbers only for teams of five or more. */
const ByTeam = ({ teams }: { teams: TeamProgress[] }) => {
  const { t } = useLingui();
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button className="-my-1 flex-none" size="sm" variant="ghost" />
        }
      >
        {t`By team`}
        <ChevronDownIcon data-icon="inline-end" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96">
        {/* One list, close together: the content's own room is between its parts. */}
        <div className="flex flex-col">
          {teams.map((team) => (
            <TeamRow key={team.id} team={team} />
          ))}
          <p className="text-muted-foreground pt-2 text-xs">{t`Teams under five people show only whether their lead talked, so nobody can be singled out.`}</p>
        </div>
      </PopoverContent>
    </Popover>
  );
};

/** One person's link, to copy on its own; one not out yet can't be. */
const LinkRow = ({
  link,
  copied,
  onCopy,
}: {
  link: LinkToSend;
  copied: boolean;
  onCopy: () => void;
}) => {
  const { t } = useLingui();
  const { name, team } = link;
  let about = t`${team} · not out yet`;
  if (link.fresh) {
    about = t`${team} · new`;
  } else if (link.path !== null) {
    about = team;
  }
  return (
    <div className="setup-link-row grid items-center gap-3 border-t py-1.5">
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{name}</span>
        <span className="text-muted-foreground truncate text-xs">{about}</span>
      </span>
      <Button
        aria-label={t`Copy the link for ${name}`}
        disabled={link.path === null}
        onClick={onCopy}
        size="icon-sm"
        variant="ghost"
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  );
};

/**
 * Everyone's own link, to send from the company's own email or chat, or
 * on paper: as a list to mail-merge, or one by one. A link that is not out
 * yet waits for its day or for its lead. The links out since the admin
 * last took some are new, and the list holds only those, so nobody gets
 * theirs twice; taking one tells core, which keeps it for next time.
 */
const LinksToSend = ({ links }: { links: LinkToSend[] }) => {
  const { t } = useLingui();
  const router = useRouter();
  const { run, failure } = useCoreAction();
  const [copied, setCopied] = useState<string | null>(null);
  const { out, fresh, list } = linksOf(links);
  const { origin } = window.location;
  const taken = async (people: string[]) => {
    if (people.length === 0) {
      return;
    }
    await run(async (session) => {
      await session.onboarding.linksTaken(people);
    });
    await router.invalidate();
  };
  const freshCount = fresh.length;
  const outCount = out.length;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button className="-my-1 flex-none" size="sm" variant="ghost" />
        }
      >
        <LinkIcon data-icon="inline-start" />
        {freshCount > 0
          ? plural(freshCount, {
              one: "# new link to send",
              other: "# new links to send",
            })
          : t`Links to send`}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-md">
        <div className="flex flex-col gap-3">
          <p className="text-muted-foreground">{t`Everyone has a link of their own: whoever has it is them, so send each only to its owner. Links that are not out yet open on their day, or once their lead has talked.`}</p>
          <Button
            disabled={list.length === 0}
            onClick={() => {
              downloadCsv(
                linksCsv(list, origin, [t`Name`, t`Email`, t`Team`, t`Link`]),
                "grasp-links.csv"
              );
              void taken(list.map(({ person }) => person));
            }}
            size="sm"
            variant="outline"
          >
            <DownloadIcon data-icon="inline-start" />
            {freshCount > 0
              ? plural(freshCount, {
                  one: "The new link, as a list",
                  other: "The # new links, as a list",
                })
              : plural(outCount, {
                  one: "The link that is out, as a list",
                  other: "The # links that are out, as a list",
                })}
          </Button>
          <ErrorText>{failure}</ErrorText>
          <div className="flex max-h-72 flex-col overflow-auto">
            {links.map((link) => (
              <LinkRow
                copied={copied === link.person}
                key={link.person}
                link={link}
                onCopy={() => {
                  void (async () => {
                    if (link.path === null) {
                      return;
                    }
                    if (!(await copyText(fullLink(link.path, origin)))) {
                      return;
                    }
                    setCopied(link.person);
                    if (link.fresh) {
                      await taken([link.person]);
                    }
                  })();
                }}
              />
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
};

/**
 * Where the interviews stand: how far the days are and when they close,
 * three numbers, the team that needs a word from its lead, every team in a
 * panel, and the links to send. Numbers per team only for teams of five or
 * more, and never who talked or what anyone said. `spoken`: Stephen says
 * its lines as they turn up, as on the onboarding's step. `children`
 * come right after what keeps the links from going out.
 */
export const InterviewsProgress = ({
  view,
  links,
  listening,
  today,
  spoken,
  children,
}: {
  view: OnboardingView;
  links: LinkToSend[];
  listening: Listening;
  today: string;
  spoken: boolean;
  children?: ReactNode;
}) => {
  const { t } = useLingui();
  const { plan, progress, roster, agreed, paused } = view;
  const closes = plan === null ? "" : formatDay(closesOn(plan));
  const { days, leadsHeard } = listening;
  const day = Math.max(
    listening.day,
    plan !== null && plan.start <= today ? 1 : 0
  );
  const teams = progress?.teams.filter((team) => !team.off) ?? [];
  const leadOf = (team: string) => {
    const lead = roster?.teams.find((each) => each.id === team)?.lead ?? null;
    return roster?.people.find((person) => person.id === lead) ?? null;
  };
  // Once the days are well under way, a team of five or more far behind is named, with the lead who can help.
  const quiet =
    listening.progress > quietAfter
      ? teams.find(
          (team) =>
            leadOf(team.id) !== null &&
            team.asked !== null &&
            team.asked > 0 &&
            (team.talked ?? 0) / team.asked < quietBelow
        )
      : undefined;
  const quietLead =
    quiet === undefined ? "" : firstName(leadOf(quiet.id)?.name ?? "");
  const leads = progress?.leads ?? 0;
  const starts = plan === null ? "" : formatDay(plan.start);
  return (
    <div className="flex w-full flex-col gap-4 text-left">
      <Waiting
        agreed={agreed}
        fresh={linksOf(links).fresh.length}
        paused={paused}
        spoken={spoken}
      />
      {children}
      <div className="flex flex-col gap-2">
        <div className="flex gap-1">
          {Array.from({ length: days }, (_, index) => (
            <span
              className={
                index < day
                  ? "bg-foreground h-1.5 flex-1 rounded-full transition-colors duration-500"
                  : "bg-border h-1.5 flex-1 rounded-full transition-colors duration-500"
              }
              key={index}
            />
          ))}
        </div>
        <div className="text-muted-foreground flex justify-between">
          <span>
            {plan !== null && plan.start > today
              ? t`Starts ${starts}`
              : t`Day ${day} of ${days}`}
          </span>
          {closes === "" ? null : <span>{t`Closes ${closes}`}</span>}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2.5">
        <Figure
          label={t`team leads talked`}
          value={t`${leadsHeard} of ${leads}`}
        />
        <Figure
          label={t`colleagues talked`}
          value={String(listening.colleaguesHeard)}
        />
        {/* Core draws no work from the interviews yet: unknown stays unknown, never 0. */}
        <Figure label={t`pieces of work found`} value="–" />
      </div>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {quiet === undefined ? null : (
            <QuietTeam lead={quietLead} spoken={spoken} team={quiet.name} />
          )}
        </div>
        {links.length === 0 ? null : <LinksToSend links={links} />}
        <ByTeam teams={teams} />
      </div>
    </div>
  );
};
