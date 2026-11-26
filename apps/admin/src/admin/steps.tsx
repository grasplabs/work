import { VISION_FIELDS } from "@grasp-os/shared/admin/interviews";
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
import { Card, CardContent } from "@grasp-os/ui/components/card";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Progress } from "@grasp-os/ui/components/progress";
import { Stat } from "@grasp-os/ui/components/stat";
import { Text } from "@grasp-os/ui/components/text";
import {
  ArrowRightIcon,
  ArrowUpRightIcon,
  BuildingIcon,
  CheckIcon,
  CircleIcon,
  ClockIcon,
  FileDocIcon,
  FolderIcon,
  GlobeIcon,
  Icon,
  MessageSquareIcon,
  ScaleIcon,
  UsersIcon,
} from "@grasp-os/ui/lib/icons";
import type { IconData } from "@grasp-os/ui/lib/icons";
import { focusRingInset, visuallyHidden } from "@grasp-os/ui/lib/styles";
import {
  colors,
  font,
  media,
  radius,
  size,
  space,
} from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { GateControls } from "./commands.tsx";
import type { GateState } from "./commands.tsx";
import { opensElsewhere, stageShown, stagesIn } from "./flow-stages.ts";
import { Kickoff, visionWords } from "./kickoff.tsx";
import { Panel, PanelNote } from "./panel.tsx";
import { Attention, Done, KnowledgeDots } from "./parts.tsx";
import { sectionTo } from "./sections.ts";
import { formatDate, stageWords } from "./words.ts";

const hairline = `${size.hairline} solid ${colors.border}`;

const styles = stylex.create({
  mark: { display: "inline-flex", flexShrink: 0 },
  done: { color: colors.success },
  later: { color: colors.border },
  waits: { color: colors.warning },
  // The steps: one under another, and side by side from a desktop's width.
  steps: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  // A hairline between the steps: under each, and beside each from a desktop's width.
  step: {
    borderColor: colors.border,
    borderStyle: "solid",
    borderWidth: 0,
    borderBlockEndWidth: {
      default: size.hairline,
      ":last-child": 0,
      [media.lg]: 0,
    },
    borderInlineEndWidth: {
      default: 0,
      [media.lg]: { default: size.hairline, ":last-child": 0 },
    },
  },
  stepLink: {
    position: "relative",
    display: "flex",
    flexDirection: { default: "row", [media.lg]: "column" },
    alignItems: { default: "center", [media.lg]: "flex-start" },
    gap: { default: space["3"], [media.lg]: space["2"] },
    boxSizing: "border-box",
    width: "100%",
    height: "100%",
    paddingBlock: { default: space["3"], [media.lg]: space["4"] },
    paddingInline: { default: space["5"], [media.lg]: space["4"] },
    color: colors.foreground,
    fontFamily: font.sans,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    textAlign: "start",
    textDecoration: "none",
    outline: "none",
    backgroundColor: { default: null, ":hover": colors.muted },
  },
  // The open step, as a chosen tab is marked: its ground and a bar on its edge.
  open: {
    backgroundColor: colors.muted,
    "::after": {
      content: '""',
      position: "absolute",
      insetBlock: { default: 0, [media.lg]: "auto 0" },
      insetInlineStart: 0,
      insetInlineEnd: { default: "auto", [media.lg]: 0 },
      width: { default: "2px", [media.lg]: "auto" },
      height: { default: "auto", [media.lg]: "2px" },
      backgroundColor: colors.foreground,
    },
  },
  stepName: {
    minWidth: 0,
    flexGrow: { default: 1, [media.lg]: 0 },
    fontWeight: font.weightMedium,
  },
  leaves: {
    display: "inline-flex",
    flexShrink: 0,
    color: colors.mutedForeground,
    position: { default: "static", [media.lg]: "absolute" },
    insetBlockStart: { default: null, [media.lg]: space["4"] },
    insetInlineEnd: { default: null, [media.lg]: space["4"] },
  },
  // What the first conversation brought.
  brought: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: space["3"],
  },
  count: {
    display: "flex",
    width: "100%",
    flexDirection: "column",
    gap: space["2"],
  },
  figures: { fontVariantNumeric: "tabular-nums" },
  things: {
    display: "grid",
    width: "100%",
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      [media.sm]: "repeat(2, minmax(0, 1fr))",
    },
    gap: space["2"],
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  thing: {
    padding: space["3"],
    borderRadius: radius.lg,
    border: hairline,
  },
  missing: {
    display: "flex",
    flexDirection: "column",
    gap: space["1"],
    padding: space["3"],
    borderRadius: radius.lg,
    borderWidth: size.hairline,
    borderStyle: "dashed",
    borderColor: colors.warning,
  },
  missingWords: { color: colors.warning },
  // The research: each place a cell, a hairline between them.
  places: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      [media.md]: "repeat(2, minmax(0, 1fr))",
      [media.xl]: "repeat(3, minmax(0, 1fr))",
    },
    gap: size.hairline,
    margin: 0,
    padding: 0,
    listStyle: "none",
    backgroundColor: colors.border,
  },
  place: {
    display: "flex",
    flexDirection: "column",
    gap: space["2"],
    padding: space["5"],
    backgroundColor: colors.card,
  },
  library: { gridColumn: "1 / -1" },
  placeName: {
    display: "flex",
    alignItems: "center",
    gap: space["2"],
    fontWeight: font.weightMedium,
  },
  quiet: {
    display: "inline-flex",
    flexShrink: 0,
    color: colors.mutedForeground,
  },
  // Grasp opens: the figure and the go side by side, then where its go stands.
  opens: { display: "flex", flexDirection: "column", gap: space["5"] },
  figureRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-end",
    justifyContent: "space-between",
    columnGap: space["8"],
    rowGap: space["4"],
  },
  figure: {
    display: "flex",
    minWidth: 0,
    flexDirection: "column",
    gap: space["3"],
  },
  fills: { margin: 0, padding: 0, listStyle: "none" },
  fill: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      [media.sm]: "minmax(0, 1fr) minmax(0, 14rem) 4.5rem",
    },
    alignItems: "center",
    columnGap: space["6"],
    rowGap: space["1"],
    paddingBlock: space["2"],
    paddingInline: space["5"],
    borderBlockStart: hairline,
  },
  points: {
    color: colors.mutedForeground,
    fontVariantNumeric: "tabular-nums",
    textAlign: { default: "start", [media.sm]: "end" },
  },
  more: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space["3"],
  },
});

/** How many columns the steps take when wide, by how many the flow has: a style each. */
const stageColumns = stylex.create({
  c1: {
    gridTemplateColumns: {
      default: null,
      [media.lg]: "repeat(1, minmax(0, 1fr))",
    },
  },
  c2: {
    gridTemplateColumns: {
      default: null,
      [media.lg]: "repeat(2, minmax(0, 1fr))",
    },
  },
  c3: {
    gridTemplateColumns: {
      default: null,
      [media.lg]: "repeat(3, minmax(0, 1fr))",
    },
  },
  c4: {
    gridTemplateColumns: {
      default: null,
      [media.lg]: "repeat(4, minmax(0, 1fr))",
    },
  },
  c5: {
    gridTemplateColumns: {
      default: null,
      [media.lg]: "repeat(5, minmax(0, 1fr))",
    },
  },
  c6: {
    gridTemplateColumns: {
      default: null,
      [media.lg]: "repeat(6, minmax(0, 1fr))",
    },
  },
  c7: {
    gridTemplateColumns: {
      default: null,
      [media.lg]: "repeat(7, minmax(0, 1fr))",
    },
  },
});
const columnsOf: readonly (stylex.StyleXStyles | null)[] = [
  null,
  stageColumns.c1,
  stageColumns.c2,
  stageColumns.c3,
  stageColumns.c4,
  stageColumns.c5,
  stageColumns.c6,
  stageColumns.c7,
];

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

/** Each step's mark, by where it stands. */
const stageMarks: Record<
  StageStatus,
  { icon: IconData; tone?: stylex.StyleXStyles }
> = {
  done: { icon: CheckIcon, tone: styles.done },
  now: { icon: CircleIcon },
  waits: { icon: ClockIcon, tone: styles.waits },
  later: { icon: CircleIcon, tone: styles.later },
};

const StageMark = ({ status }: { status: StageStatus }) => (
  <span aria-hidden {...stylex.props(styles.mark, stageMarks[status].tone)}>
    <Icon icon={stageMarks[status].icon} />
  </span>
);

/**
 * Where something the prototype does here would be: not in the admin
 * yet, for it writes to the company's Grasp.
 */
const NotHere = ({ children }: { children: ReactNode }) => (
  <CardContent>
    <Text color="muted" size="xs">
      {children}
    </Text>
  </CardContent>
);

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
    <span {...stylex.props(styles.stepName)}>
      {stageWords[stage]}
      <span {...stylex.props(visuallyHidden)}>: {statusWords[status]}</span>
    </span>
    {/* In the same corner of every step that leads elsewhere, so the names line up whether or not one does. */}
    {leaves ? (
      <span aria-hidden {...stylex.props(styles.leaves)}>
        <Icon icon={ArrowUpRightIcon} />
      </span>
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
      params={{ clientId }}
      search={search}
      to={sectionTo[section]}
      {...stylex.props(styles.stepLink, focusRingInset)}
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
  <Card asChild padding="none">
    <nav aria-label="The steps of this onboarding">
      <ol {...stylex.props(styles.steps, columnsOf[shown.length])}>
        {shown.map((each) => {
          const open = each === stage;
          const status = view.stages[each];
          return (
            <li key={each} {...stylex.props(styles.step)}>
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
                  params={{ clientId }}
                  search={{ stage: each }}
                  to={sectionTo.steps}
                  {...stylex.props(
                    styles.stepLink,
                    focusRingInset,
                    open && styles.open
                  )}
                >
                  <StageName stage={each} status={status} />
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  </Card>
);

/**
 * What the first conversation brought, as the model counts it: which of
 * the ten things are in, by name, never what was said about them.
 */
const Brought = ({ view }: { view: OrgView }) => {
  const { vision } = view;
  if (vision === null) {
    return (
      <Text color="muted" size="sm">
        Stephen has read it. What it brought stays in the company’s own Grasp.
      </Text>
    );
  }
  const inNow = VISION_FIELDS.filter((field) => vision.fields[field]).length;
  return (
    <>
      <div {...stylex.props(styles.count)}>
        <span {...stylex.props(styles.figures)}>
          <Text color="muted" size="sm">
            {inNow} of {VISION_FIELDS.length} in
          </Text>
        </span>
        <Progress
          aria-label="What it brought"
          value={(inNow / VISION_FIELDS.length) * 100}
        />
      </div>
      <ul {...stylex.props(styles.things)}>
        {VISION_FIELDS.map((field) =>
          vision.fields[field] ? (
            <li key={field} {...stylex.props(styles.thing)}>
              <Done>{visionWords[field]}</Done>
            </li>
          ) : (
            <li key={field} {...stylex.props(styles.missing)}>
              <Text size="sm" weight="medium">
                {visionWords[field]}
              </Text>
              <span {...stylex.props(styles.missingWords)}>
                <Text size="sm">Missing: ask the sponsor</Text>
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
    <Panel title="The first conversation">
      <CardContent>
        <div {...stylex.props(styles.brought)}>
          <Text size="sm" weight="medium">
            What it brought
          </Text>
          {conversation === "read" ? (
            <Brought view={view} />
          ) : (
            <Text color="muted" size="sm">
              {conversation === "in"
                ? "Stephen has not read this transcript yet."
                : "Once the transcript is in, Stephen reads it for the ten things he needs before his first interview."}
            </Text>
          )}
        </div>
      </CardContent>
      {/* Keyed by the company: another's drafts and answers never carry over. */}
      <Kickoff clientId={clientId} key={clientId} />
    </Panel>
  );
};

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
    <Text color="muted" size="sm">
      Not looked up yet
    </Text>
  );
  return (
    <Panel title="The research">
      {state.conversation === "read" || done ? null : (
        <PanelNote>
          It starts once Stephen has read the first conversation: that tells him
          what to look for.
        </PanelNote>
      )}
      <CardContent flush>
        <ul {...stylex.props(styles.places)}>
          {RESEARCH_SOURCES.map((source) => {
            const finding = org.research.find((each) => each.source === source);
            const disagrees = (finding?.conflict ?? "") !== "";
            return (
              <li key={source} {...stylex.props(styles.place)}>
                <span {...stylex.props(styles.placeName)}>
                  <span aria-hidden {...stylex.props(styles.quiet)}>
                    <Icon icon={sourceIcons[source]} />
                  </span>
                  <Text size="sm" weight="medium">
                    {sourceWords[source].label}
                  </Text>
                </span>
                <Text color="muted" size="xs">
                  {sourceWords[source].gives}
                </Text>
                {done && finding !== undefined ? (
                  <Done>Looked up</Done>
                ) : (
                  notYet
                )}
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
          <li {...stylex.props(styles.place, styles.library)}>
            <span {...stylex.props(styles.placeName)}>
              <span aria-hidden {...stylex.props(styles.quiet)}>
                <Icon icon={FolderIcon} />
              </span>
              <Text size="sm" weight="medium">
                What companies like this usually do
              </Text>
            </span>
            <Text color="muted" size="xs">
              The work such a company usually does, and where it usually stalls.
            </Text>
            {done && org.library !== "" ? <Done>Looked up</Done> : notYet}
          </li>
        </ul>
      </CardContent>
      <NotHere>
        Starting the research and passing a disagreement on to the company’s
        admin aren’t in the admin yet.
      </NotHere>
    </Panel>
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
  const waits = (
    <Text color="muted" size="sm">
      Not yet
    </Text>
  );
  let told = waits;
  if (view.told) {
    told = <Done>On {dayDate(view, 0)}</Done>;
  } else if (!mayInvite(state.agreed)) {
    told = (
      <span {...stylex.props(styles.waits)}>
        <Text size="sm">Waits until everything is agreed</Text>
      </span>
    );
  }
  const rows: { label: string; value: ReactNode }[] = [
    {
      label: "Where its admin is",
      value:
        view.org.adminStep === undefined ? (
          <Text color="muted" size="sm">
            Not started
          </Text>
        ) : (
          <Text size="sm">
            {adminStepWords[view.org.adminStep] ?? view.org.adminStep}
          </Text>
        ),
    },
    {
      label: "The sign-in is connected",
      value: connected ? (
        <Done>
          {people} people in {counted(teams, "team", "teams")}
        </Done>
      ) : (
        waits
      ),
    },
    {
      label: "The team leads are named",
      value: named ? (
        <Done>{counted(teams, "team lead", "team leads")}</Done>
      ) : (
        waits
      ),
    },
    { label: "The team is told", value: told },
  ];
  return (
    <Panel title="What the company does itself">
      <CardContent flush>
        <ItemGroup separated>
          {rows.map((row) => (
            <Item key={row.label} size="sm">
              <ItemContent>
                <ItemTitle>{row.label}</ItemTitle>
              </ItemContent>
              <ItemActions>{row.value}</ItemActions>
            </Item>
          ))}
        </ItemGroup>
      </CardContent>
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
    <Text color="muted" size="sm">
      Not enough is known yet. It can open once it is past {threshold}%.
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
  const known = `${knowledge.percent}% of what Grasp needs is known.`;
  const notKnown = view.works.filter(
    (work) =>
      work.state === "blocked" ||
      work.state === "mapping" ||
      work.state === "saturating"
  ).length;
  return (
    <Panel
      description="What is not known by then shows to the company as still open."
      title="Grasp opens"
    >
      <CardContent>
        <div {...stylex.props(styles.opens)}>
          <div {...stylex.props(styles.figureRow)}>
            <div {...stylex.props(styles.figure)}>
              <Stat label="Known" unstyled value={`${knowledge.percent}%`} />
              <KnowledgeDots count={40} knowledge={knowledge} label={known} />
            </div>
            <GateControls clientId={clientId} gate={gate} paused={paused} />
          </div>
          <div aria-live="polite">{goLine(view)}</div>
          {paused ? <Attention>{pausedLine}</Attention> : null}
        </div>
      </CardContent>
      {knowledge.sources.length > 0 ? (
        <CardContent flush>
          <ul aria-label="How the brain fills" {...stylex.props(styles.fills)}>
            {knowledge.sources.map((each) => (
              <li key={each.source} {...stylex.props(styles.fill)}>
                <Text size="sm">{knowledgeWords[each.source]}</Text>
                <Progress
                  aria-label={knowledgeWords[each.source]}
                  value={each.known * 100}
                />
                <span {...stylex.props(styles.points)}>
                  <Text color="muted" size="sm">
                    {each.points} of {each.weight}
                  </Text>
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      ) : null}
      {view.told && notKnown > 0 ? (
        <CardContent>
          <div {...stylex.props(styles.more)}>
            <Text color="muted" size="sm">
              {counted(notKnown, "workflow is", "workflows are")} not known yet.
            </Text>
            <Button asChild size="sm" variant="outline">
              <Link params={{ clientId }} to={sectionTo.workflows}>
                All workflows
                <Icon icon={ArrowRightIcon} />
              </Link>
            </Button>
          </div>
        </CardContent>
      ) : null}
    </Panel>
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
