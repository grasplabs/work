import type { AuditRecord } from "@grasp-os/shared/audit-log";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@grasp-os/ui/components/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@grasp-os/ui/components/tabs";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { Await, Link } from "@tanstack/react-router";
import { ArrowDownUpIcon, InboxIcon, ListFilterIcon } from "lucide-react";
import { useState } from "react";

import { actorOf, typeLabels } from "../activity/audit-log.tsx";
import { actionWords } from "../activity/audit-words.ts";
import type { LatestActivity } from "../dashboard/activity.tsx";
import type { Directory } from "../directory.ts";
import { formatDateTime, formatDay } from "../format.ts";
import { LoadingLines } from "../frame/page-states.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { KindPill, ItemMark } from "./inbox-kind.tsx";
import { ItemDetail } from "./item-detail.tsx";
import { listed } from "./items.ts";
import type { Group, InboxItem, Sort } from "./items.ts";

// The inbox, as the prototype's (`routes/inbox.tsx`): what waits on the
// person, what was done with it, and what Grasp and people did. A wide
// list of one-line items, the item beside it, and its actions in a bar at
// the bottom. Items come from items.ts; each action goes through the same
// calls as the dashboard's pile, so it lands in the audit trail too.

const groupLabel: Record<Group, MessageDescriptor> = {
  all: msg({ message: "Everything", context: "inbox filter" }),
  workflows: msg({ message: "Workflows", context: "inbox filter" }),
  brain: msg({ message: "Brain", context: "inbox filter" }),
  policies: msg({ message: "Policies", context: "inbox filter" }),
  apps: msg({ message: "Apps and connections", context: "inbox filter" }),
};

const groups = ["all", "workflows", "brain", "policies", "apps"] as const;

const sortLabel: Record<Sort, MessageDescriptor> = {
  urgent: msg({
    message: "What blocks first, then newest",
    context: "inbox sort",
  }),
  newest: msg({ message: "Newest first", context: "inbox sort" }),
  oldest: msg({ message: "Oldest first", context: "inbox sort" }),
};

const sorts = ["urgent", "newest", "oldest"] as const;

const isGroup = (value: string): value is Group =>
  groups.some((each) => each === value);

const isSort = (value: string): value is Sort =>
  sorts.some((each) => each === value);

/** A dot for what blocks something; an empty place for the rest, so the dates line up. */
const UrgentDot = ({ urgent }: { urgent: boolean }) =>
  urgent ? (
    <span className="bg-status-attention size-1.75 flex-none rounded-full" />
  ) : (
    <span className="size-1.75 flex-none" />
  );

/** One item on one line: what it is about, its kind, its date. */
const ItemRow = ({
  item,
  active,
  onSelect,
}: {
  item: InboxItem;
  active: boolean;
  onSelect: () => void;
}) => (
  <button
    aria-current={active ? "true" : undefined}
    className={
      active
        ? "border-l-foreground bg-accent focus-visible:ring-ring flex h-14 w-full flex-none items-center gap-3 border-b border-l-2 pr-4 pl-3.5 text-left outline-none focus-visible:ring-2"
        : "hover:bg-muted focus-visible:ring-ring flex h-14 w-full flex-none items-center gap-3 border-b border-l-2 border-l-transparent pr-4 pl-3.5 text-left outline-none focus-visible:ring-2"
    }
    onClick={onSelect}
    type="button"
  >
    <ItemMark item={item} />
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate">{item.context}</span>
    </span>
    <span className="hidden @md/list:inline-flex">
      <KindPill kind={item.kind} />
    </span>
    <span className="text-muted-foreground w-16 flex-none text-right text-xs tabular-nums">
      {formatDay(item.date)}
    </span>
    <UrgentDot urgent={item.urgent} />
  </button>
);

/** What the activity tab read: the latest of the trail, with the names to show. */
export interface InboxActivity extends LatestActivity {
  directory: Directory;
}

type Who = "all" | "grasp" | "people";

/** Whether Grasp or its agents, Apps and runs did it, rather than a person. */
const byGrasp = (record: AuditRecord): boolean => {
  const type = record.event?.actor.type;
  return type !== "person" && type !== "staff" && type !== "guest";
};

const ActivityRow = ({
  record,
  directory,
}: {
  record: AuditRecord;
  directory: Directory;
}) => {
  const { i18n, t } = useLingui();
  const action = record.event?.action;
  const text = action === undefined ? undefined : actionWords(action);
  let sentence = t`Unreadable event`;
  if (text !== undefined) {
    sentence = i18n._(text);
  } else if (action !== undefined) {
    sentence = action;
  }
  const actor =
    record.event === null ? "–" : actorOf(record.event.actor, directory).label;
  return (
    <li className="flex items-start gap-4 border-b py-3">
      <span className="text-muted-foreground w-28 flex-none pt-0.5 text-xs tabular-nums">
        {formatDateTime(record.receivedAt)}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span>{sentence}</span>
        <span className="text-muted-foreground">{actor}</span>
      </div>
      {record.type === null ? null : (
        <Badge variant={byGrasp(record) ? "secondary" : "outline"}>
          {i18n._(typeLabels[record.type])}
        </Badge>
      )}
    </li>
  );
};

/**
 * What happened, newest first: what Grasp and its agents did by
 * themselves, and what people did. The full, searchable list is the audit
 * trail in Settings.
 */
const ActivityList = ({ activity }: { activity: InboxActivity }) => {
  const { t } = useLingui();
  const [who, setWho] = useState<Who>("all");
  const shown = activity.records
    .filter((record) => {
      if (who === "all") {
        return true;
      }
      return who === "grasp" ? byGrasp(record) : !byGrasp(record);
    })
    .slice(0, 100);
  return (
    <div className="pb-chat mx-auto flex w-full max-w-4xl flex-col gap-3 px-6 pt-4">
      <div className="flex items-center justify-between gap-3">
        <ToggleGroup
          aria-label={t`Show activity by`}
          onValueChange={(value) => {
            const [next] = value;
            setWho(next === "grasp" || next === "people" ? next : "all");
          }}
          size="sm"
          value={[who]}
          variant="outline"
        >
          <ToggleGroupItem value="all">
            <Trans context="activity filter: everyone">All</Trans>
          </ToggleGroupItem>
          <ToggleGroupItem value="grasp">Grasp</ToggleGroupItem>
          <ToggleGroupItem value="people">
            <Trans context="activity filter: what people did">People</Trans>
          </ToggleGroupItem>
        </ToggleGroup>
        <Link
          className="text-muted-foreground hover:text-foreground hover:underline"
          to="/settings/audit"
        >
          <Trans>The full audit trail</Trans>
        </Link>
      </div>
      <ul aria-label={t`Latest activity`} className="flex flex-col">
        {shown.map((record) => (
          <ActivityRow
            directory={activity.directory}
            key={record.seq}
            record={record}
          />
        ))}
      </ul>
    </div>
  );
};

/** The list and the item beside it, or on a narrow screen one at a time. */
const ToDoTab = ({
  items,
  group,
  sort,
  onSaid,
}: {
  items: readonly InboxItem[];
  group: Group;
  sort: Sort;
  onSaid: (said: string) => void;
}) => {
  const { t } = useLingui();
  const list = listed(items, group, sort);
  const [selectedId, setSelectedId] = useState<string>();
  // On a narrow screen the item takes the list's place once one is chosen, with a way back.
  const [reading, setReading] = useState(false);
  const selected = list.find((item) => item.id === selectedId) ?? list[0];
  return (
    <div className="@4xl/inbox:grid-cols-inbox grid min-h-0 w-full flex-1 grid-cols-1">
      {/* Whichever of the two reaches the bottom right corner leaves room at its foot for the chat box: the list while it is alone, the item always. */}
      <section
        aria-label={t`What waits on you`}
        className={
          reading
            ? "@container/list hidden min-h-0 flex-col overflow-y-auto border-r @4xl/inbox:flex"
            : "pb-chat @container/list flex min-h-0 flex-col overflow-y-auto @4xl/inbox:border-r @4xl/inbox:pb-0"
        }
      >
        {list.length === 0 ? (
          <p className="text-muted-foreground px-5 py-4">
            <Trans>Nothing waits on you.</Trans>
          </p>
        ) : (
          list.map((item) => (
            <ItemRow
              active={item.id === selected?.id}
              item={item}
              key={item.id}
              onSelect={() => {
                setSelectedId(item.id);
                setReading(true);
              }}
            />
          ))
        )}
      </section>
      <div
        className={
          reading
            ? "pb-chat @container/item flex min-h-0 flex-col overflow-y-auto"
            : "pb-chat @container/item hidden min-h-0 flex-col overflow-y-auto @4xl/inbox:flex"
        }
      >
        {selected === undefined ? (
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <InboxIcon />
              </EmptyMedia>
              <EmptyTitle>
                <Trans>Nothing waits on you</Trans>
              </EmptyTitle>
              <EmptyDescription>
                <Trans>
                  What Grasp and its agents do by themselves is under Activity.
                </Trans>
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ItemDetail
            item={selected}
            key={selected.id}
            onBack={() => {
              setReading(false);
            }}
            onSaid={onSaid}
          />
        )}
      </div>
    </div>
  );
};

/**
 * The inbox. `notLoaded` are the parts of what waits that couldn't be
 * read, said above the list rather than left to look like nothing waits.
 * `activity` is the latest of the audit trail, for admins only.
 */
export const InboxPage = ({
  items,
  notLoaded,
  activity,
}: {
  items: readonly InboxItem[];
  notLoaded: readonly Loaded<unknown>[];
  activity: Promise<Loaded<InboxActivity>> | undefined;
}) => {
  const { t, i18n } = useLingui();
  const [tab, setTab] = useState("todo");
  const [group, setGroup] = useState<Group>("all");
  const [sort, setSort] = useState<Sort>("urgent");
  const [said, setSaid] = useState("");
  return (
    <>
      <SiteHeader crumbs={[{ label: t`Inbox` }]} />
      {/* As high as the window under the header, so the list and the item each scroll on their own. */}
      <div className="h-inbox flex min-h-0 flex-col text-sm">
        <Tabs
          className="min-h-0 flex-1"
          onValueChange={(value: string) => {
            setTab(value);
          }}
          spacing="none"
          value={tab}
        >
          {/* With no room beside the tabs, the filter and the order go under them. */}
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b px-4 py-3">
            <TabsList>
              <TabsTrigger value="todo">
                <Trans context="inbox tab: what waits on you">To do</Trans>
                <Badge variant="secondary">{items.length}</Badge>
              </TabsTrigger>
              <TabsTrigger value="done">
                <Trans context="inbox tab: what someone dealt with">Done</Trans>
                <Badge variant="secondary">0</Badge>
              </TabsTrigger>
              {activity === undefined ? null : (
                <TabsTrigger value="activity">
                  <Trans context="inbox tab: what Grasp and people did">
                    Activity
                  </Trans>
                </TabsTrigger>
              )}
            </TabsList>
            {tab === "todo" ? (
              <div className="flex items-center gap-2">
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={<Button size="sm" variant="outline" />}
                  >
                    <ListFilterIcon data-icon="inline-start" />
                    {group === "all" ? (
                      <Trans context="inbox: filter button">Filter</Trans>
                    ) : (
                      i18n._(groupLabel[group])
                    )}
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuRadioGroup
                      onValueChange={(value: string) => {
                        if (isGroup(value)) {
                          setGroup(value);
                        }
                      }}
                      value={group}
                    >
                      {groups.map((each) => (
                        <DropdownMenuRadioItem key={each} value={each}>
                          {i18n._(groupLabel[each])}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={<Button size="sm" variant="outline" />}
                  >
                    <ArrowDownUpIcon data-icon="inline-start" />
                    <Trans context="inbox: sort button">Sort</Trans>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuRadioGroup
                      onValueChange={(value: string) => {
                        if (isSort(value)) {
                          setSort(value);
                        }
                      }}
                      value={sort}
                    >
                      {sorts.map((each) => (
                        <DropdownMenuRadioItem key={each} value={each}>
                          {i18n._(sortLabel[each])}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ) : null}
          </div>

          {notLoaded.map((part, index) => (
            <div className="border-b px-5 py-3" key={index}>
              <NotLoaded page={part} />
            </div>
          ))}

          {/* Wide list, narrower item: the list is where an admin works through what waits. The
            columns follow the room the page has, not the window, so an open sidebar counts. */}
          <TabsContent
            className="@container/inbox flex min-h-0 flex-1"
            value="todo"
          >
            <ToDoTab group={group} items={items} onSaid={setSaid} sort={sort} />
          </TabsContent>

          <TabsContent className="min-h-0 flex-1 overflow-y-auto" value="done">
            {/* Core keeps no record yet of what was done with an item. */}
            <p className="text-muted-foreground px-6 py-4">
              <Trans>
                Nothing dealt with yet. What you decide here shows up in this
                list, and in the audit trail.
              </Trans>
            </p>
          </TabsContent>

          {activity === undefined ? null : (
            <TabsContent
              className="min-h-0 flex-1 overflow-y-auto"
              value="activity"
            >
              <Await fallback={<LoadingLines />} promise={activity}>
                {(loaded) =>
                  loaded.state === "ready" ? (
                    <ActivityList activity={loaded.data} />
                  ) : (
                    <div className="px-6 py-4">
                      <NotLoaded page={loaded} />
                    </div>
                  )
                }
              </Await>
            </TabsContent>
          )}
        </Tabs>
      </div>
      {/* What was done with an item, for a screen reader: the list only loses it. */}
      <output className="sr-only">{said}</output>
    </>
  );
};
