import { minTalkedShown } from "@grasp-os/shared/onboarding";
import type {
  LinkToSend,
  OnboardingView,
  TeamProgress,
} from "@grasp-os/shared/onboarding";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";

import { copyText } from "../copy.ts";
import { downloadCsv } from "../csv.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDate } from "../format.ts";
import { Button } from "../grasp/button/index.ts";
import { Copy, Download, Link, Tick } from "../grasp/icons/index.ts";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../grasp/popover/index.ts";
import { Progress } from "../grasp/progress/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { useCoreAction } from "../use-core-action.ts";
import { FailedMailNotice } from "./failed-mail.tsx";
import { fullLink, linksCsv, linksOf } from "./links-to-send.ts";
import { Callout, Figure } from "./setup-parts.tsx";
import { closesOn, teamNumbersOf } from "./setup.ts";
import type { Listening } from "./setup.ts";

const styles = stylex.create({
  whole: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space4,
    width: "100%",
    textAlign: "start",
  },
  quiet: { color: grasp.muted },
  line: { margin: 0 },
  days: { display: "flex", flexDirection: "column", gap: grasp.space2 },
  ticks: { display: "flex", gap: grasp.space1 },
  tick: {
    flexGrow: 1,
    flexBasis: 0,
    height: `calc(1.5 * ${grasp.space1})`,
    borderRadius: grasp.cornerPill,
    backgroundColor: grasp.line,
    transitionProperty: "background-color",
    transitionDuration: grasp.durationOpen,
    transitionTimingFunction: grasp.ease,
  },
  past: { backgroundColor: grasp.ink },
  when: {
    display: "flex",
    justifyContent: "space-between",
    color: grasp.muted,
  },
  figures: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: grasp.space3,
  },
  foot: { display: "flex", alignItems: "flex-start", gap: grasp.space3 },
  grow: { flexGrow: 1, minWidth: 0 },
  // A trigger in the foot's line stands level with the words beside it.
  trigger: { flexShrink: 0, marginBlock: `calc(-1 * ${grasp.space1})` },
  // A team: its name and count on one line, how far it is under them.
  team: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space1,
    paddingBlock: grasp.space2,
  },
  teamHead: { display: "flex", alignItems: "baseline", gap: grasp.space3 },
  name: {
    flexGrow: 1,
    minWidth: 0,
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
  },
  count: {
    flexShrink: 0,
    color: grasp.muted,
    fontVariantNumeric: "tabular-nums",
  },
  panel: { display: "flex", flexDirection: "column" },
  note: { marginBlockStart: grasp.space2 },
  links: { display: "flex", flexDirection: "column", gap: grasp.space3 },
  // Many links scroll in the panel's own list.
  linkList: {
    display: "flex",
    flexDirection: "column",
    maxHeight: "18rem",
    overflow: "auto",
  },
  link: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) auto",
    alignItems: "center",
    gap: grasp.space3,
    paddingBlock: grasp.space1,
    borderBlockStartWidth: grasp.hairline,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: grasp.line,
  },
  person: { display: "flex", flexDirection: "column", minWidth: 0 },
});

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

/**
 * The team far behind, once the days are well under way: a team of five
 * or more with a lead, of whom fewer than `quietBelow` of those asked
 * talked, named with its lead's first name, who can help. The onboarding's
 * step and the inbox's Interviews item say the same.
 */
export const quietTeamOf = (
  { progress, roster }: Pick<OnboardingView, "progress" | "roster">,
  listening: Pick<Listening, "progress">
): { team: TeamProgress; lead: string } | undefined => {
  if (listening.progress <= quietAfter) {
    return undefined;
  }
  const leadOf = (team: string) => {
    const lead = roster?.teams.find((each) => each.id === team)?.lead ?? null;
    // An erased lead has no name to give, and can't help: as if none.
    return (
      roster?.people.find(
        (person) => person.id === lead && person.name !== ""
      ) ?? null
    );
  };
  const team = progress?.teams.find(
    (each) =>
      !each.off &&
      leadOf(each.id) !== null &&
      each.asked !== null &&
      each.asked > 0 &&
      (each.talked ?? 0) / each.asked < quietBelow
  );
  return team === undefined
    ? undefined
    : { team, lead: firstName(leadOf(team.id)?.name ?? "") };
};

/** A line that turns up: said by Stephen on the onboarding's step, only shown elsewhere. */
const Line = ({ text, spoken }: { text: string; spoken: boolean }) =>
  spoken ? (
    <Callout text={text} />
  ) : (
    <p {...stylex.props(styles.line)}>{text}</p>
  );

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
    <div {...stylex.props(styles.quiet)}>
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
    <div {...stylex.props(styles.team)}>
      <span {...stylex.props(styles.teamHead)}>
        <span {...stylex.props(styles.name)}>{team.name}</span>
        <span {...stylex.props(styles.count)}>{count}</span>
      </span>
      {numbers.shown === "both" ? (
        <Progress
          label={team.name}
          showLabel={false}
          size="sm"
          value={
            numbers.asked === 0
              ? 0
              : Math.round((numbers.talked / numbers.asked) * 100)
          }
        />
      ) : (
        <Text element="span" size="xs" tone="muted">
          {team.leadTalked ? t`Lead talked` : t`Lead not yet`}
        </Text>
      )}
    </div>
  );
};

/** Every team in a panel over the page: numbers only for teams of five or more. */
const ByTeam = ({ teams }: { teams: TeamProgress[] }) => {
  const { t } = useLingui();
  return (
    <Popover>
      <PopoverTrigger layout={styles.trigger} size="sm" variant="ghost">
        {t`By team`}
      </PopoverTrigger>
      <PopoverContent align="end">
        {/* One list, close together: the content's own room is between its parts. */}
        <div {...stylex.props(styles.panel)}>
          {teams.map((team) => (
            <TeamRow key={team.id} team={team} />
          ))}
          <Text layout={styles.note} size="xs" tone="muted">
            {t`Teams under five people show only whether their lead talked, so nobody can be singled out.`}
          </Text>
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
  if (link.mailFailed) {
    about = t`${team} · our email didn’t reach them`;
  } else if (link.fresh) {
    about = t`${team} · new`;
  } else if (link.path !== null) {
    about = team;
  }
  return (
    <div {...stylex.props(styles.link)}>
      <span {...stylex.props(styles.person)}>
        <Text element="span" size="sm" wrap="truncate">
          {name}
        </Text>
        <Text element="span" size="xs" tone="muted" wrap="truncate">
          {about}
        </Text>
      </span>
      <Button
        aria-label={t`Copy the link for ${name}`}
        disabled={link.path === null}
        icon={copied ? Tick : Copy}
        onClick={onCopy}
        size="sm"
        variant="ghost"
      />
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
        icon={Link}
        layout={styles.trigger}
        size="sm"
        variant="ghost"
      >
        {freshCount > 0
          ? plural(freshCount, {
              one: "# new link to send",
              other: "# new links to send",
            })
          : t`Links to send`}
      </PopoverTrigger>
      <PopoverContent align="end">
        <div {...stylex.props(styles.links)}>
          <Text size="sm" tone="muted">
            {t`Everyone has a link of their own. It opens only once they sign in with your company's sign-in, at the address on the list. Links that are not out yet open on their day, or once their lead has talked.`}
          </Text>
          <Button
            disabled={list.length === 0}
            icon={Download}
            onClick={() => {
              downloadCsv(
                linksCsv(list, origin, [t`Name`, t`Email`, t`Team`, t`Link`]),
                "grasp-links.csv"
              );
              void taken(list.map(({ person }) => person));
            }}
            size="sm"
            variant="quiet"
          >
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
          <div {...stylex.props(styles.linkList)}>
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
  const { plan, progress, agreed, paused } = view;
  const closes = plan === null ? "" : formatDay(closesOn(plan));
  const { days, leadsHeard } = listening;
  const day = Math.max(
    listening.day,
    plan !== null && plan.start <= today ? 1 : 0
  );
  const teams = progress?.teams.filter((team) => !team.off) ?? [];
  const quietOne = quietTeamOf(view, listening);
  const quiet = quietOne?.team;
  const quietLead = quietOne?.lead ?? "";
  const leads = progress?.leads ?? 0;
  const starts = plan === null ? "" : formatDay(plan.start);
  return (
    <div {...stylex.props(styles.whole)}>
      <Waiting
        agreed={agreed}
        fresh={linksOf(links).fresh.length}
        paused={paused}
        spoken={spoken}
      />
      <FailedMailNotice links={links} />
      {children}
      <div {...stylex.props(styles.days)}>
        <div {...stylex.props(styles.ticks)}>
          {Array.from({ length: days }, (_, index) => (
            <span
              key={index}
              {...stylex.props(styles.tick, index < day && styles.past)}
            />
          ))}
        </div>
        <div {...stylex.props(styles.when)}>
          <span>
            {plan !== null && plan.start > today
              ? t`Starts ${starts}`
              : t`Day ${day} of ${days}`}
          </span>
          {closes === "" ? null : <span>{t`Closes ${closes}`}</span>}
        </div>
      </div>
      <div {...stylex.props(styles.figures)}>
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
      <div {...stylex.props(styles.foot)}>
        <div {...stylex.props(styles.grow)}>
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
