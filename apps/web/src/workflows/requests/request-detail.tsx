import { failureText } from "@grasp-os/shared/errors";
import { elsewhere, growth } from "@grasp-os/shared/stephen-requests";
import type {
  Need,
  RequestRange,
  RequestsPage,
  RequestsReport,
} from "@grasp-os/shared/stephen-requests";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import type { CoreConnection } from "../../core-connection.ts";
import { formatIsoDayMonth, formatMonth, formatNumber } from "../../format.ts";
import { LoadingLines } from "../../frame/page-states.tsx";
import { Alert } from "../../grasp/alert/index.ts";
import { Button } from "../../grasp/button/index.ts";
import {
  Chart,
  ChartAxis,
  ChartBar,
  ChartTooltip,
} from "../../grasp/chart/index.ts";
import type { ChartConfig } from "../../grasp/chart/index.ts";
import {
  ArrowLeft,
  Chat,
  People,
  Person,
  Question,
} from "../../grasp/icons/index.ts";
import type { IconData } from "../../grasp/icons/index.ts";
import { InspectorPanel } from "../../grasp/inspector-panel/index.ts";
import type {
  InspectorRow,
  InspectorSection,
} from "../../grasp/inspector-panel/index.ts";
import { grasp } from "../../grasp/tokens/tokens.stylex.ts";
import { useCore } from "../../use-core.ts";
import {
  NeedActions,
  NeedWhy,
  needIcon,
  useAskGrasp,
  useNeedProposal,
} from "./request-needs.tsx";
import {
  Growth,
  placeIcon,
  placeName,
  toolIcon,
  useRequestNames,
} from "./request-parts.tsx";

// The panel every row of the table opens, as the prototype's
// `request-detail.tsx`, beside the table (in a Sheet on a narrow page):
// its requests over the span, then what it is made of, each part opening
// its own panel in turn (a team's topics, a topic's questions and teams, a
// question's teams), and at its foot the one way into the rest of Grasp.
// What needs someone shows why, where it stands and Grasp's proposal,
// with "Do it". A person's panel has counts and places only. Each panel is
// core's report narrowed to what it is about, folded as the page is: one
// that would point at fewer than five people says so and shows nothing.

/** What a panel is about, with the name the row that opened it gave it. */
export type RequestSubject =
  | {
      kind: "team" | "topic" | "person" | "question";
      id: string;
      name: string;
    }
  | { kind: "need"; need: Need };

/** The report narrowed to a subject, as core folds it. */
type Narrowed =
  | { state: "loading" }
  | { state: "ready"; page: RequestsPage }
  | { state: "failed"; reason: string };

/** What a panel narrows the report to. */
interface Narrowing {
  place: string | null;
  team: string | null;
  topic: string | null;
  person: string | null;
  question: string | null;
}

const styles = stylex.create({
  // A section's card holding a chart or words, in the rows' inset.
  inset: {
    paddingBlock: grasp.space3,
    paddingInline: grasp.inspectorInset,
  },
  foot: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space2,
    paddingBlock: grasp.space4,
    paddingInline: grasp.inspectorInset,
  },
  buttons: { display: "flex", flexWrap: "wrap", gap: grasp.space2 },
});

/** What one subject narrows to. */
const narrowingOf = (subject: RequestSubject): Partial<Narrowing> => {
  if (subject.kind !== "need") {
    return { [subject.kind]: subject.id };
  }
  const { need } = subject;
  return need.teamId === null
    ? { question: need.question ?? "" }
    : { team: need.teamId };
};

/**
 * What the panel on top of `trail` narrows to: the page's place and team,
 * then what each panel opened on the way to it narrowed to, so it explains
 * the row that was opened. Needs you follows no filter of the page, so a
 * trail from it doesn't either; and a person's panel is never narrowed to
 * what they asked.
 */
const narrowingFor = (
  trail: readonly RequestSubject[],
  page: Pick<Narrowing, "place" | "team">
): Narrowing => {
  const fromNeeds = trail[0]?.kind === "need";
  const narrowing: Narrowing = {
    place: fromNeeds ? null : page.place,
    team: fromNeeds ? null : page.team,
    topic: null,
    person: null,
    question: null,
  };
  for (const subject of trail) {
    Object.assign(narrowing, narrowingOf(subject));
  }
  return narrowing.person === null
    ? narrowing
    : { ...narrowing, topic: null, question: null };
};

/** Reads the report narrowed so. Outside components, as the React Compiler can't compile `try`. */
const readNarrowed = async (
  core: CoreConnection,
  range: RequestRange,
  narrowing: Narrowing
): Promise<Narrowed> => {
  try {
    const page = await core.withSession(
      async (session) =>
        await session.stephenRequests.report({ range, ...narrowing })
    );
    return { state: "ready", page };
  } catch (error) {
    return { state: "failed", reason: failureText(error) };
  }
};

const useNarrowed = (
  range: RequestRange,
  { place, team, topic, person, question }: Narrowing
): Narrowed => {
  const core = useCore();
  const [narrowed, setNarrowed] = useState<Narrowed>({ state: "loading" });
  useEffect(() => {
    let current = true;
    const read = async (): Promise<void> => {
      setNarrowed({ state: "loading" });
      const got = await readNarrowed(core, range, {
        place,
        team,
        topic,
        person,
        question,
      });
      if (current) {
        setNarrowed(got);
      }
    };
    void read();
    return () => {
      current = false;
    };
  }, [core, range, place, team, topic, person, question]);
  return narrowed;
};

/** Its requests over the span, a bar a day or a month, as small as a panel holds them. */
const Over = ({
  report,
  asked,
  summary,
}: {
  report: RequestsReport;
  asked: boolean;
  summary: string;
}) => {
  const { t } = useLingui();
  const config: ChartConfig = {
    count: { label: asked ? t`Asked` : t`Billed` },
  };
  const format = (at: string | number) =>
    report.by === "day"
      ? formatIsoDayMonth(String(at))
      : formatMonth(String(at));
  return (
    <div {...stylex.props(styles.inset)}>
      <Chart
        aria-label={t`Requests over time`}
        config={config}
        data={report.bars.map((bar) => ({
          at: bar.at,
          // Billed by place, which a person's panel keeps too (it has
          // no kinds: counts only).
          count:
            Object.values(bar.places).reduce((sum, each) => sum + each, 0) +
            (asked ? bar.notBilled : 0),
        }))}
        height={112}
        summary={summary}
        xKey="at"
      >
        <ChartAxis format={format} side="x" />
        <ChartBar series="count" />
        <ChartTooltip format={formatNumber} />
      </Chart>
    </div>
  );
};

type Names = ReturnType<typeof useRequestNames>;

/** What a topic, team or question row opens, if anything: nothing for a folded group. */
type Opener = (
  subject: Extract<RequestSubject, { id: string }>
) => (() => void) | undefined;

/** A section of rows, or none when it has no row: a panel never offers to add to what it counts. */
const rowsSection = (
  id: string,
  label: string,
  rows: InspectorRow[]
): InspectorSection[] => (rows.length === 0 ? [] : [{ id, label, rows }]);

/** A row of a part: its name, its count, and what it opens. */
const countRow = (
  id: string,
  name: string,
  count: number,
  onPress?: () => void,
  icon?: IconData
): InspectorRow => ({
  id,
  name,
  detail: formatNumber(count),
  ...(onPress === undefined ? {} : { onPress }),
  ...(icon === undefined ? {} : { icon }),
});

/** Where they asked: from the bars, which fold no small group away, as a person's panel is one person. */
const byPlaceOf = (report: RequestsReport): [string, number][] => {
  const byPlace = new Map<string, number>();
  for (const bar of report.bars) {
    for (const [place, count] of Object.entries(bar.places)) {
      byPlace.set(place, (byPlace.get(place) ?? 0) + count);
    }
  }
  return [...byPlace].toSorted((a, b) => b[1] - a[1]);
};

/** The teams it is asked in, most first by the count shown, the teams too small to name last. */
const teamsOf = (report: RequestsReport, asked: boolean) => {
  const countOf = (each: RequestsReport["byTeam"][number]): number =>
    asked ? each.requests : each.billed;
  return report.byTeam
    .map((each) => ({ key: each.key, count: countOf(each) }))
    .toSorted(
      (a, b) =>
        Number(a.key === elsewhere) - Number(b.key === elsewhere) ||
        b.count - a.count
    );
};

/** The panel's sections of what the subject is made of. */
const useBodySections = (
  subject: RequestSubject,
  page: RequestsPage,
  names: Names,
  opener: Opener
): InspectorSection[] => {
  const { t } = useLingui();
  const { report, before } = page;
  const tools = rowsSection(
    "tools",
    t`Done with`,
    report.byTool
      .slice(0, 5)
      .map((each) =>
        countRow(
          each.key,
          names.tool(each.key),
          each.calls,
          undefined,
          toolIcon(each.key)
        )
      )
  );
  const places = rowsSection(
    "places",
    t({ message: "Where", context: "the places people asked Stephen in" }),
    byPlaceOf(report).map(([place, count]) =>
      countRow(place, placeName(place), count, undefined, placeIcon(place))
    )
  );
  const topics = rowsSection(
    "topics",
    t`What they ask`,
    report.byTopic.map((each) => {
      const name = names.topic(each.key);
      return countRow(
        each.key,
        name,
        each.billed,
        opener({ kind: "topic", id: each.key, name })
      );
    })
  );
  const teams = (asked: boolean) =>
    rowsSection(
      "teams",
      t({ message: "Teams", context: "Stephen's requests by team" }),
      teamsOf(report, asked).map((each) => {
        const name = names.team(each.key);
        return countRow(
          each.key,
          name,
          each.count,
          opener({ kind: "team", id: each.key, name })
        );
      })
    );
  const questions = (
    rows: { question: string; people: number }[],
    earlier: RequestsPage["before"],
    id: string,
    title: string
  ) =>
    rowsSection(
      id,
      title,
      rows.map((each) => {
        const name = names.question(each.question);
        const grew =
          earlier === null
            ? null
            : growth(
                each.people,
                earlier.questions.find((was) => was.question === each.question)
                  ?.people ?? 0
              );
        const onPress = opener({ kind: "question", id: each.question, name });
        return {
          id: each.question,
          name,
          detail: (
            <>
              <Growth grew={grew} /> {formatNumber(each.people)}
            </>
          ),
          ...(onPress === undefined ? {} : { onPress }),
        };
      })
    );
  const aboutTeam =
    subject.kind === "team" ||
    (subject.kind === "need" && subject.need.teamId !== null);
  if (subject.kind === "person") {
    return places;
  }
  if (aboutTeam) {
    return [
      ...topics,
      ...questions(report.notPossible, null, "notPossible", t`He can't do yet`),
      ...places,
    ];
  }
  if (subject.kind === "topic") {
    return [
      ...questions(report.questions, before, "questions", t`What many ask`),
      ...tools,
      ...teams(false),
    ];
  }
  return [...tools, ...teams(true)];
};

/** The panel's title, as the row that opened it named its subject. */
const titleOf = (subject: RequestSubject): string =>
  subject.kind === "need" ? subject.need.label : subject.name;

/** The mark at the panel's head: what kind of thing it is about. */
const iconOf = (subject: RequestSubject): IconData => {
  const icons = {
    team: People,
    topic: Chat,
    person: Person,
    question: Question,
  } as const;
  return subject.kind === "need" ? needIcon(subject.need) : icons[subject.kind];
};

/** What the panel says under its title, from its report. */
const useDescription = (
  subject: RequestSubject,
  page: RequestsPage
): string => {
  const { t } = useLingui();
  const { report } = page;
  const asked = subject.kind === "question" || subject.kind === "need";
  const { people } = report.total;
  const times = report.total.requests;
  const { billed } = report.total;
  if (page.tooFew) {
    return t`Fewer than five people: not shown on its own.`;
  }
  if (subject.kind === "person") {
    return t`${plural(billed, { one: "# request", other: "# requests" })}`;
  }
  return asked
    ? t`${plural(times, { one: "Asked once", other: "Asked # times" })} · ${plural(people, { one: "# person", other: "# people" })}`
    : t`${plural(billed, { one: "# request", other: "# requests" })} · ${plural(people, { one: "# person", other: "# people" })}`;
};

/** The panel's sections, its report read. */
const usePanelSections = (
  subject: RequestSubject,
  page: RequestsPage,
  description: string,
  onOpen: (subject: RequestSubject) => void
): InspectorSection[] => {
  const { t } = useLingui();
  const names = useRequestNames(page);
  const need = subject.kind === "need" ? subject.need : null;
  const proposal = useNeedProposal(need);
  const opener: Opener = (next) =>
    next.id === elsewhere
      ? undefined
      : () => {
          onOpen(next);
        };
  const body = useBodySections(subject, page, names, opener);
  const { report } = page;
  const asked = subject.kind === "question" || need !== null;
  const why: InspectorSection[] =
    need === null
      ? []
      : [{ id: "why", label: t`Why`, content: <NeedWhy need={need} /> }];
  const proposes: InspectorSection[] =
    need === null || proposal === null
      ? []
      : [{ id: "proposal", label: t`Grasp proposes`, text: proposal }];
  const over: InspectorSection[] =
    report.total.requests > 0
      ? [
          {
            id: "over",
            label: t`Requests over time`,
            content: (
              <Over asked={asked} report={report} summary={description} />
            ),
          },
        ]
      : [];
  return [...why, ...proposes, ...over, ...(page.tooFew ? [] : body)];
};

/** The panel's foot: what can be done about its subject. A person's panel has none. */
const Foot = ({
  subject,
  canManage,
  onOnlyTeam,
  onChanged,
}: {
  subject: RequestSubject;
  canManage: boolean;
  onOnlyTeam: ((teamId: string) => void) | null;
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const asking = useAskGrasp();
  const need = subject.kind === "need" ? subject.need : null;
  const title = titleOf(subject);
  const teamOnly =
    subject.kind === "team" && onOnlyTeam !== null ? subject.id : null;
  const makesWorkflow = subject.kind === "topic" || subject.kind === "question";
  if (need === null && teamOnly === null && !makesWorkflow) {
    return null;
  }
  return (
    <div {...stylex.props(styles.foot)}>
      {need === null ? null : (
        <NeedActions canManage={canManage} need={need} onChanged={onChanged} />
      )}
      <div {...stylex.props(styles.buttons)}>
        {teamOnly === null ? null : (
          <Button
            onClick={() => {
              onOnlyTeam?.(teamOnly);
            }}
            size="sm"
            variant="quiet"
          >
            {t`Show the page for ${title}`}
          </Button>
        )}
        {makesWorkflow ? (
          <Button
            disabled={asking.busy}
            onClick={() => {
              void asking.ask(
                title,
                t`Many people ask Stephen about “${title}”. Which workflow would do it for them?`
              );
            }}
            size="sm"
            variant="quiet"
          >
            {t`Make a workflow of it`}
          </Button>
        ) : null}
      </div>
      {asking.failure === undefined ? null : (
        <Alert tone="danger">{asking.failure}</Alert>
      )}
    </div>
  );
};

/** The props every state of a panel takes. */
interface PanelProps {
  subject: RequestSubject;
  canBack: boolean;
  canManage: boolean;
  /** On the page beside the table, or in a Sheet. */
  framed: boolean;
  onBack: () => void;
  onClose: () => void;
  onOpen: (subject: RequestSubject) => void;
  onOnlyTeam: ((teamId: string) => void) | null;
  onChanged: () => Promise<void>;
}

/** The panel's head and foot round `sections`, whatever state its report is in. */
const Frame = ({
  props,
  description,
  sections,
  loose,
}: {
  props: PanelProps;
  description?: string;
  sections: InspectorSection[];
  /** Under the sections, before the foot: why the report couldn't be read, or lines while it is. */
  loose?: ReactNode;
}) => {
  const { t } = useLingui();
  const title = titleOf(props.subject);
  return (
    <InspectorPanel
      actions={
        props.canBack ? (
          <Button
            icon={ArrowLeft}
            onClick={props.onBack}
            size="sm"
            variant="ghost"
          >
            {t`Back`}
          </Button>
        ) : undefined
      }
      aria-label={title}
      {...(description === undefined ? {} : { description })}
      foot={
        <>
          {loose}
          <Foot
            canManage={props.canManage}
            onChanged={props.onChanged}
            onOnlyTeam={props.onOnlyTeam}
            subject={props.subject}
          />
        </>
      }
      framed={props.framed}
      icon={iconOf(props.subject)}
      onClose={props.onClose}
      sections={sections}
      title={title}
      words={{ close: t`Close` }}
    />
  );
};

/** One panel, its report read. */
const Ready = ({ props, page }: { props: PanelProps; page: RequestsPage }) => {
  const description = useDescription(props.subject, page);
  const sections = usePanelSections(
    props.subject,
    page,
    description,
    props.onOpen
  );
  return <Frame description={description} props={props} sections={sections} />;
};

/** The panel, while it reads what it is about. */
const Loaded = (
  props: PanelProps & { narrowing: Narrowing; range: RequestRange }
) => {
  const narrowed = useNarrowed(props.range, props.narrowing);
  if (narrowed.state === "ready") {
    return <Ready page={narrowed.page} props={props} />;
  }
  return (
    <Frame
      loose={
        <div {...stylex.props(styles.inset)}>
          {narrowed.state === "loading" ? (
            <LoadingLines />
          ) : (
            <Alert tone="danger">{narrowed.reason}</Alert>
          )}
        </div>
      }
      props={props}
      sections={[]}
    />
  );
};

/** The panel of the last subject opened, with Back to the one before. */
export const RequestDetail = ({
  trail,
  range,
  place,
  team,
  canManage,
  framed,
  onTrail,
  onOnlyTeam,
  onChanged,
}: {
  /** The subjects opened from one another, the last on top; not empty. */
  trail: RequestSubject[];
  range: RequestRange;
  /** The page's filters, which a panel opened from the page keeps. */
  place: string | null;
  team: string | null;
  canManage: boolean;
  /** Beside the table, or in a Sheet on a narrow page. */
  framed: boolean;
  onTrail: (trail: RequestSubject[]) => void;
  onOnlyTeam: ((teamId: string) => void) | null;
  onChanged: () => Promise<void>;
}) => {
  const subject = trail.at(-1);
  const narrowing = narrowingFor(trail, { place, team });
  if (subject === undefined) {
    return null;
  }
  return (
    <Loaded
      canBack={trail.length > 1}
      canManage={canManage}
      framed={framed}
      key={JSON.stringify(narrowing)}
      narrowing={narrowing}
      onBack={() => {
        onTrail(trail.slice(0, -1));
      }}
      onChanged={onChanged}
      onClose={() => {
        onTrail([]);
      }}
      onOnlyTeam={onOnlyTeam}
      onOpen={(next) => {
        onTrail([...trail, next]);
      }}
      range={range}
      subject={subject}
    />
  );
};
