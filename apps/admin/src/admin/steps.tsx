/**
 * One organization's onboarding, step by step, composed as Grasp Work
 * composes a page: the steps from the first conversation until Grasp
 * opens as a row of tabs, each saying where it stands, and the chosen one
 * opened under them, its content on the page. It opens on the step the
 * organization is at.
 *
 * Staff steer the onboarding from here, each change a command to the
 * company's Grasp (commands.tsx): pausing the interviews, the share at
 * which it opens, and giving Grasp's go or taking it back; the first
 * conversation is brought in from its own step (kickoff.tsx). Three steps
 * open nothing here, for their own section shows them, with what staff do
 * there: what was agreed is the Contract's, the team leads and the
 * interviews are the Interviews'; each goes there. What the admin can't do
 * yet (starting the research) says so where its buttons would be. Nor is
 * the company's own link here: a link is a credential, and core never
 * sends one. And nothing anyone said is shown: not the first
 * conversation, not what the research found, only what the model counts.
 */
import {
  dateOn,
  mayInvite,
  RESEARCH_SOURCES,
} from "@grasp-os/shared/admin/onboarding-admin";
import type {
  OrgKnowledge,
  OrgView,
  ResearchSource,
  Stage,
  StageStatus,
} from "@grasp-os/shared/admin/onboarding-admin";
import type { OnboardingFlow } from "@grasp-os/shared/onboarding-flow";
import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
import { Badge } from "@grasp-os/ui/components/badge";
import { ChartBarList } from "@grasp-os/ui/components/chart";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { KeyValueList } from "@grasp-os/ui/components/key-value";
import {
  Section as Part,
  SectionHeader,
} from "@grasp-os/ui/components/section-header";
import { Stat } from "@grasp-os/ui/components/stat";
import { TabsLink, TabsNav } from "@grasp-os/ui/components/tabs";
import { Text } from "@grasp-os/ui/components/text";
import {
  ArrowUpRightIcon,
  BuildingIcon,
  CircleCheckIcon,
  CircleIcon,
  ClockIcon,
  FileDocIcon,
  FolderIcon,
  GlobeIcon,
  HourglassIcon,
  Icon,
  MessageSquareIcon,
  ScaleIcon,
  UsersIcon,
  WorkflowIcon,
} from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import { colors, radius, size, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import { Fragment } from "react";
import type { ReactNode } from "react";

import { GateControls } from "./commands.tsx";
import type { GateState } from "./commands.tsx";
import { elsewhereOf, stageShown, stagesIn } from "./flow-stages.ts";
import { Kickoff } from "./kickoff.tsx";
import { sectionTo } from "./sections.ts";
import { formatDate, stageWords } from "./words.ts";

const styles = stylex.create({
  // The steps' tabs, then the open step's parts, a step further apart than the lines within each.
  parts: { display: "flex", flexDirection: "column", gap: space["8"] },
  part: { display: "flex", flexDirection: "column", gap: space["4"] },
  // The share that is known and the go beside it, the go under it on a phone.
  opens: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-end",
    justifyContent: "space-between",
    columnGap: space["8"],
    rowGap: space["4"],
  },
  known: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    gap: space["3"],
    minWidth: 0,
    maxWidth: "25rem",
  },
  // As wide as what it stands in, at most forty dots and their gaps: on a phone each dot shrinks.
  dots: {
    display: "flex",
    alignItems: "center",
    gap: space["1"],
  },
  dot: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    maxWidth: "0.375rem",
    aspectRatio: "1",
    borderRadius: radius.circle,
    backgroundColor: colors.border,
  },
  filled: { backgroundColor: colors.foreground },
  // Where Grasp opens: a thin upright line between the dots.
  gate: {
    width: size.hairline,
    height: "0.875rem",
    flexShrink: 0,
    marginInline: "0.125rem",
    backgroundColor: colors.foreground,
  },
});

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

/**
 * Each step's mark, by where it stands, as the overview marks who a need
 * waits on: a clock while it is in Grasp's hands, an hourglass while it
 * waits on someone else.
 */
const statusIcons: Record<StageStatus, IconData> = {
  done: CircleCheckIcon,
  now: ClockIcon,
  waits: HourglassIcon,
  later: CircleIcon,
};

// ---- The steps ----------------------------------------------------------

/** A step's name, with where it stands said to a screen reader, and a mark where it leads to another section. */
const StageName = ({
  stage,
  status,
  leaves,
}: {
  stage: Stage;
  status: StageStatus;
  leaves: boolean;
}) => (
  <>
    {stageWords[stage]}
    <span {...stylex.props(visuallyHidden)}>: {statusWords[status]}</span>
    {leaves ? <Icon icon={ArrowUpRightIcon} /> : null}
  </>
);

/**
 * The steps, as tabs that each have their own address: one that opens
 * here opens underneath, marked as the page; one another section shows
 * goes there.
 */
const StageTabs = ({
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
  <TabsNav aria-label="The steps of this onboarding">
    {shown.map((each) => {
      const status = view.stages[each];
      const elsewhere = elsewhereOf(each);
      return (
        <TabsLink
          asChild
          current={each === stage}
          icon={statusIcons[status]}
          key={each}
        >
          {elsewhere === undefined ? (
            <Link
              params={{ clientId }}
              search={{ stage: each }}
              to={sectionTo.steps}
            >
              <StageName leaves={false} stage={each} status={status} />
            </Link>
          ) : (
            <Link
              params={{ clientId }}
              search={elsewhere.search}
              to={sectionTo[elsewhere.section]}
            >
              <StageName leaves stage={each} status={status} />
            </Link>
          )}
        </TabsLink>
      );
    })}
  </TabsNav>
);

// ---- The first conversation ---------------------------------------------

/**
 * What the first conversation brought, before the company's Grasp has
 * answered with each of the ten: where its transcript stands, as the
 * model counts it. What it brought stays in the company's own Grasp.
 */
const Brought = ({ view }: { view: OrgView }) => {
  const words: Record<OrgView["state"]["conversation"], string> = {
    none: "Once the transcript is in, Stephen reads it.",
    in: "Stephen has not read this transcript yet.",
    read: "Stephen has read it. What it brought stays in the company’s own Grasp.",
  };
  return (
    <Text color="muted" size="sm">
      {words[view.state.conversation]}
    </Text>
  );
};

/**
 * The first conversation with the sponsor: bringing it in, and each of
 * the ten things it brought or left open, with the sponsor's answers
 * (kickoff.tsx).
 */
const Conversation = ({
  view,
  clientId,
}: {
  view: OrgView;
  clientId: string;
}) => (
  <Part aria-labelledby="conversation">
    <SectionHeader
      description="Stephen reads it for the ten things he needs before his first interview."
      id="conversation"
      title="The first conversation"
      variant="group"
    />
    {/* Keyed by the company: another's drafts and answers never carry over. */}
    <Kickoff
      brought={<Brought view={view} />}
      clientId={clientId}
      key={clientId}
    />
  </Part>
);

// ---- The research -------------------------------------------------------

const sourceIcons: Record<ResearchSource, IconData> = {
  register: BuildingIcon,
  website: GlobeIcon,
  news: FileDocIcon,
  jobs: UsersIcon,
  regulator: ScaleIcon,
  reviews: MessageSquareIcon,
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

/** Whether a place was looked up, as a Badge. */
const LookedUp = ({ looked }: { looked: boolean }) =>
  looked ? (
    <Badge variant="success">Looked up</Badge>
  ) : (
    <Badge>Not looked up yet</Badge>
  );

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
  return (
    <Part aria-labelledby="research">
      <SectionHeader
        description={
          state.conversation === "read" || done
            ? "Public places only, and never its people."
            : "It starts once Stephen has read the first conversation: that tells him what to look for."
        }
        id="research"
        title="The research"
        variant="group"
      />
      <ItemGroup aria-labelledby="research" separated>
        {RESEARCH_SOURCES.map((source) => {
          const finding = org.research.find((each) => each.source === source);
          const disagrees = done && (finding?.conflict ?? "") !== "";
          return (
            <Item key={source}>
              <ItemMedia variant="icon">
                <Icon icon={sourceIcons[source]} />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{sourceWords[source].label}</ItemTitle>
                <ItemDescription>
                  {disagrees
                    ? `${sourceWords[source].gives} ${
                        state.passed.includes(source)
                          ? "It disagrees with the company’s own account: passed on to its admin."
                          : "It disagrees with the company’s own account. Its admin says which is right."
                      }`
                    : sourceWords[source].gives}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                {disagrees ? <Badge variant="warning">Disagrees</Badge> : null}
                <LookedUp looked={done && finding !== undefined} />
              </ItemActions>
            </Item>
          );
        })}
        <Item>
          <ItemMedia variant="icon">
            <Icon icon={FolderIcon} />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>What companies like this usually do</ItemTitle>
            <ItemDescription>
              The work such a company usually does, and where it usually stalls.
            </ItemDescription>
          </ItemContent>
          <ItemActions>
            <LookedUp looked={done && org.library !== ""} />
          </ItemActions>
        </Item>
      </ItemGroup>
      <Text color="muted" size="xs">
        Starting the research and passing a disagreement on to the company’s
        admin aren’t in the admin yet.
      </Text>
    </Part>
  );
};

// ---- What the company does itself ---------------------------------------

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

/** Something still to come, as a quiet Badge. */
const notYet = <Badge>Not yet</Badge>;

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
  let told: ReactNode = notYet;
  if (view.told) {
    told = `On ${dayDate(view, 0)}`;
  } else if (!mayInvite(state.agreed)) {
    told = <Badge variant="warning">Waits until everything is agreed</Badge>;
  }
  return (
    <Part aria-labelledby="company">
      <SectionHeader
        description="Grasp waits on each of these, in the company’s own onboarding."
        id="company"
        title="What the company does itself"
        variant="group"
      />
      <KeyValueList
        divided
        items={[
          {
            id: "admin",
            label: "Where its admin is",
            value:
              view.org.adminStep === undefined
                ? "Not started"
                : (adminStepWords[view.org.adminStep] ?? view.org.adminStep),
          },
          {
            id: "connected",
            label: "The sign-in is connected",
            value: connected
              ? `${people} people in ${counted(teams, "team", "teams")}`
              : notYet,
          },
          {
            id: "leads",
            label: "The team leads are named",
            value: named ? counted(teams, "team lead", "team leads") : notYet,
          },
          { id: "told", label: "The team is told", value: told },
        ]}
        orientation="horizontal"
      />
    </Part>
  );
};

// ---- Grasp opens --------------------------------------------------------

/** Where the rounding of a share of the dots may land just under a whole one. */
const dotSlack = 1e-9;

/** How many dots the share that is known is drawn in. */
const dotCount = 40;

/**
 * How much Grasp knows, in dots: dark for what is in, filling from the
 * start, with a mark at the share where Grasp opens. Dark up to the mark
 * is ready. `label` says it to a screen reader.
 */
const KnowledgeDots = ({
  knowledge,
  label,
}: {
  knowledge: Pick<OrgKnowledge, "percent" | "threshold">;
  label: string;
}) => {
  const filled = Math.floor((knowledge.percent / 100) * dotCount + dotSlack);
  const gate = Math.round((knowledge.threshold / 100) * dotCount);
  const mark = <span aria-hidden {...stylex.props(styles.gate)} />;
  return (
    <span {...stylex.props(styles.dots)}>
      <span {...stylex.props(visuallyHidden)}>{label}</span>
      {Array.from({ length: dotCount }, (_, at) => (
        <Fragment key={at}>
          {at === gate ? mark : null}
          <span
            aria-hidden
            {...stylex.props(styles.dot, at < filled && styles.filled)}
          />
        </Fragment>
      ))}
      {/* Where Grasp opens only once every dot is filled, the mark stands after the last. */}
      {gate >= dotCount ? mark : null}
    </span>
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

/** While the company has paused its interviews: core lets nobody open or save one. */
const pausedLine =
  "The company has paused its interviews: nobody can open or go on with one until it resumes them.";

/** Where Grasp's go stands, in a line under the share that is known. */
const GoLine = ({ view }: { view: OrgView }) => {
  const { knowledge, org } = view;
  const { threshold } = knowledge;
  if (knowledge.opened !== null) {
    return (
      <Alert live="off" variant="success">
        <AlertDescription>
          {`Open since ${dayDate(view, knowledge.opened)}. ${org.name} is in, and Stephen keeps learning from here.`}
        </AlertDescription>
      </Alert>
    );
  }
  if (knowledge.ready || view.closed) {
    return (
      <Alert live="off" variant="warning">
        <AlertDescription>
          {knowledge.ready
            ? `Enough is known: it is past ${threshold}%. ${org.name} comes in the moment Grasp gives its go.`
            : `The interviews are over and it stayed below ${threshold}%. Grasp can open it anyway, with what is not known shown as still open.`}
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Text color="muted" size="sm">
      {`Not enough is known yet. It can open once it is past ${threshold}%.`}
    </Text>
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
  const notKnown = view.works.filter(
    (work) =>
      work.state === "blocked" ||
      work.state === "mapping" ||
      work.state === "saturating"
  ).length;
  return (
    <>
      <Part aria-labelledby="opens">
        <SectionHeader
          description="What is not known by then shows to the company as still open."
          id="opens"
          title="Grasp opens"
          variant="group"
        />
        <div {...stylex.props(styles.part)}>
          <div {...stylex.props(styles.opens)}>
            <div {...stylex.props(styles.known)}>
              <Stat
                change={
                  knowledge.ready
                    ? `Past the ${knowledge.threshold}% it opens at`
                    : `Opens at ${knowledge.threshold}%`
                }
                label="Known"
                unstyled
                value={`${knowledge.percent}%`}
                variant={knowledge.ready ? "success" : "default"}
              />
              <KnowledgeDots
                knowledge={knowledge}
                label={`${knowledge.percent}% of what Grasp needs is known.`}
              />
            </div>
            <GateControls clientId={clientId} gate={gate} paused={paused} />
          </div>
          <div aria-live="polite">
            <GoLine view={view} />
          </div>
          {paused ? (
            <Alert live="off" variant="warning">
              <AlertDescription>{pausedLine}</AlertDescription>
            </Alert>
          ) : null}
        </div>
      </Part>
      {knowledge.sources.length > 0 ? (
        <Part aria-labelledby="fills">
          <SectionHeader
            description="The points each place gives, of the most it can."
            id="fills"
            title="How the brain fills"
            variant="group"
          />
          <ChartBarList
            aria-label="How the brain fills"
            config={{
              points: { label: "Points" },
              weight: { label: "Most it can give" },
            }}
            data={knowledge.sources.map((each) => ({
              place: knowledgeWords[each.source],
              points: each.points,
              weight: each.weight,
            }))}
            nameKey="place"
            sortOrder="none"
            summary={`${knowledge.percent}% of what Grasp needs is known, from ${counted(knowledge.sources.length, "place", "places")}.`}
          />
        </Part>
      ) : null}
      {view.told && notKnown > 0 ? (
        <ItemGroup aria-label="Workflows not known yet">
          <Item asChild variant="outline">
            <Link params={{ clientId }} to={sectionTo.workflows}>
              <ItemMedia variant="icon">
                <Icon icon={WorkflowIcon} />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>
                  {`${counted(notKnown, "workflow is", "workflows are")} not known yet`}
                </ItemTitle>
                <ItemDescription>
                  They show to the company as still open. See them all under
                  Workflows.
                </ItemDescription>
              </ItemContent>
            </Link>
          </Item>
        </ItemGroup>
      ) : null}
    </>
  );
};

// ---- The page -----------------------------------------------------------

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
    <div {...stylex.props(styles.parts)}>
      <StageTabs clientId={clientId} shown={shown} stage={stage} view={view} />
      {stage === "conversation" ? (
        <Conversation clientId={clientId} view={view} />
      ) : null}
      {stage === "research" ? <Research view={view} /> : null}
      {stage === "connected" ? <Company view={view} /> : null}
      {stage === "open" ? (
        <Opens clientId={clientId} gate={gate} paused={paused} view={view} />
      ) : null}
    </div>
  );
};
