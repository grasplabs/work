import { elsewhere, growth } from "@grasp-os/shared/stephen-requests";
import type { Need, RequestsPage } from "@grasp-os/shared/stephen-requests";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";

import { formatNumber, formatPercent } from "../../format.ts";
import { LoadingLines } from "../../frame/page-states.tsx";
import { Badge } from "../../grasp/badge/index.ts";
import { Card } from "../../grasp/card/index.ts";
import { Collapsible } from "../../grasp/collapsible/index.ts";
import { DataTable } from "../../grasp/data-table/index.ts";
import type { DataTableColumn } from "../../grasp/data-table/index.ts";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
} from "../../grasp/empty/index.ts";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemDetail,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../../grasp/item/index.ts";
import { Sheet, SheetContent, SheetTitle } from "../../grasp/sheet/index.ts";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../../grasp/tabs/index.ts";
import { Text } from "../../grasp/text/index.ts";
import { grasp } from "../../grasp/tokens/tokens.stylex.ts";
import { RequestDetail } from "./request-detail.tsx";
import type { RequestSubject } from "./request-detail.tsx";
import {
  NeedMark,
  statusLabels,
  useNeedState,
  useNeedWhy,
} from "./request-needs.tsx";
import { Growth, ToolMark, useRequestNames } from "./request-parts.tsx";
import { RequestPeople, RequestTeams, RowName } from "./request-who.tsx";

// The table to work from, under the plan, as the prototype's
// `request-table.tsx`: one view at a time. Needs you first, a list to work
// through, with what was fixed or left under Handled; then what people
// ask, by topic, with the marks of what he did it with, what is new or
// grew, and how helpful people found it; who asks, by team; and by person.
// Every row opens the same panel (request-detail.tsx), beside the table
// where the page has room for both and in a Sheet otherwise.

type View = "needs" | "asked" | "teams" | "people";

const isView = (value: unknown): value is View =>
  value === "needs" ||
  value === "asked" ||
  value === "teams" ||
  value === "people";

/** How wide the page must be for a row to open beside the table. */
const besideFrom = 60 * 16;

const styles = stylex.create({
  tabs: { paddingInline: grasp.space4, paddingBlockStart: grasp.space2 },
  inset: { padding: grasp.space4 },
  handled: { paddingInline: grasp.space2, paddingBlockEnd: grasp.space2 },
  // A topic's name, with what grew, and how many asked under it.
  topic: { display: "flex", flexDirection: "column" },
  named: { display: "flex", alignItems: "center", gap: grasp.space2 },
  tools: { display: "flex", alignItems: "center", gap: grasp.space2 },
  // The table and the row opened beside it, as wide as the page lets them be.
  split: {
    display: "grid",
    gridTemplateColumns: `minmax(0, 1fr) ${grasp.inspectorWidth}`,
    columnGap: grasp.space6,
    alignItems: "start",
  },
});

/** A need's status, as a Badge only where it needs someone (open) or is done (fixed). */
const NeedBadge = ({ need }: { need: Need }) => {
  const { t, i18n } = useLingui();
  if (need.status === null) {
    return (
      <Badge size="sm" tone="attention">
        {t({ message: "Open", context: "a need nobody has taken up yet" })}
      </Badge>
    );
  }
  return need.status.status === "fixed" ? (
    <Badge size="sm" tone="success">
      {i18n._(statusLabels.fixed)}
    </Badge>
  ) : null;
};

/** One thing Needs you lists: the whole row opens it. */
const NeedRow = ({ need, onOpen }: { need: Need; onOpen: () => void }) => {
  const { t } = useLingui();
  const why = useNeedWhy(need);
  const state = useNeedState(need);
  const people = need.people ?? need.reach ?? 0;
  return (
    <Item
      render={<button aria-label={need.label} onClick={onOpen} type="button" />}
      size="sm"
    >
      <ItemMedia>
        <NeedMark need={need} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          {need.label} <NeedBadge need={need} />
          <ItemDetail>
            {t`${plural(people, { one: "# person", other: "# people" })}`}
          </ItemDetail>
        </ItemTitle>
        <ItemDescription>{state ?? why}</ItemDescription>
      </ItemContent>
    </Item>
  );
};

/** Needs you: what waits, then what was handled. */
const Needs = ({
  needs,
  onOpen,
}: {
  needs: Need[] | null | undefined;
  onOpen: (need: Need) => void;
}) => {
  const { t } = useLingui();
  if (needs === undefined) {
    return (
      <div {...stylex.props(styles.inset)}>
        <LoadingLines />
      </div>
    );
  }
  if (needs === null) {
    return (
      <Empty size="md">
        <EmptyHeader>
          <EmptyDescription>{t`What needs you can't be read right now.`}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  const waiting = needs.filter(
    ({ status }) => status === null || status.status === "working"
  );
  const handled = needs.filter(
    ({ status }) => status !== null && status.status !== "working"
  );
  const count = formatNumber(handled.length);
  return (
    <>
      {waiting.length === 0 ? (
        <Empty size="md">
          <EmptyHeader>
            <EmptyDescription>{t`Nothing waits on you.`}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup aria-label={t`What it is`} separated>
          {waiting.map((need) => (
            <NeedRow
              key={need.key}
              need={need}
              onOpen={() => {
                onOpen(need);
              }}
            />
          ))}
        </ItemGroup>
      )}
      {handled.length > 0 ? (
        <div {...stylex.props(styles.handled)}>
          <Collapsible
            title={
              <>
                {t`Handled`}{" "}
                <Text element="span" size="sm" tone="muted">
                  {count}
                </Text>
              </>
            }
          >
            <ItemGroup aria-label={t`Handled`} separated>
              {handled.map((need) => (
                <NeedRow
                  key={need.key}
                  need={need}
                  onOpen={() => {
                    onOpen(need);
                  }}
                />
              ))}
            </ItemGroup>
          </Collapsible>
        </div>
      ) : null}
    </>
  );
};

/** One topic of the report, as its row shows it. */
type TopicRow = RequestsPage["report"]["byTopic"][number] & {
  name: string;
  /** How it grew against the span before, or null where that can't be told. */
  grew: ReturnType<typeof growth> | null;
  /** Opens its detail; none for the topics folded together. */
  onOpen: (() => void) | undefined;
};

/** A topic: its name (opening it), how it grew, and who asked and how helpful the replies were. */
const TopicName = ({ topic }: { topic: TopicRow }) => {
  const { t } = useLingui();
  const { people, onOpen } = topic;
  const rated = topic.up + topic.down;
  const helpful = formatPercent(rated === 0 ? 0 : topic.up / rated);
  return (
    <span {...stylex.props(styles.topic)}>
      <span {...stylex.props(styles.named)}>
        <RowName name={topic.name} onOpen={onOpen} />
        <Growth grew={topic.grew} />
      </span>
      <Text element="span" size="xs" tone="muted">
        {rated >= 5
          ? t`${plural(people, { one: "# person", other: "# people" })} · ${helpful} helpful`
          : t`${plural(people, { one: "# person", other: "# people" })}`}
      </Text>
    </span>
  );
};

/** The topics table's columns, under their headers' words. */
const topicColumns = (words: {
  topic: string;
  doneWith: string;
  requests: string;
  tool: (tool: string) => string;
}): DataTableColumn<TopicRow>[] => [
  {
    key: "topic",
    header: words.topic,
    value: (topic) => topic.name,
    cell: (topic) => <TopicName topic={topic} />,
  },
  {
    key: "tools",
    header: words.doneWith,
    value: (topic) => topic.tools.map((tool) => words.tool(tool.key)).join(" "),
    cell: (topic) => (
      <span {...stylex.props(styles.tools)}>
        {topic.tools.map((tool) => (
          <ToolMark
            key={tool.key}
            label={words.tool(tool.key)}
            tool={tool.key}
          />
        ))}
      </span>
    ),
  },
  {
    key: "requests",
    header: words.requests,
    value: (topic) => topic.billed,
    cell: (topic) => formatNumber(topic.billed),
    align: "end",
  },
];

/** What people ask, by topic, on the library's Data table. */
const Topics = ({
  page,
  onOpen,
}: {
  page: RequestsPage;
  onOpen: (topic: string, name: string) => void;
}) => {
  const { t } = useLingui();
  const names = useRequestNames(page);
  const { report, before } = page;
  const rows: TopicRow[] = report.byTopic.map((topic) => {
    const name = names.topic(topic.key);
    return {
      ...topic,
      name,
      grew:
        topic.key === elsewhere || before === null
          ? null
          : growth(
              topic.billed,
              before.byTopic.find((each) => each.key === topic.key)?.billed ?? 0
            ),
      onOpen:
        topic.key === elsewhere
          ? undefined
          : () => {
              onOpen(topic.key, name);
            },
    };
  });
  return (
    <DataTable
      columns={topicColumns({
        topic: t`Topic`,
        doneWith: t`Done with`,
        requests: t({
          message: "Requests",
          context: "column: billed requests",
        }),
        tool: names.tool,
      })}
      density="compact"
      label={t`What people ask`}
      rowKey={(topic) => topic.key}
      rows={rows}
      unit={{ one: t`topic`, other: t`topics` }}
    />
  );
};

/** Whether the holder is wide enough for a row to open beside the table; it is until measured. */
const useWide = () => {
  const holder = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(true);
  useEffect(() => {
    const element = holder.current;
    const watch =
      element === null || typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(([entry]) => {
            setWide((entry?.contentRect.width ?? 0) >= besideFrom);
          });
    if (element !== null) {
      watch?.observe(element);
    }
    return () => {
      watch?.disconnect();
    };
  }, []);
  return { holder, wide };
};

/** The panel's name in a Sheet, as the row that opened it named it. */
const subjectName = (subject: RequestSubject | undefined): string => {
  if (subject === undefined) {
    return "";
  }
  return subject.kind === "need" ? subject.need.label : subject.name;
};

/** The table, and the panel its rows open. */
export const RequestTable = ({
  page,
  place,
  team,
  needs,
  busy,
  onPerPerson,
  onOnlyTeam,
  onChanged,
}: {
  page: RequestsPage;
  /** The page's filters, which the panels its rows open keep. */
  place: string | null;
  team: string | null;
  /** Undefined while they are read: they are read apart from the report. */
  needs: Need[] | null | undefined;
  busy: boolean;
  onPerPerson: (on: boolean) => void;
  onOnlyTeam: ((teamId: string) => void) | null;
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const { holder, wide } = useWide();
  const waiting = (needs ?? []).filter(
    ({ status }) => status === null || status.status === "working"
  ).length;
  // Until the person picks one: Needs you while it is read or has
  // something waiting, otherwise what people ask.
  const [picked, setPicked] = useState<View>();
  const view =
    picked ?? (needs === undefined || waiting > 0 ? "needs" : "asked");
  // The panels opened from one another, the last on top; a row of the table starts afresh.
  const [trail, setTrail] = useState<RequestSubject[]>([]);
  const open = (subject: RequestSubject) => {
    setTrail([subject]);
  };
  const opened = trail.at(-1);
  const detail = (framed: boolean) =>
    opened === undefined ? null : (
      <RequestDetail
        canManage={page.canSetPerPerson}
        framed={framed}
        onChanged={async () => {
          // What the panel showed changed: the list shows it as it is now.
          setTrail([]);
          await onChanged();
        }}
        onOnlyTeam={
          onOnlyTeam === null
            ? null
            : (teamId) => {
                setTrail([]);
                onOnlyTeam(teamId);
              }
        }
        onTrail={setTrail}
        place={place}
        range={page.range}
        team={team}
        trail={trail}
      />
    );
  const table = (
    <Card padding="none">
      <Tabs
        onValueChange={(value) => {
          if (isView(value)) {
            setPicked(value);
          }
        }}
        value={view}
      >
        <div {...stylex.props(styles.tabs)}>
          <TabsList aria-label={t`What the table shows`}>
            <TabsTrigger value="needs">
              {t({
                message: "Needs you",
                context: "Stephen's requests to fix",
              })}{" "}
              <Text element="span" size="sm" tone="muted">
                {formatNumber(waiting)}
              </Text>
            </TabsTrigger>
            <TabsTrigger value="asked">{t`What people ask`}</TabsTrigger>
            <TabsTrigger value="teams">
              {t({ message: "Teams", context: "Stephen's requests by team" })}
            </TabsTrigger>
            <TabsTrigger value="people">
              {t({
                message: "People",
                context: "Stephen's requests by person",
              })}
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="needs">
          <Needs
            needs={needs}
            onOpen={(need) => {
              open({ kind: "need", need });
            }}
          />
        </TabsContent>
        <TabsContent value="asked">
          <Topics
            onOpen={(topic, name) => {
              open({ kind: "topic", id: topic, name });
            }}
            page={page}
          />
        </TabsContent>
        <TabsContent value="teams">
          <RequestTeams
            onOpen={(teamId, name) => {
              open({ kind: "team", id: teamId, name });
            }}
            page={page}
          />
        </TabsContent>
        <TabsContent value="people">
          <RequestPeople
            busy={busy}
            onOpen={(person, name) => {
              open({ kind: "person", id: person, name });
            }}
            onSwitch={onPerPerson}
            page={page}
          />
        </TabsContent>
      </Tabs>
    </Card>
  );
  return (
    <div ref={holder}>
      {wide && opened !== undefined ? (
        <div {...stylex.props(styles.split)}>
          {table}
          {detail(true)}
        </div>
      ) : (
        table
      )}
      <Sheet
        onOpenChange={(next) => {
          if (!next) {
            setTrail([]);
          }
        }}
        open={!wide && opened !== undefined}
        size="md"
      >
        <SheetContent closeLabel={t`Close`}>
          <SheetTitle>{subjectName(opened)}</SheetTitle>
          {wide ? null : detail(false)}
        </SheetContent>
      </Sheet>
    </div>
  );
};
