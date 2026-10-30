import { failureText } from "@grasp-os/shared/errors";
import { elsewhere, growth } from "@grasp-os/shared/stephen-requests";
import type {
  Need,
  RequestRange,
  RequestsPage,
  RequestsReport,
} from "@grasp-os/shared/stephen-requests";
import { Button } from "@grasp-os/ui/components/button";
import {
  Bar,
  BarChart,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  XAxis,
  chartColor,
} from "@grasp-os/ui/components/chart";
import type { ChartConfig } from "@grasp-os/ui/components/chart";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@grasp-os/ui/components/sheet";
import { cn } from "@grasp-os/ui/lib/utils";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { ArrowLeftIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import type { CoreConnection } from "../../core-connection.ts";
import { ErrorText } from "../../error-text.tsx";
import { formatDay, formatMonth, formatNumber } from "../../format.ts";
import { LoadingLines } from "../../frame/page-states.tsx";
import { useCore } from "../../use-core.ts";
import { NeedActions, NeedPart, useAskGrasp } from "./request-needs.tsx";
import {
  Growth,
  OpenRow,
  PlaceLogo,
  ToolMark,
  placeName,
  useRequestNames,
} from "./request-parts.tsx";

// The panel every row of the table opens, as the prototype's
// `request-detail.tsx`: its requests over the span, then what it is made
// of, each part opening its own panel in turn (a team's topics, a topic's
// questions and teams, a question's teams), and at its foot the one way
// into the rest of Grasp. What needs someone shows why, where it stands
// and Grasp's proposal, with "Do it". A person's panel has counts and
// places only. Each panel is core's report narrowed to what it is about,
// folded as the page is: one that would point at fewer than five people
// says so and shows nothing.

/** What a panel is about. */
export type RequestSubject =
  | { kind: "team" | "topic" | "person" | "question"; id: string }
  | { kind: "need"; need: Need };

/** A row: what it is (`nameCell`), its count, the chevron. */
const row = "flex items-center gap-x-4 px-4 py-2.5";
const nameCell = "min-w-0 flex-1";

/** The report narrowed to a subject, as core folds it. */
type Narrowed =
  | { state: "loading" }
  | { state: "ready"; page: RequestsPage }
  | { state: "failed"; reason: string };

/** What a panel narrows the report to: a filter's name, and what it is narrowed to. */
type Narrowing = ["team" | "topic" | "person" | "question", string];

const narrowingOf = (subject: RequestSubject): Narrowing => {
  if (subject.kind !== "need") {
    return [subject.kind, subject.id];
  }
  const { need } = subject;
  return need.teamId === null
    ? ["question", need.question ?? ""]
    : ["team", need.teamId];
};

/** Reads the report narrowed so. Outside components, as the React Compiler can't compile `try`. */
const readNarrowed = async (
  core: CoreConnection,
  range: RequestRange,
  place: string | null,
  [by, id]: Narrowing
): Promise<Narrowed> => {
  try {
    const page = await core.withSession(
      async (session) =>
        await session.stephenRequests.report({ range, place, [by]: id })
    );
    return { state: "ready", page };
  } catch (error) {
    return { state: "failed", reason: failureText(error) };
  }
};

const useNarrowed = (
  range: RequestRange,
  place: string | null,
  by: Narrowing[0],
  id: string
): Narrowed => {
  const core = useCore();
  const [narrowed, setNarrowed] = useState<Narrowed>({ state: "loading" });
  useEffect(() => {
    let current = true;
    const read = async (): Promise<void> => {
      setNarrowed({ state: "loading" });
      const got = await readNarrowed(core, range, place, [by, id]);
      if (current) {
        setNarrowed(got);
      }
    };
    void read();
    return () => {
      current = false;
    };
  }, [core, range, place, by, id]);
  return narrowed;
};

/** A list in the panel, under its name. */
const Section = ({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) => (
  <section className="flex flex-col">
    <h3 className="text-muted-foreground px-4 pb-2 text-xs">{title}</h3>
    <ul className="border-b">{children}</ul>
  </section>
);

const Count = ({ value }: { value: number }) => (
  <span className="text-muted-foreground text-right tabular-nums">
    {formatNumber(value)}
  </span>
);

/** Its requests over the span, a bar a day or a month, as small as a panel holds them. */
const Over = ({
  report,
  asked,
}: {
  report: RequestsReport;
  asked: boolean;
}) => {
  const { t } = useLingui();
  const config: ChartConfig = {
    count: { label: asked ? t`Asked` : t`Billed`, color: "chart-1" },
  };
  const format = (at: string) =>
    report.by === "day" ? formatDay(at) : formatMonth(at);
  return (
    <div className="px-4">
      <ChartContainer
        aria-label={t`Requests over time`}
        className="aspect-auto h-28 w-full"
        config={config}
      >
        <BarChart
          accessibilityLayer={false}
          barCategoryGap="20%"
          data={report.bars.map((bar) => ({
            at: bar.at,
            count:
              Object.values(bar.kinds).reduce((sum, each) => sum + each, 0) +
              (asked ? bar.notBilled : 0),
          }))}
          margin={{ top: 4, right: 0, bottom: 0, left: 0 }}
        >
          <XAxis
            axisLine={false}
            dataKey="at"
            minTickGap={40}
            tickFormatter={format}
            tickLine={false}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(value) =>
                  typeof value === "string" ? format(value) : ""
                }
              />
            }
            cursor={false}
          />
          <Bar
            dataKey="count"
            fill={chartColor("chart-1")}
            isAnimationActive={false}
            radius={2}
          />
        </BarChart>
      </ChartContainer>
    </div>
  );
};

type Names = ReturnType<typeof useRequestNames>;

/** What a topic, team or place row opens, if anything. */
type Opener = (subject: RequestSubject) => (() => void) | undefined;

/** What they ask: a row per topic. */
const TopicsPart = ({
  report,
  names,
  opener,
}: {
  report: RequestsReport;
  names: Names;
  opener: Opener;
}) => {
  const { t } = useLingui();
  return (
    <Section title={t`What they ask`}>
      {report.byTopic.map((each) => (
        <OpenRow
          className={row}
          key={each.key}
          onOpen={opener({ kind: "topic", id: each.key })}
        >
          <span className={cn("truncate", nameCell)}>
            {names.topic(each.key)}
          </span>
          <Count value={each.billed} />
        </OpenRow>
      ))}
    </Section>
  );
};

/** The teams it is asked in. */
const TeamsPart = ({
  report,
  names,
  opener,
  asked,
}: {
  report: RequestsReport;
  names: Names;
  opener: Opener;
  asked: boolean;
}) => {
  const { t } = useLingui();
  const countOf = (each: RequestsReport["byTeam"][number]): number =>
    asked ? each.requests : each.billed;
  // Most first by the count it shows, and the teams too small to name last.
  const teams = report.byTeam.toSorted(
    (a, b) =>
      Number(a.key === elsewhere) - Number(b.key === elsewhere) ||
      countOf(b) - countOf(a)
  );
  return (
    <Section
      title={t({ message: "Teams", context: "Stephen's requests by team" })}
    >
      {teams.map((each) => (
        <OpenRow
          className={row}
          key={each.key}
          onOpen={opener({ kind: "team", id: each.key })}
        >
          <span className={cn("truncate", nameCell)}>
            {names.team(each.key)}
          </span>
          <Count value={countOf(each)} />
        </OpenRow>
      ))}
    </Section>
  );
};

/** What he did it with: the five tools he called most. */
const ToolsPart = ({
  report,
  names,
}: {
  report: RequestsReport;
  names: Names;
}) => {
  const { t } = useLingui();
  if (report.byTool.length === 0) {
    return null;
  }
  return (
    <Section title={t`Done with`}>
      {report.byTool.slice(0, 5).map((each) => {
        const name = names.tool(each.key);
        return (
          <OpenRow className={row} key={each.key}>
            <span className={cn("flex items-center gap-2", nameCell)}>
              <ToolMark label={name} tool={each.key} />
              <span className="truncate">{name}</span>
            </span>
            <Count value={each.calls} />
          </OpenRow>
        );
      })}
    </Section>
  );
};

/** Where they asked: from the bars, which fold no small group away, as a person's panel is one person. */
const PlacesPart = ({ report }: { report: RequestsReport }) => {
  const { t } = useLingui();
  const byPlace = new Map<string, number>();
  for (const bar of report.bars) {
    for (const [place, count] of Object.entries(bar.places)) {
      byPlace.set(place, (byPlace.get(place) ?? 0) + count);
    }
  }
  return (
    <Section
      title={t({
        message: "Where",
        context: "the places people asked Stephen in",
      })}
    >
      {[...byPlace]
        .toSorted((a, b) => b[1] - a[1])
        .map(([place, count]) => (
          <OpenRow className={row} key={place}>
            <span className={cn("flex items-center gap-2", nameCell)}>
              <PlaceLogo place={place} />
              <span className="truncate">{placeName(place)}</span>
            </span>
            <Count value={count} />
          </OpenRow>
        ))}
    </Section>
  );
};

/** The questions of a topic many ask, with what grew. */
const QuestionsPart = ({
  rows,
  names,
  before,
  opener,
  title,
}: {
  rows: { question: string; people: number }[];
  names: Names;
  before: RequestsPage["before"];
  opener: Opener;
  title: string;
}) =>
  rows.length === 0 ? null : (
    <Section title={title}>
      {rows.map((each) => (
        <OpenRow
          className={row}
          key={each.question}
          onOpen={opener({ kind: "question", id: each.question })}
        >
          <span className={cn("flex items-baseline gap-2", nameCell)}>
            <span className="min-w-0">{names.question(each.question)}</span>
            {before === null ? null : (
              <Growth
                grew={growth(
                  each.people,
                  before.questions.find(
                    (earlier) => earlier.question === each.question
                  )?.people ?? 0
                )}
              />
            )}
          </span>
          <Count value={each.people} />
        </OpenRow>
      ))}
    </Section>
  );

/** The panel's body: what the subject is made of. */
const Body = ({
  subject,
  page,
  names,
  opener,
}: {
  subject: RequestSubject;
  page: RequestsPage;
  names: Names;
  opener: Opener;
}) => {
  const { t } = useLingui();
  const { report, before } = page;
  const tools = <ToolsPart names={names} report={report} />;
  const places = <PlacesPart report={report} />;
  const topics = <TopicsPart names={names} opener={opener} report={report} />;
  const teams = (asked: boolean) => (
    <TeamsPart asked={asked} names={names} opener={opener} report={report} />
  );
  const aboutTeam =
    subject.kind === "team" ||
    (subject.kind === "need" && subject.need.teamId !== null);
  if (subject.kind === "person") {
    return places;
  }
  if (aboutTeam) {
    return (
      <>
        {topics}
        <QuestionsPart
          before={null}
          names={names}
          opener={opener}
          rows={report.notPossible}
          title={t`He can't do yet`}
        />
        {places}
      </>
    );
  }
  if (subject.kind === "topic") {
    return (
      <>
        <QuestionsPart
          before={before}
          names={names}
          opener={opener}
          rows={report.questions}
          title={t`What many ask`}
        />
        {tools}
        {teams(false)}
      </>
    );
  }
  return (
    <>
      {tools}
      {teams(true)}
    </>
  );
};

/** The panel's title, as the page names its subject. */
const titleOf = (subject: RequestSubject, names: Names): string => {
  if (subject.kind === "need") {
    return subject.need.label;
  }
  const named: Record<typeof subject.kind, (id: string) => string> = {
    team: names.team,
    topic: names.topic,
    person: names.person,
    question: names.question,
  };
  return named[subject.kind](subject.id);
};

/** One panel, its report read. */
const Panel = ({
  subject,
  page,
  canBack,
  canManage,
  onBack,
  onOpen,
  onOnlyTeam,
  onChanged,
}: {
  subject: RequestSubject;
  page: RequestsPage;
  canBack: boolean;
  canManage: boolean;
  onBack: () => void;
  onOpen: (subject: RequestSubject) => void;
  onOnlyTeam: ((teamId: string) => void) | null;
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const names = useRequestNames(page);
  const asking = useAskGrasp();
  const { report } = page;
  const need = subject.kind === "need" ? subject.need : null;
  const asked = subject.kind === "question" || need !== null;
  const { people } = report.total;
  const times = report.total.requests;
  const { billed } = report.total;
  let description = asked
    ? t`${plural(times, { one: "Asked once", other: "Asked # times" })} · ${plural(people, { one: "# person", other: "# people" })}`
    : t`${plural(billed, { one: "# request", other: "# requests" })} · ${plural(people, { one: "# person", other: "# people" })}`;
  if (subject.kind === "person") {
    description = t`${plural(billed, { one: "# request", other: "# requests" })}`;
  }
  if (page.tooFew) {
    description = t`Fewer than five people: not shown on its own.`;
  }
  const opener: Opener = (next) =>
    "id" in next && next.id === elsewhere
      ? undefined
      : () => {
          onOpen(next);
        };
  const title = titleOf(subject, names);
  const teamOnly =
    subject.kind === "team" && onOnlyTeam !== null ? subject.id : null;
  const makesWorkflow = subject.kind === "topic" || subject.kind === "question";
  // Only a panel with something to do has a footer: a person's has none.
  const hasFooter = need !== null || teamOnly !== null || makesWorkflow;
  return (
    <>
      <SheetHeader className="mr-8">
        {canBack ? (
          <Button
            className="-ml-2 self-start"
            onClick={onBack}
            size="sm"
            variant="ghost"
          >
            <ArrowLeftIcon data-icon="inline-start" />
            {t`Back`}
          </Button>
        ) : null}
        <SheetTitle>{title}</SheetTitle>
        <SheetDescription>{description}</SheetDescription>
      </SheetHeader>
      {need === null ? null : <NeedPart need={need} />}
      {report.total.requests > 0 ? (
        <Over asked={asked} report={report} />
      ) : null}
      {page.tooFew ? null : (
        <div className="flex flex-col gap-5 pb-4">
          <Body names={names} opener={opener} page={page} subject={subject} />
        </div>
      )}
      {hasFooter ? (
        <div className="bg-popover sticky bottom-0 mt-auto border-t">
          <SheetFooter>
            {need === null ? null : (
              <NeedActions
                canManage={canManage}
                need={need}
                onChanged={onChanged}
              />
            )}
            {teamOnly === null ? null : (
              <Button
                onClick={() => {
                  onOnlyTeam?.(teamOnly);
                }}
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
              >
                {t`Make a workflow of it`}
              </Button>
            ) : null}
            <ErrorText>{asking.failure}</ErrorText>
          </SheetFooter>
        </div>
      ) : null}
    </>
  );
};

/** The panel, while it reads what it is about. */
const Loaded = (props: {
  subject: RequestSubject;
  range: RequestRange;
  place: string | null;
  canBack: boolean;
  canManage: boolean;
  onBack: () => void;
  onOpen: (subject: RequestSubject) => void;
  onOnlyTeam: ((teamId: string) => void) | null;
  onChanged: () => Promise<void>;
}) => {
  const [by, id] = narrowingOf(props.subject);
  const narrowed = useNarrowed(props.range, props.place, by, id);
  if (narrowed.state === "loading") {
    return (
      <div className="p-4">
        <LoadingLines />
      </div>
    );
  }
  if (narrowed.state === "failed") {
    return (
      <div className="p-4">
        <ErrorText>{narrowed.reason}</ErrorText>
      </div>
    );
  }
  return <Panel {...props} page={narrowed.page} />;
};

/** The panel beside the page: the last subject opened on top, with Back to the one before. */
export const RequestDetail = ({
  trail,
  range,
  place,
  canManage,
  onTrail,
  onOnlyTeam,
  onChanged,
}: {
  trail: RequestSubject[];
  range: RequestRange;
  place: string | null;
  canManage: boolean;
  onTrail: (trail: RequestSubject[]) => void;
  onOnlyTeam: ((teamId: string) => void) | null;
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const subject = trail.at(-1);
  return (
    <Sheet
      onOpenChange={(open) => {
        if (!open) {
          onTrail([]);
        }
      }}
      open={subject !== undefined}
    >
      <SheetContent
        className="overflow-y-auto"
        closeLabel={t`Close`}
        size="wide"
      >
        {subject === undefined ? null : (
          <Loaded
            canBack={trail.length > 1}
            canManage={canManage}
            key={narrowingOf(subject).join(":")}
            onBack={() => {
              onTrail(trail.slice(0, -1));
            }}
            onChanged={onChanged}
            onOnlyTeam={onOnlyTeam}
            onOpen={(next) => {
              onTrail([...trail, next]);
            }}
            place={place}
            range={range}
            subject={subject}
          />
        )}
      </SheetContent>
    </Sheet>
  );
};
