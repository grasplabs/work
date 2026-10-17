/**
 * One organization's onboarding, step by step, ported from the prototype
 * (grasplabs/prototype `components/admin/org-steps.tsx` and the
 * `stage-*.tsx` it opens): the steps from the first conversation until
 * Grasp opens, each with where it stands, and the step that is chosen
 * opened underneath. It opens on the step the organization is at.
 *
 * Read only, as the console is: what the prototype does at each step
 * (bringing in the first conversation, starting the research, keeping
 * what was agreed, reminding people, giving Grasp's go) writes to the
 * company's Grasp, which the console has no way to yet, so each step says
 * so where its buttons were. Nor is the company's own link here, as the
 * prototype had it under the steps: a link is a credential, and core
 * never sends one. And nothing anyone said is shown: not the first
 * conversation, not what the research found, only what the model counts.
 */
import { VISION_FIELDS } from "@grasp-os/shared/admin/interviews";
import type { VisionField } from "@grasp-os/shared/admin/interviews";
import { LISTEN_DAYS } from "@grasp-os/shared/admin/onboarding";
import {
  dateOn,
  mayInvite,
  RESEARCH_SOURCES,
  STAGES,
} from "@grasp-os/shared/admin/onboarding-admin";
import type {
  OrgView,
  PersonView,
  ResearchSource,
  Stage,
  StageStatus,
} from "@grasp-os/shared/admin/onboarding-admin";
import { Button } from "@grasp-os/ui/components/button";
import { Progress } from "@grasp-os/ui/components/progress";
import { cn } from "@grasp-os/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  BriefcaseIcon,
  Building2Icon,
  CheckIcon,
  CircleDotIcon,
  CircleIcon,
  GlobeIcon,
  HourglassIcon,
  LibraryIcon,
  MessageSquareTextIcon,
  NewspaperIcon,
  ScaleIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Done, KnowledgeDots, Panel, PanelRow, Tile } from "./parts.tsx";
import { sectionTo } from "./sections.ts";
import {
  formatDate,
  linkWords,
  stageLines,
  stageWords,
  workflowWords,
} from "./words.ts";

/** `count` and the thing it counts: one for one, many for the rest. */
const counted = (count: number, one: string, other: string): string =>
  `${count} ${count === 1 ? one : other}`;

/** The date `day` days after the organization's team was told. */
const dayDate = (view: OrgView, day: number): string =>
  formatDate(dateOn(view.org, day));

/** Where in the steps' list a step stands, said to a screen reader. */
const statusWords: Record<StageStatus, string> = {
  done: "Done",
  now: "Now",
  waits: "Waiting",
  later: "Later",
};

const StageMark = ({ status }: { status: StageStatus }) => {
  if (status === "done") {
    return (
      <CheckIcon aria-hidden className="text-status-agreed size-4 flex-none" />
    );
  }
  if (status === "now") {
    return <CircleDotIcon aria-hidden className="size-4 flex-none" />;
  }
  if (status === "waits") {
    return (
      <HourglassIcon
        aria-hidden
        className="text-status-attention size-4 flex-none"
      />
    );
  }
  return <CircleIcon aria-hidden className="text-border size-4 flex-none" />;
};

/**
 * Where something the prototype does here would be: not in the console
 * yet, for it writes to the company's Grasp.
 */
const NotHere = ({ children }: { children: ReactNode }) => (
  <p
    className="text-muted-foreground border-t px-5 py-3 text-xs"
    data-slot="not-in-console"
  >
    {children}
  </p>
);

/** The steps, each a link that opens it underneath, with the open one marked as a chosen tab is. */
const StageList = ({
  view,
  stage,
  clientId,
}: {
  view: OrgView;
  stage: Stage;
  clientId: string;
}) => {
  const lines = stageLines(view);
  return (
    <nav
      aria-label="The steps of this onboarding"
      className="bg-card overflow-hidden rounded-xl border"
    >
      <ol className="grid lg:grid-cols-7">
        {STAGES.map((each) => {
          const open = each === stage;
          const status = view.stages[each];
          return (
            <li
              className="border-b last:border-b-0 lg:border-r lg:border-b-0 lg:last:border-r-0"
              key={each}
            >
              <Link
                // The router marks the link the page is on itself, as the page.
                activeOptions={{ exact: true }}
                aria-current={open ? "page" : undefined}
                className={cn(
                  "hover:bg-muted/50 focus-visible:ring-ring/50 relative flex h-full w-full items-start gap-3 px-5 py-3 text-left outline-none focus-visible:ring-3 focus-visible:ring-inset lg:flex-col lg:gap-2 lg:px-4 lg:py-4",
                  open &&
                    "bg-muted/50 after:bg-foreground after:absolute after:inset-y-0 after:left-0 after:w-0.5 lg:after:inset-x-0 lg:after:top-auto lg:after:bottom-0 lg:after:h-0.5 lg:after:w-auto"
                )}
                params={{ clientId }}
                // The step the organization is at is where the steps open by themselves.
                search={each === view.stage ? {} : { stage: each }}
                to={sectionTo.steps}
              >
                <StageMark status={status} />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-medium">
                    {stageWords[each]}
                    <span className="sr-only">: {statusWords[status]}</span>
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {lines[each]}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
    </nav>
  );
};

/** The ten things Stephen needs from the first conversation, by name. */
const visionWords: Record<VisionField, string> = {
  business: "The business in one sentence",
  teams: "The teams, and what each does",
  goals: "Goals for the next two years, and why AI now",
  success: "What success is, in hours or workflows",
  stakeholders: "Who decides, who can block, who hears first",
  pain: "The work the sponsor already suspects",
  limits: "What Stephen must not touch",
  sensitivities: "What is sensitive right now",
  systems: "The main tools",
  languages: "The languages the teams work in",
};

/**
 * What the first conversation brought, as the model counts it: which of
 * the ten things are in, by name, never what was said about them.
 */
const Brought = ({ view }: { view: OrgView }) => {
  const { vision } = view;
  if (vision === null) {
    return (
      <p className="text-muted-foreground">
        Stephen has read it. What it brought stays in the company’s own Grasp.
      </p>
    );
  }
  const inNow = VISION_FIELDS.filter((field) => vision.fields[field]).length;
  return (
    <>
      <div className="flex w-full flex-col gap-2">
        <span className="text-muted-foreground tabular-nums">
          {inNow} of {VISION_FIELDS.length} in
        </span>
        <Progress
          aria-label="What it brought"
          value={(inNow / VISION_FIELDS.length) * 100}
        />
      </div>
      <ul className="grid w-full gap-2 sm:grid-cols-2">
        {VISION_FIELDS.map((field) =>
          vision.fields[field] ? (
            <li className="rounded-lg border p-3" key={field}>
              <Done>{visionWords[field]}</Done>
            </li>
          ) : (
            <li
              className="border-status-attention/60 flex flex-col gap-0.5 rounded-lg border border-dashed p-3"
              key={field}
            >
              <span className="font-medium">{visionWords[field]}</span>
              <span className="text-status-attention">
                Missing: ask the sponsor
              </span>
            </li>
          )
        )}
      </ul>
    </>
  );
};

/** The first conversation with the sponsor: whether it is in, whether Stephen read it, and what it brought. */
const Conversation = ({ view }: { view: OrgView }) => {
  const { conversation } = view.state;
  return (
    <Panel
      description="Grasp’s first talk with the sponsor. Stephen reads the transcript, and says what is still missing."
      title="The first conversation"
    >
      <div className="flex flex-col items-start gap-3 border-t px-5 py-4">
        <span className="font-medium">What it brought</span>
        {conversation === "read" ? (
          <Brought view={view} />
        ) : (
          <p className="text-muted-foreground">
            {conversation === "in"
              ? "Stephen has not read this transcript yet."
              : "Nothing yet. Once the transcript is in, Stephen reads it for the ten things he needs before his first interview."}
          </p>
        )}
      </div>
      <PanelRow
        description="What was said stays in the company’s own Grasp: the console never shows it."
        label="The transcript"
      >
        {conversation === "none" ? (
          <span className="text-muted-foreground">Not brought in yet</span>
        ) : (
          <Done>Brought in</Done>
        )}
      </PanelRow>
      <NotHere>
        Bringing in the transcript, having Stephen read it and filling in what
        the sponsor answered aren’t in the console yet.
      </NotHere>
    </Panel>
  );
};

const sourceIcons: Record<ResearchSource, LucideIcon> = {
  register: Building2Icon,
  website: GlobeIcon,
  news: NewspaperIcon,
  jobs: BriefcaseIcon,
  regulator: ScaleIcon,
  reviews: MessageSquareTextIcon,
};

/** Each public place the research looks, and what it gives. */
const sourceWords: Record<ResearchSource, { label: string; gives: string }> = {
  register: {
    label: "Company register",
    gives: "Legal form, offices, line of business and how many people.",
  },
  website: {
    label: "Website",
    gives: "What the company sells, to whom, and through which channels.",
  },
  news: {
    label: "Annual report and news",
    gives: "Strategy, growth, mergers and recent changes.",
  },
  jobs: {
    label: "Job ads",
    gives: "The tools in use, the names of teams, and what each role does.",
  },
  regulator: {
    label: "Regulator registers",
    gives: "Licences and supervisors: they say where the law sets the steps.",
  },
  reviews: {
    label: "Customer reviews",
    gives:
      "Complaints that keep coming back, which often point at work that stalls.",
  },
};

/**
 * The research into the company, never into its people: six public
 * places and the library of what companies like it usually do, each
 * looked up or not. What a place gave is the research's own words, kept
 * in the company's Grasp; here only whether it was looked up, and whether
 * it disagrees with the company's own account.
 */
const Research = ({ view }: { view: OrgView }) => {
  const { org, state } = view;
  const done = state.research === "done";
  const notYet = (
    <span className="text-muted-foreground">Not looked up yet</span>
  );
  return (
    <Panel
      description="Stephen looks up the company, never its people. Every fact keeps its source and its date."
      title="The research"
    >
      {state.conversation === "read" || done ? null : (
        <p className="text-muted-foreground border-t px-5 py-3">
          It starts once Stephen has read the first conversation: that tells him
          what to look for.
        </p>
      )}
      <ul className="bg-border grid gap-px border-t md:grid-cols-2 xl:grid-cols-3">
        {RESEARCH_SOURCES.map((source) => {
          const Icon = sourceIcons[source];
          const finding = org.research.find((each) => each.source === source);
          const disagrees = (finding?.conflict ?? "") !== "";
          return (
            <li className="bg-card flex flex-col gap-2 p-5" key={source}>
              <span className="flex items-center gap-2">
                <Icon
                  aria-hidden
                  className="text-muted-foreground size-4 flex-none"
                />
                <span className="font-medium">{sourceWords[source].label}</span>
              </span>
              <span className="text-muted-foreground text-xs">
                {sourceWords[source].gives}
              </span>
              {done && finding !== undefined ? <Done>Looked up</Done> : notYet}
              {done && disagrees ? (
                <span className="text-status-attention">
                  {state.passed.includes(source)
                    ? "It disagrees with the company’s own account: passed on to its admin."
                    : "It disagrees with the company’s own account. Its admin says which is right."}
                </span>
              ) : null}
            </li>
          );
        })}
        <li className="bg-card col-span-full flex flex-col gap-2 p-5">
          <span className="flex items-center gap-2">
            <LibraryIcon
              aria-hidden
              className="text-muted-foreground size-4 flex-none"
            />
            <span className="font-medium">
              What companies like this usually do
            </span>
          </span>
          <span className="text-muted-foreground text-xs">
            The work such a company usually does, and where it usually stalls.
          </span>
          {done && org.library !== "" ? <Done>Looked up</Done> : notYet}
        </li>
      </ul>
      <NotHere>
        Starting the research and passing a disagreement on to the company’s
        admin aren’t in the console yet.
      </NotHere>
    </Panel>
  );
};

/** One thing to agree on: where it stands on top, then what it is. */
const AgreedTile = ({
  label,
  description,
  done,
  status,
}: {
  label: string;
  description: string;
  done: boolean;
  status: string;
}) => (
  <div className="bg-card flex flex-col gap-3 p-5">
    {done ? (
      <Done>{status}</Done>
    ) : (
      <span className="text-status-attention">{status}</span>
    )}
    <div className="flex flex-1 flex-col gap-0.5">
      <span className="font-medium">{label}</span>
      <p className="text-muted-foreground">{description}</p>
    </div>
  </div>
);

const councilWords = {
  yes: "Said yes",
  none: "No works council",
  waiting: "Still deciding",
} as const;

/**
 * What has to be in place before anyone is invited: the agreement on
 * handling data, the company's own look at the risks to its people, and
 * the works council's yes where there is one.
 */
const Agreed = ({ view }: { view: OrgView }) => {
  const { agreed } = view.state;
  return (
    <Panel
      description="Without all three, nobody is invited."
      title="Agreed before the first interview"
    >
      <div className="bg-border grid gap-px border-t lg:grid-cols-3">
        <AgreedTile
          description="The data processing agreement between the company and Grasp, signed in the first talk."
          done={agreed.processing}
          label="Agreement on handling data"
          status={agreed.processing ? "Signed" : "Not signed yet"}
        />
        <AgreedTile
          description="The data protection impact assessment. Grasp brings it filled in, and the company signs it off."
          done={agreed.assessment}
          label="The company’s look at the risks to its people"
          status={agreed.assessment ? "Signed off" : "Not signed off yet"}
        />
        <AgreedTile
          description="Only the works council can agree to this, not the sponsor. It often takes several weeks."
          done={agreed.council !== "waiting"}
          label="Works council"
          status={councilWords[agreed.council]}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border-t px-5 py-3">
        {mayInvite(agreed) ? (
          <Done>Interviews can start.</Done>
        ) : (
          <span className="text-status-attention">
            Interviews wait until all of this is in place.
          </span>
        )}
        {view.told ? (
          <span className="text-muted-foreground">
            The team is told, so this stays as it was agreed.
          </span>
        ) : null}
      </div>
      <NotHere>
        Keeping what was agreed as it comes in isn’t in the console yet.
      </NotHere>
    </Panel>
  );
};

/**
 * What the company does itself, in its own onboarding: its admin
 * connects the sign-in, names the team leads and tells the team. Grasp
 * waits on each and sees it here.
 */
const Company = ({ view }: { view: OrgView }) => {
  const { state } = view;
  const people = view.people.length;
  const teams = view.teams.length;
  const connected = state.client !== "none";
  const named = state.client === "leads" || state.client === "told";
  const waits = <span className="text-muted-foreground">Not yet</span>;
  let told = waits;
  if (view.told) {
    told = <Done>On {dayDate(view, 0)}</Done>;
  } else if (!mayInvite(state.agreed)) {
    told = (
      <span className="text-status-attention sm:text-right">
        Waits until everything is agreed
      </span>
    );
  }
  return (
    <Panel
      description="In its own onboarding. Grasp waits on each of these, and sees it here the moment it is done."
      title="What the company does itself"
    >
      <PanelRow
        description="It tells Grasp who works where: the teams, and everyone in them."
        label="The sign-in is connected"
      >
        {connected ? (
          <Done>
            {people} people in {counted(teams, "team", "teams")}
          </Done>
        ) : (
          waits
        )}
      </PanelRow>
      <PanelRow
        description="From the company’s HR platform, or typed in by its admin."
        label="The team leads are named"
      >
        {named ? (
          <Done>{counted(teams, "team lead", "team leads")}</Done>
        ) : (
          waits
        )}
      </PanelRow>
      <PanelRow
        description="The company’s own message goes first. The same day every team lead gets a link."
        label="The team is told"
      >
        {told}
      </PanelRow>
    </Panel>
  );
};

/** Where one lead stands, in a line. */
const leadLine = (view: OrgView, lead: PersonView, size: number): ReactNode => {
  if (!view.told) {
    return (
      <span className="text-muted-foreground">
        Gets a link the day the team is told.
      </span>
    );
  }
  if (lead.completed !== null) {
    return (
      <Done>
        Talked on {dayDate(view, lead.completed)}.{" "}
        {counted(size, "colleague got a link.", "colleagues got a link.")}
      </Done>
    );
  }
  if (lead.reminded !== null) {
    return (
      <span className="text-status-attention">
        Reminded on {dayDate(view, lead.reminded)}, and has not talked yet. A
        word from the sponsor helps.
      </span>
    );
  }
  return (
    <span className="text-muted-foreground">
      {linkWords[lead.state]}. The team waits for this interview.
    </span>
  );
};

/**
 * The team leads: they go first, because a lead's interview brings the
 * team's work and who knows each piece best, and only then does the team
 * get its links. A lead who is late holds up a whole team.
 */
const Leads = ({ view }: { view: OrgView }) => {
  const leads = view.teams.flatMap((team) =>
    team.lead !== null && !team.off ? [{ team, lead: team.lead }] : []
  );
  const waiting = leads.filter(({ lead }) => lead.mayRemind).length;
  return (
    <Panel
      description="A lead’s interview takes 30 minutes: the team’s work, how much of it there is, and who knows each piece best. The same day their team gets its links."
      title="Team leads"
    >
      {leads.length === 0 ? (
        <p className="text-muted-foreground border-t px-5 py-4">
          Not known yet. The company names its team leads in its own onboarding.
        </p>
      ) : (
        <ul className="flex flex-col">
          {leads.map(({ team, lead }) => (
            <li
              className="grid items-center gap-x-6 gap-y-1 border-t px-5 py-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]"
              key={team.team.id}
            >
              <span className="flex min-w-0 flex-col">
                {lead.person.name}
                <span className="text-muted-foreground text-xs">
                  {team.team.name}
                </span>
              </span>
              <span className="min-w-0">
                {leadLine(view, lead, team.people.length - 1)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {waiting > 0 ? (
        <NotHere>
          {counted(waiting, "lead", "leads")} can still be reminded. Sending the
          reminder isn’t in the console yet.
        </NotHere>
      ) : null}
    </Panel>
  );
};

/** How one team's links stand, beside its progress. */
const teamLine = (view: OrgView, team: OrgView["teams"][number]): string => {
  const lead = team.lead?.person.first ?? "";
  if (team.sent === null) {
    return lead === ""
      ? "Waits for the lead’s list"
      : `Waits for ${lead}’s list`;
  }
  const waiting = team.people.filter((each) => each.mayRemind).length;
  if (waiting > 0) {
    return `${waiting} not reminded yet`;
  }
  return team.counts.completed < team.asked && !view.closed
    ? "All reminded"
    : "";
};

/**
 * The interviews themselves: how many talked, per team, and how many
 * can still be sent the one reminder. One reminder a person, then nobody
 * is chased, so not taking part stays safe.
 */
const Interviews = ({
  view,
  clientId,
}: {
  view: OrgView;
  clientId: string;
}) => {
  const { counts } = view;
  const closes = dayDate(view, LISTEN_DAYS);
  let description =
    "Two weeks, from the day the company tells its team. Everyone gets one link, and one reminder.";
  if (view.closed) {
    description = `The link closed on ${closes}. What was said stays; a link that was not used has expired.`;
  } else if (view.told) {
    description = `Day ${view.day} of ${LISTEN_DAYS}. The link closes on ${closes}. One reminder a person, then nobody is chased: not taking part stays safe.`;
  }
  if (!view.told) {
    return (
      <Panel description={description} title="Interviews">
        <p className="text-muted-foreground border-t px-5 py-4">
          Nobody has a link yet. They go out once everything is agreed and the
          company has told its team.
        </p>
      </Panel>
    );
  }
  const reminders = view.people.filter((each) => each.mayRemind).length;
  return (
    <Panel description={description} title="Interviews">
      <div className="bg-border grid gap-px border-t sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          label="have talked"
          value={`${counts.completed} of ${view.asked}`}
        />
        <Tile label="are talking right now" value={counts.progress} />
        <Tile label="stopped halfway" value={counts.incomplete} />
        {view.closed ? (
          <Tile label="never used their link" value={counts.expired} />
        ) : (
          <Tile
            label="have not started"
            value={counts.invited + counts.opened + counts.waiting}
          />
        )}
      </div>
      <ul className="flex flex-col">
        {view.teams
          .filter((team) => !team.off)
          .map((team) => {
            const done = team.counts.completed;
            return (
              <li
                className="grid items-center gap-x-6 gap-y-2 border-t px-5 py-3 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_minmax(0,11rem)]"
                key={team.team.id}
              >
                <span className="min-w-0 truncate">{team.team.name}</span>
                <span className="flex min-w-0 items-center gap-3">
                  <Progress
                    aria-label={team.team.name}
                    className="flex-1"
                    value={(done / Math.max(team.asked, 1)) * 100}
                  />
                  <span className="text-muted-foreground w-16 flex-none text-right tabular-nums">
                    {done} of {team.asked}
                  </span>
                </span>
                <span className="text-muted-foreground sm:text-right">
                  {teamLine(view, team)}
                </span>
              </li>
            );
          })}
      </ul>
      <div className="flex justify-end border-t px-5 py-3">
        <Button
          nativeButton={false}
          render={<Link params={{ clientId }} to={sectionTo.interviews} />}
          size="sm"
          variant="ghost"
        >
          Everyone by name
          <ArrowRightIcon data-icon="inline-end" />
        </Button>
      </div>
      {view.closed || reminders === 0 ? null : (
        <NotHere>
          {counted(reminders, "person", "people")} can still be reminded.
          Sending the reminder isn’t in the console yet.
        </NotHere>
      )}
    </Panel>
  );
};

/** Each place what Grasp knows comes from, by name. */
const knowledgeWords: Record<
  OrgView["knowledge"]["sources"][number]["source"],
  string
> = {
  vision: "The first conversation and the research",
  directory: "Who works where, from the sign-in",
  sources: "Where the documents live, connected",
  documents: "Documents dropped in",
  pulse: "Pulse",
  leadsKnown: "Team leads, from the HR platform",
  leadsHeard: "Team leads interviewed",
  everyoneHeard: "Everyone else interviewed",
  review: "Workflows known",
};

/** Where Grasp's go stands, in a line under the percentage. */
const goLine = (view: OrgView): ReactNode => {
  const { knowledge, org } = view;
  const { threshold } = knowledge;
  if (knowledge.opened !== null) {
    return (
      <Done>
        Open since {dayDate(view, knowledge.opened)}. {org.name} is in, and
        Stephen keeps learning from here.
      </Done>
    );
  }
  if (knowledge.ready) {
    return (
      <span className="text-status-attention">
        Enough is known: it is past {threshold}%. {org.name} comes in the moment
        Grasp gives its go.
      </span>
    );
  }
  if (view.closed) {
    return (
      <span className="text-status-attention">
        The interviews are over and it stayed below {threshold}%. Grasp can open
        it anyway, with what is not known shown as still open.
      </span>
    );
  }
  return (
    <span className="text-muted-foreground">
      Not enough is known yet. It can open once it is past {threshold}%.
    </span>
  );
};

/**
 * Grasp opening for the company: its platform stays closed until Grasp
 * gives its go, on how much of what Grasp needs is known (the percentage
 * the company sees in its own onboarding) against the share at which it
 * opens; where that comes from; and the work not known yet, which shows
 * to the company as still open.
 */
const Opens = ({ view, clientId }: { view: OrgView; clientId: string }) => {
  const { knowledge } = view;
  const known = `${knowledge.percent}% of what Grasp needs is known.`;
  const blocked = view.works.filter((work) => work.state === "blocked");
  const open = view.works.filter(
    (work) => work.state === "mapping" || work.state === "saturating"
  );
  const notKnown = [...blocked, ...open];
  return (
    <Panel
      description="The company’s platform stays closed until Grasp gives its go. What is not known by then shows to the company as still open, so it keeps nobody out."
      title="Grasp opens"
    >
      <div className="flex flex-col gap-5 border-t px-5 py-5">
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
          <div className="flex min-w-0 flex-col gap-3">
            <span className="text-2xl leading-none font-medium tabular-nums">
              {knowledge.percent}%
            </span>
            <KnowledgeDots count={40} knowledge={knowledge} label={known} />
          </div>
          <span className="text-muted-foreground">
            Opens at {knowledge.threshold}%
          </span>
        </div>
        <div>{goLine(view)}</div>
      </div>

      <div className="flex flex-col gap-0.5 border-t px-5 py-4">
        <span className="font-medium">How the brain fills</span>
        <p className="text-muted-foreground">
          {knowledge.sources.length > 0
            ? "Every source adds its own share, and only once it is in. The brain never guesses."
            : "The company’s own Grasp counts what is known and sends the whole, not each source’s share."}
        </p>
      </div>
      {knowledge.sources.length > 0 ? (
        <ul className="flex flex-col">
          {knowledge.sources.map((each) => (
            <li
              className="grid items-center gap-x-6 gap-y-1.5 border-t px-5 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)_4.5rem]"
              key={each.source}
            >
              <span className="min-w-0">{knowledgeWords[each.source]}</span>
              <Progress
                aria-label={knowledgeWords[each.source]}
                value={each.known * 100}
              />
              <span className="text-muted-foreground tabular-nums sm:text-right">
                {each.points} of {each.weight}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {view.told && notKnown.length > 0 ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-4">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium">Not known yet</span>
              <p className="text-muted-foreground">
                The work that is still being heard, or waits on an answer.
              </p>
            </div>
            <Button
              nativeButton={false}
              render={<Link params={{ clientId }} to={sectionTo.workflows} />}
              size="sm"
              variant="ghost"
            >
              All workflows
              <ArrowRightIcon data-icon="inline-end" />
            </Button>
          </div>
          <ul className="flex flex-col">
            {notKnown.map((work) => (
              <li
                className="grid items-center gap-x-6 gap-y-0.5 border-t px-5 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,14rem)]"
                key={work.id}
              >
                <span className="flex min-w-0 flex-col">
                  {work.work.name}
                  <span className="text-muted-foreground text-xs">
                    {view.teams.find((each) => each.team.id === work.team)?.team
                      .name ?? ""}
                  </span>
                </span>
                <span className="text-muted-foreground tabular-nums">
                  {work.approved} of {work.doers} talked
                </span>
                <span
                  className={cn(
                    "sm:text-right",
                    work.state === "blocked"
                      ? "text-status-attention"
                      : "text-muted-foreground"
                  )}
                >
                  {workflowWords[work.state]}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <NotHere>
        Giving Grasp’s go, taking it back and changing the share it opens at
        aren’t in the console yet.
      </NotHere>
    </Panel>
  );
};

/** One organization's onboarding: its steps, and the chosen one opened underneath. */
export const OrgSteps = ({
  view,
  stage,
  clientId,
}: {
  view: OrgView;
  /** The step that is open. */
  stage: Stage;
  clientId: string;
}) => (
  <>
    <StageList clientId={clientId} stage={stage} view={view} />
    {stage === "conversation" ? <Conversation view={view} /> : null}
    {stage === "research" ? <Research view={view} /> : null}
    {stage === "agreed" ? <Agreed view={view} /> : null}
    {stage === "connected" ? <Company view={view} /> : null}
    {stage === "leads" ? <Leads view={view} /> : null}
    {stage === "interviews" ? (
      <Interviews clientId={clientId} view={view} />
    ) : null}
    {stage === "open" ? <Opens clientId={clientId} view={view} /> : null}
  </>
);
