import { elsewhere, growth } from "@grasp-os/shared/stephen-requests";
import type { Need, RequestsPage } from "@grasp-os/shared/stephen-requests";
import { Button } from "@grasp-os/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@grasp-os/ui/components/tabs";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { formatNumber, formatPercent } from "../../format.ts";
import { RequestDetail } from "./request-detail.tsx";
import type { RequestSubject } from "./request-detail.tsx";
import { NeedMark, useNeedState, useNeedWhy } from "./request-needs.tsx";
import {
  Growth,
  OpenRow,
  ToolMark,
  useRequestNames,
} from "./request-parts.tsx";
import { RequestPeople, RequestTeams } from "./request-who.tsx";

// The table to work from, under the plan, as the prototype's
// `request-table.tsx`: one view at a time. Needs you first, a list to work
// through, with what was fixed or left under Handled; then what people
// ask, by topic, with the marks of what he did it with, what is new or
// grew, and how helpful people found it; who asks, by team; and by person.
// Every row opens the same panel (request-detail.tsx).

type View = "needs" | "asked" | "teams" | "people";

const isView = (value: unknown): value is View =>
  value === "needs" ||
  value === "asked" ||
  value === "teams" ||
  value === "people";

/** A row's grid: a name, a second cell from where there is room, a count, the chevron. */
const grid =
  "grid grid-cols-[minmax(0,1fr)_auto_1rem] items-center gap-x-6 gap-y-1.5 px-6 py-3 @2xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_4.5rem_1rem]";

/** The names of a table's columns, from where there is room for them. */
const Head = ({
  first,
  second,
  third,
}: {
  first: string;
  second: string;
  third: string;
}) => (
  <li
    aria-hidden="true"
    className="text-muted-foreground hidden grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_4.5rem_1rem] gap-x-6 px-6 pb-2 text-xs @2xl:grid"
  >
    <span>{first}</span>
    <span>{second}</span>
    <span className="text-right">{third}</span>
    <span />
  </li>
);

/** One thing Needs you lists. */
const NeedRow = ({ need, onOpen }: { need: Need; onOpen: () => void }) => {
  const why = useNeedWhy(need);
  const state = useNeedState(need);
  return (
    <OpenRow className={grid} onOpen={onOpen}>
      <span className="min-w-0">{need.label}</span>
      <span className="text-muted-foreground col-span-3 row-start-2 flex min-w-0 items-center gap-2 @2xl:col-span-1 @2xl:row-start-auto">
        <NeedMark need={need} />
        <span className="truncate">{state ?? why}</span>
      </span>
      <span className="text-right tabular-nums">
        {formatNumber(need.people ?? need.reach ?? 0)}
      </span>
    </OpenRow>
  );
};

/** Needs you: what waits, then what was handled. */
const Needs = ({
  needs,
  onOpen,
}: {
  needs: Need[] | null;
  onOpen: (need: Need) => void;
}) => {
  const { t } = useLingui();
  if (needs === null) {
    return (
      <p className="text-muted-foreground mt-3 border-t px-6 py-10 text-center">
        {t`What needs you can't be read right now.`}
      </p>
    );
  }
  const waiting = needs.filter(
    ({ status }) => status === null || status.status === "working"
  );
  const handled = needs.filter(
    ({ status }) => status !== null && status.status !== "working"
  );
  return (
    <ul className="@container mt-3">
      {waiting.length === 0 ? (
        <li className="text-muted-foreground border-t px-6 py-10 text-center">
          {t`Nothing waits on you.`}
        </li>
      ) : (
        <>
          <Head
            first={t`What it is`}
            second={t`Why`}
            third={t({ message: "People", context: "column" })}
          />
          {waiting.map((need) => (
            <NeedRow
              key={need.key}
              need={need}
              onOpen={() => {
                onOpen(need);
              }}
            />
          ))}
        </>
      )}
      {handled.length > 0 ? (
        <Collapsible
          className="group/handled"
          render={<li className="border-t" />}
        >
          <CollapsibleTrigger render={<Button size="sm" variant="ghost" />}>
            <ChevronRightIcon
              aria-hidden="true"
              className="size-4 transition-transform duration-150 group-data-panel-open/handled:rotate-90"
            />
            {t`Handled`}
            <span className="tabular-nums">{formatNumber(handled.length)}</span>
          </CollapsibleTrigger>
          <CollapsibleContent render={<ul className="@container" />}>
            {handled.map((need) => (
              <NeedRow
                key={need.key}
                need={need}
                onOpen={() => {
                  onOpen(need);
                }}
              />
            ))}
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </ul>
  );
};

/** What people ask, by topic. */
const Topics = ({
  page,
  onOpen,
}: {
  page: RequestsPage;
  onOpen: (topic: string) => void;
}) => {
  const { t } = useLingui();
  const names = useRequestNames(page);
  const { report, before } = page;
  return (
    <ul className="@container mt-3">
      <Head
        first={t`Topic`}
        second={t`Done with`}
        third={t({ message: "Requests", context: "column: billed requests" })}
      />
      {report.byTopic.map((topic) => {
        const { people } = topic;
        const rated = topic.up + topic.down;
        const helpful = formatPercent(rated === 0 ? 0 : topic.up / rated);
        const grew =
          topic.key === elsewhere || before === null
            ? null
            : growth(
                topic.billed,
                before.byTopic.find((each) => each.key === topic.key)?.billed ??
                  0
              );
        return (
          <OpenRow
            className={grid}
            key={topic.key}
            onOpen={
              topic.key === elsewhere
                ? undefined
                : () => {
                    onOpen(topic.key);
                  }
            }
          >
            <span className="flex min-w-0 flex-col">
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="truncate">{names.topic(topic.key)}</span>
                <Growth grew={grew} />
              </span>
              <span className="text-muted-foreground truncate text-xs">
                {rated >= 5
                  ? t`${plural(people, { one: "# person", other: "# people" })} · ${helpful} helpful`
                  : t`${plural(people, { one: "# person", other: "# people" })}`}
              </span>
            </span>
            <span className="hidden items-center gap-1.5 @2xl:flex">
              {topic.tools.map((tool) => (
                <ToolMark
                  key={tool.key}
                  label={names.tool(tool.key)}
                  tool={tool.key}
                />
              ))}
            </span>
            <span className="text-right tabular-nums">
              {formatNumber(topic.billed)}
            </span>
          </OpenRow>
        );
      })}
    </ul>
  );
};

/** The table, and the panel its rows open. */
export const RequestTable = ({
  page,
  place,
  needs,
  busy,
  onPerPerson,
  onOnlyTeam,
  onChanged,
}: {
  page: RequestsPage;
  place: string | null;
  needs: Need[] | null;
  busy: boolean;
  onPerPerson: (on: boolean) => void;
  onOnlyTeam: ((teamId: string) => void) | null;
  onChanged: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const waiting = (needs ?? []).filter(
    ({ status }) => status === null || status.status === "working"
  ).length;
  const [view, setView] = useState<View>(waiting > 0 ? "needs" : "asked");
  // The panels opened from one another, the last on top; a row of the table starts afresh.
  const [trail, setTrail] = useState<RequestSubject[]>([]);
  const open = (subject: RequestSubject) => {
    setTrail([subject]);
  };
  return (
    <section className="bg-card rounded-xl border">
      <Tabs
        onValueChange={(value: unknown) => {
          if (isView(value)) {
            setView(value);
          }
        }}
        value={view}
      >
        <div className="px-6 pt-4">
          <TabsList aria-label={t`What the table shows`} variant="line">
            <TabsTrigger className="flex-none" value="needs">
              {t({
                message: "Needs you",
                context: "Stephen's requests to fix",
              })}
              <span className="text-muted-foreground tabular-nums">
                {formatNumber(waiting)}
              </span>
            </TabsTrigger>
            <TabsTrigger className="flex-none" value="asked">
              {t`What people ask`}
            </TabsTrigger>
            <TabsTrigger className="flex-none" value="teams">
              {t({ message: "Teams", context: "Stephen's requests by team" })}
            </TabsTrigger>
            <TabsTrigger className="flex-none" value="people">
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
            onOpen={(topic) => {
              open({ kind: "topic", id: topic });
            }}
            page={page}
          />
        </TabsContent>
        <TabsContent value="teams">
          <RequestTeams
            onOpen={(team) => {
              open({ kind: "team", id: team });
            }}
            page={page}
          />
        </TabsContent>
        <TabsContent value="people">
          <RequestPeople
            busy={busy}
            onOpen={(person) => {
              open({ kind: "person", id: person });
            }}
            onSwitch={onPerPerson}
            page={page}
          />
        </TabsContent>
      </Tabs>
      <RequestDetail
        canManage={page.canSetPerPerson}
        onChanged={async () => {
          // What the panel showed changed: the list shows it as it is now.
          setTrail([]);
          await onChanged();
        }}
        onOnlyTeam={
          onOnlyTeam === null
            ? null
            : (team) => {
                setTrail([]);
                onOnlyTeam(team);
              }
        }
        onTrail={setTrail}
        place={place}
        range={page.range}
        trail={trail}
      />
    </section>
  );
};
