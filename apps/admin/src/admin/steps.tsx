import { VISION_FIELDS } from "@grasp-os/shared/admin/interviews";
import {
  dateOn,
  mayInvite,
  RESEARCH_SOURCES,
} from "@grasp-os/shared/admin/onboarding-admin";
import type {
  OrgView,
  ResearchSource,
  Stage,
  StageStatus,
} from "@grasp-os/shared/admin/onboarding-admin";
import type { OnboardingFlow } from "@grasp-os/shared/onboarding-flow";
import { Button } from "@grasp-os/ui/components/button";
import { Progress } from "@grasp-os/ui/components/progress";
/**
 * One organization's onboarding, step by step, ported from the prototype
 * (grasplabs/prototype `components/admin/org-steps.tsx` and the
 * `stage-*.tsx` it opens): the steps from the first conversation until
 * Grasp opens, each with where it stands, and the step that is chosen
 * opened underneath. It opens on the step the organization is at.
 *
 * Staff steer the onboarding from here, each change a command to the
 * company's Grasp (commands.tsx): pausing the interviews, the share at
 * which it opens, and giving Grasp's go or taking it back; the first
 * conversation is brought in from its own step (kickoff.tsx). Three steps
 * open nothing here, for their own section shows them, with what staff do
 * there: what was agreed is the Contract's, the team leads and the
 * interviews are the Interviews'; each goes there. What the admin can't do
 * yet (starting the research) says so where its buttons were. Nor is the
 * company's own link here, as the prototype had it under the steps: a
 * link is a credential, and core never sends one. And nothing anyone
 * said is shown: not the first conversation, not what the research
 * found, only what the model counts.
 */
import { Stat } from "@grasp-os/ui/components/stat";
import { cn } from "@grasp-os/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  ArrowUpRightIcon,
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

import { GateControls } from "./commands.tsx";
import type { GateState } from "./commands.tsx";
import { opensElsewhere, stageShown, stagesIn } from "./flow-stages.ts";
import { Kickoff, visionWords } from "./kickoff.tsx";
import { Attention, Done, KnowledgeDots } from "./parts.tsx";
import { Section, SectionRow } from "./section.tsx";
import { sectionTo } from "./sections.ts";
import { formatDate, stageWords } from "./words.ts";

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
 * Where something the prototype does here would be: not in the admin
 * yet, for it writes to the company's Grasp.
 */
const NotHere = ({ children }: { children: ReactNode }) => (
  <p
    className="text-muted-foreground border-t px-5 py-3 text-xs"
    data-slot="not-in-admin"
  >
    {children}
  </p>
);

/** How many columns the steps take when wide, by how many the flow has: a class each, as a class is never built from a number. */
const stageColumns: Record<number, string> = {
  1: "lg:grid-cols-1",
  2: "lg:grid-cols-2",
  3: "lg:grid-cols-3",
  4: "lg:grid-cols-4",
  5: "lg:grid-cols-5",
  6: "lg:grid-cols-6",
  7: "lg:grid-cols-7",
};

const stageLinkClass =
  "hover:bg-muted/50 focus-visible:ring-ring/50 relative flex h-full w-full items-center gap-3 px-5 py-3 text-left outline-none focus-visible:ring-3 focus-visible:ring-inset lg:flex-col lg:items-start lg:gap-2 lg:px-4 lg:py-4";

/** A step's mark and name, with where it stands said to a screen reader. */
const StageName = ({
  stage,
  status,
  leaves = false,
}: {
  stage: Stage;
  status: StageStatus;
  /** The step is shown in another section, which its link goes to. */
  leaves?: boolean;
}) => (
  <>
    <StageMark status={status} />
    <span className="min-w-0 flex-1 font-medium lg:flex-none">
      {stageWords[stage]}
      <span className="sr-only">: {statusWords[status]}</span>
    </span>
    {/* In the same corner of every step that leads elsewhere, so the names line up whether or not one does. */}
    {leaves ? (
      <ArrowUpRightIcon
        aria-hidden
        className="text-muted-foreground size-3.5 flex-none lg:absolute lg:top-4 lg:right-4"
      />
    ) : null}
  </>
);

/** A step another section shows: a link there. */
const StageElsewhere = ({
  stage,
  status,
  clientId,
}: {
  stage: keyof typeof opensElsewhere;
  status: StageStatus;
  clientId: string;
}) => {
  const { section, search } = opensElsewhere[stage];
  return (
    <Link
      className={stageLinkClass}
      params={{ clientId }}
      search={search}
      to={sectionTo[section]}
    >
      <StageName leaves stage={stage} status={status} />
    </Link>
  );
};

/** The steps: each a link that opens it underneath, the open one marked as a chosen tab is, or a link to the section that shows it. */
const StageList = ({
  view,
  stage,
  shown,
  clientId,
}: {
  view: OrgView;
  stage: Stage;
  /** The steps this company's flow has. */
  shown: readonly Stage[];
  clientId: string;
}) => (
  <nav
    aria-label="The steps of this onboarding"
    className="bg-card overflow-hidden rounded-xl border"
  >
    <ol className={cn("grid", stageColumns[shown.length])}>
      {shown.map((each) => {
        const open = each === stage;
        const status = view.stages[each];
        return (
          <li
            className="border-b last:border-b-0 lg:border-r lg:border-b-0 lg:last:border-r-0"
            key={each}
          >
            {each in opensElsewhere ? (
              <StageElsewhere
                clientId={clientId}
                // SAFETY: just checked to be one of its keys.
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
                stage={each as keyof typeof opensElsewhere}
                status={status}
              />
            ) : (
              <Link
                // The router marks the link the page is on itself, as the page.
                activeOptions={{ exact: true }}
                aria-current={open ? "page" : undefined}
                className={cn(
                  stageLinkClass,
                  open &&
                    "bg-muted/50 after:bg-foreground after:absolute after:inset-y-0 after:left-0 after:w-0.5 lg:after:inset-x-0 lg:after:top-auto lg:after:bottom-0 lg:after:h-0.5 lg:after:w-auto"
                )}
                params={{ clientId }}
                search={{ stage: each }}
                to={sectionTo.steps}
              >
                <StageName stage={each} status={status} />
              </Link>
            )}
          </li>
        );
      })}
    </ol>
  </nav>
);

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

/**
 * The first conversation with the sponsor: whether it is in, whether
 * Stephen read it, and what it brought; and bringing it in, with the
 * sponsor's answers to what it left open (src/admin/kickoff.tsx).
 */
const Conversation = ({
  view,
  clientId,
}: {
  view: OrgView;
  clientId: string;
}) => {
  const { conversation } = view.state;
  return (
    <Section title="The first conversation">
      <div className="flex flex-col items-start gap-3 border-t px-5 py-4">
        <span className="font-medium">What it brought</span>
        {conversation === "read" ? (
          <Brought view={view} />
        ) : (
          <p className="text-muted-foreground">
            {conversation === "in"
              ? "Stephen has not read this transcript yet."
              : "Once the transcript is in, Stephen reads it for the ten things he needs before his first interview."}
          </p>
        )}
      </div>
      {/* Keyed by the company: another's drafts and answers never carry over. */}
      <Kickoff clientId={clientId} key={clientId} />
    </Section>
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
    <Section title="The research">
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
                <Attention>
                  {state.passed.includes(source)
                    ? "It disagrees with the company’s own account: passed on to its admin."
                    : "It disagrees with the company’s own account. Its admin says which is right."}
                </Attention>
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
        admin aren’t in the admin yet.
      </NotHere>
    </Section>
  );
};

/** While the company has paused its interviews: core lets nobody open or save one. */
const pausedLine =
  "The company has paused its interviews: nobody can open or go on with one until it resumes them.";

/** Each screen of the company's own onboarding, as staff read where its admin is. */
const adminStepWords: Readonly<Record<string, string>> = {
  welcome: "The welcome",
  ai: "Choosing its AI",
  about: "How this works",
  company: "Who’s who",
  sources: "Where the work is written down",
  documents: "Its documents",
  pulse: "The tools people use",
  leads: "The team leads",
  team: "Telling the team",
  listening: "Waiting while Stephen talks to the team",
  review: "What needs its admin",
  open: "The last screen, before Grasp opens",
  done: "Finished every screen",
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
    <Section title="What the company does itself">
      <SectionRow label="Where its admin is">
        {view.org.adminStep === undefined ? (
          <span className="text-muted-foreground">Not started</span>
        ) : (
          <span>
            {adminStepWords[view.org.adminStep] ?? view.org.adminStep}
          </span>
        )}
      </SectionRow>
      <SectionRow label="The sign-in is connected">
        {connected ? (
          <Done>
            {people} people in {counted(teams, "team", "teams")}
          </Done>
        ) : (
          waits
        )}
      </SectionRow>
      <SectionRow label="The team leads are named">
        {named ? (
          <Done>{counted(teams, "team lead", "team leads")}</Done>
        ) : (
          waits
        )}
      </SectionRow>
      <SectionRow label="The team is told">{told}</SectionRow>
    </Section>
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
      <Attention>
        Enough is known: it is past {threshold}%. {org.name} comes in the moment
        Grasp gives its go.
      </Attention>
    );
  }
  if (view.closed) {
    return (
      <Attention>
        The interviews are over and it stayed below {threshold}%. Grasp can open
        it anyway, with what is not known shown as still open.
      </Attention>
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
const Opens = ({
  view,
  clientId,
  gate,
  paused,
}: {
  view: OrgView;
  clientId: string;
  gate: GateState;
  paused: boolean;
}) => {
  const { knowledge } = view;
  const known = `${knowledge.percent}% of what Grasp needs is known.`;
  const notKnown = view.works.filter(
    (work) =>
      work.state === "blocked" ||
      work.state === "mapping" ||
      work.state === "saturating"
  ).length;
  return (
    <Section
      description="What is not known by then shows to the company as still open."
      title="Grasp opens"
    >
      <div className="flex flex-col gap-5 border-t px-5 py-5">
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
          <div className="flex min-w-0 flex-col gap-3">
            <Stat>{knowledge.percent}%</Stat>
            <KnowledgeDots count={40} knowledge={knowledge} label={known} />
          </div>
          <GateControls clientId={clientId} gate={gate} paused={paused} />
        </div>
        <div aria-live="polite">{goLine(view)}</div>
        {paused ? <Attention>{pausedLine}</Attention> : null}
      </div>

      {knowledge.sources.length > 0 ? (
        <ul aria-label="How the brain fills" className="flex flex-col">
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

      {view.told && notKnown > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-3">
          <span className="text-muted-foreground">
            {counted(notKnown, "workflow is", "workflows are")} not known yet.
          </span>
          <Button
            nativeButton={false}
            render={<Link params={{ clientId }} to={sectionTo.workflows} />}
            size="sm"
            variant="outline"
          >
            All workflows
            <ArrowRightIcon data-icon="inline-end" />
          </Button>
        </div>
      ) : null}
    </Section>
  );
};

/** One organization's onboarding: its steps, and the chosen one opened underneath. */
export const OrgSteps = ({
  view,
  stage: asked,
  clientId,
  paused,
  gate,
  flow,
}: {
  view: OrgView;
  /** The step asked for: it opens while the flow has it and it opens here. */
  stage: Stage;
  clientId: string;
  /** The company has paused its interviews, which the model doesn't carry. */
  paused: boolean;
  /** The gate as core keeps it: open now or not, and Grasp's go. */
  gate: GateState;
  /** How much onboarding the company goes through; none from a Grasp that says no flow. */
  flow: OnboardingFlow | undefined;
}) => {
  const shown = stagesIn(flow);
  const stage = stageShown(shown, asked, view.stages);
  return (
    <>
      <StageList clientId={clientId} shown={shown} stage={stage} view={view} />
      {stage === "conversation" ? (
        <Conversation clientId={clientId} view={view} />
      ) : null}
      {stage === "research" ? <Research view={view} /> : null}
      {stage === "connected" ? <Company view={view} /> : null}
      {stage === "open" ? (
        <Opens clientId={clientId} gate={gate} paused={paused} view={view} />
      ) : null}
    </>
  );
};
