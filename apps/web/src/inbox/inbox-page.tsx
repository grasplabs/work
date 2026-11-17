import type { AuditRecord } from "@grasp-os/shared/audit-log";
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Await, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { actorOf } from "../activity/audit-log.tsx";
import { actionWords } from "../activity/audit-words.ts";
import { typeLabels } from "../activity/type-labels.ts";
import type { LatestActivity } from "../dashboard/activity.tsx";
import type { Directory } from "../directory.ts";
import { formatDateTime, formatDayMonth } from "../format.ts";
import { LoadingLines } from "../frame/page-states.tsx";
import { RouterLink } from "../frame/router-link.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { Alert } from "../grasp/alert/index.ts";
import { Avatar } from "../grasp/avatar/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import { BrandIcon } from "../grasp/brand-icon/index.ts";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../grasp/empty/index.ts";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemDetail as ItemNote,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../grasp/tabs/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { notLoadedText } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { brandOf } from "./brand-of.ts";
import { kindLabel, kindMark } from "./inbox-kind.tsx";
import { ItemDetail } from "./item-detail.tsx";
import { groupOf, listed } from "./items.ts";
import type { Group, InboxItem } from "./items.ts";

// The inbox, on Grasp UI: what waits on the person, to work through
// quickly. The list on one side, by group (what blocks first), and the
// item on the other, answered in place; on a narrow page one at a time,
// the item with its way back. The open item is the page's address
// (`?item=<id>`), as the sidebar's Inbox view and the dashboard lead to
// it, so a link, Back and a reload keep it. J and K (or the arrow keys in
// the list) go to the next and the one before. A settled item leaves the
// list, and the one after it opens in its place. For admins, Activity
// holds the latest of the audit trail. Items come from items.ts; each
// action goes through the same calls as the dashboard's pile.

/**
 * The page's own width at which the list and the item stand side by side.
 * Written out here as in item-detail.tsx: StyleX reads a key only from
 * the file it is in.
 */
const WIDE = "@container inbox (width >= 52rem)";

const styles = stylex.create({
  page: {
    containerName: "inbox",
    containerType: "inline-size",
    display: "flex",
    flexDirection: "column",
    gap: grasp.space4,
    width: "100%",
  },
  split: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      [WIDE]: "minmax(18rem, 24rem) minmax(0, 1fr)",
    },
    alignItems: "start",
    gap: grasp.space4,
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space3,
    minWidth: 0,
  },
  // On a narrow page, the list makes way for the item that was opened.
  listAway: { display: { default: "none", [WIDE]: "flex" } },
  // The item stays in view while the list beside it scrolls.
  item: {
    position: { default: null, [WIDE]: "sticky" },
    top: 0,
    maxHeight: { default: null, [WIDE]: "calc(100dvh - 6rem)" },
    overflowY: { default: null, [WIDE]: "auto" },
    minWidth: 0,
  },
  itemAway: { display: { default: "none", [WIDE]: "block" } },
  unseen: {
    position: "absolute",
    width: grasp.hairline,
    height: grasp.hairline,
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
  },
});

/** The groups, short enough that the filter fits beside the list. */
const groupLabel: Record<Group, MessageDescriptor> = {
  all: msg({ message: "All", context: "inbox filter, short" }),
  workflows: msg({ message: "Workflows", context: "inbox filter" }),
  asked: msg({ message: "Asked of you", context: "inbox filter" }),
  brain: msg({ message: "Brain", context: "inbox filter, short" }),
  outcomes: msg({ message: "Unknown outcomes", context: "inbox filter" }),
  apps: msg({ message: "Apps", context: "inbox filter, short" }),
};

const groupOrder = ["asked", "brain", "outcomes", "workflows", "apps"] as const;

const isGroup = (value: string | null): value is Group =>
  value === "all" || groupOrder.some((each) => each === value);

/** What a row says under its name: its own words, or its kind and date when it has one. */
const rowLine = (item: InboxItem, kind: string): string => {
  if (item.summary !== undefined) {
    return item.summary;
  }
  return item.date === "" ? kind : `${kind} · ${formatDayMonth(item.date)}`;
};

/** The brand of what an item is about, beside its name, when its name names one. */
const BrandMark = ({ name }: { name: string | undefined }) => {
  const brand = name === undefined ? undefined : brandOf(name);
  return brand === undefined ? null : (
    <ItemNote>
      <BrandIcon brand={brand} decorative size="xs" tile={false} />
    </ItemNote>
  );
};

/** Whether a key press belongs to something being typed, not to the inbox. */
const typing = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target.closest("input, textarea, select, [role='textbox']") !== null);

/**
 * What waits, grouped as the filter offers it, with the item that is open
 * marked as the current one; each row a router link to its place.
 */
const ItemList = ({
  list,
  selected,
  onOpen,
}: {
  list: readonly InboxItem[];
  selected: InboxItem | undefined;
  onOpen: (id: string, focus: boolean) => void;
}) => {
  const { t, i18n } = useLingui();
  const step = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    const at = list.findIndex(({ id }) => id === selected?.id);
    const next = list[at + (event.key === "ArrowDown" ? 1 : -1)];
    if (next !== undefined) {
      event.preventDefault();
      onOpen(next.id, true);
    }
  });
  // On the list's own element, not as props: it is no control of its own.
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = element.current;
    const key = (event: globalThis.KeyboardEvent) => {
      step(event);
    };
    box?.addEventListener("keydown", key);
    return () => {
      box?.removeEventListener("keydown", key);
    };
  }, []);
  return (
    <div ref={element}>
      <ItemGroup aria-label={t`What waits on you`} separated>
        {list.map((item) => (
          <Item
            current={item.id === selected?.id}
            key={item.id}
            render={<Link replace search={{ item: item.id }} to="/inbox" />}
            size="xs"
          >
            {item.face === undefined ? (
              <ItemMedia icon={kindMark[item.kind]} iconLook="inline" />
            ) : (
              <ItemMedia>
                <Avatar name={item.face} size="xs" />
              </ItemMedia>
            )}
            <ItemContent>
              <ItemTitle>
                {item.context}
                <BrandMark name={item.logo?.name} />
                {item.urgent ? (
                  <ItemNote>
                    <Badge size="sm" tone="attention">
                      <Trans context="inbox: something waits on this item">
                        Blocks work
                      </Trans>
                    </Badge>
                  </ItemNote>
                ) : null}
              </ItemTitle>
              <ItemDescription>
                {rowLine(item, i18n._(kindLabel[item.kind]))}
              </ItemDescription>
            </ItemContent>
          </Item>
        ))}
      </ItemGroup>
    </div>
  );
};

/** The list and the item beside it, or on a narrow page one at a time. */
const ToDo = ({
  items,
  chosen,
  initialGroup,
  notLoaded,
  olderFailures,
  onSaid,
}: {
  items: readonly InboxItem[];
  chosen: string | undefined;
  /** The group in view first, as an address may ask. */
  initialGroup?: Group;
  notLoaded: readonly Loaded<unknown>[];
  olderFailures: boolean;
  onSaid: (said: string) => void;
}) => {
  const { t, i18n } = useLingui();
  const navigate = useNavigate();
  const [group, setGroup] = useState<Group>(initialGroup ?? "all");
  // Where the open item stood, so the one after it opens once it is settled.
  const [at, setAt] = useState(0);
  const counts = new Map<Group, number>();
  for (const item of items) {
    const each = groupOf[item.kind];
    counts.set(each, (counts.get(each) ?? 0) + 1);
  }
  const shownGroups = groupOrder.filter((each) => counts.has(each));
  // A group that has emptied falls back to everything.
  const current = group === "all" || counts.has(group) ? group : "all";
  const list = listed(items, current, "urgent");
  const count = list.length;
  const index = list.findIndex(({ id }) => id === chosen);
  if (index !== -1 && index !== at) {
    setAt(index);
  }
  const selected =
    index === -1 ? list[Math.min(at, list.length - 1)] : list[index];
  // On a narrow page the item takes the list's place once one is asked for.
  const reading = chosen !== undefined && selected !== undefined;

  const open = (id: string, focus: boolean) => {
    void navigate({ to: "/inbox", search: { item: id }, replace: true });
    if (focus) {
      // The row keeps the focus as the keys move it, as a list's would.
      requestAnimationFrame(() => {
        document
          .querySelector<HTMLAnchorElement>(
            `a[href$="item=${encodeURIComponent(id)}"]`
          )
          ?.focus();
      });
    }
  };
  const back = () => {
    void navigate({ to: "/inbox", search: {}, replace: true });
  };

  // J and K anywhere on the page, but not while something is typed.
  const onKey = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (
      (event.key !== "j" && event.key !== "k") ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      typing(event.target)
    ) {
      return;
    }
    const from = list.findIndex(({ id }) => id === selected?.id);
    const next = list[from + (event.key === "j" ? 1 : -1)];
    if (next !== undefined) {
      event.preventDefault();
      open(next.id, false);
    }
  });
  useEffect(() => {
    const listen = (event: globalThis.KeyboardEvent) => {
      onKey(event);
    };
    document.addEventListener("keydown", listen);
    return () => {
      document.removeEventListener("keydown", listen);
    };
  }, []);

  const failed = notLoaded.flatMap((part) => notLoadedText(part, i18n) ?? []);
  if (items.length === 0) {
    return failed.length === 0 ? (
      <Empty size="lg">
        <EmptyHeader>
          <EmptyMedia picture="done" />
          <EmptyTitle>{t`Nothing waits on you`}</EmptyTitle>
          <EmptyDescription>
            {t`What Grasp asks you, and what waits for your yes, comes here.`}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    ) : (
      <Empty size="lg" tone="danger">
        <EmptyHeader>
          <EmptyMedia />
          <EmptyTitle>{t`The inbox didn't load`}</EmptyTitle>
          <EmptyDescription>{failed.join(" ")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div {...stylex.props(styles.split)}>
      <div {...stylex.props(styles.list, reading && styles.listAway)}>
        {failed.map((text) => (
          <Alert key={text} variant="attention">
            {text}
          </Alert>
        ))}
        {shownGroups.length < 2 ? null : (
          <Tabs
            onValueChange={(value) => {
              if (isGroup(value)) {
                setGroup(value);
              }
            }}
            value={current}
            variant="segmented"
          >
            <TabsList aria-label={t`Show`}>
              {(["all", ...shownGroups] as const).map((each) => (
                <TabsTrigger key={each} value={each}>
                  {i18n._(groupLabel[each])}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        )}
        <SectionCard
          density="compact"
          flush
          title={t`${plural(count, { one: "# item", other: "# items" })}`}
        >
          <ItemList list={list} onOpen={open} selected={selected} />
        </SectionCard>
        {olderFailures ? (
          <Text size="xs" tone="muted">
            <Trans>
              Older failed workflows are on the{" "}
              <RouterLink to="/dashboard">dashboard</RouterLink>.
            </Trans>
          </Text>
        ) : null}
      </div>
      <div {...stylex.props(styles.item, !reading && styles.itemAway)}>
        {selected === undefined ? null : (
          <ItemDetail
            item={selected}
            key={selected.id}
            onBack={reading ? back : undefined}
            onSaid={onSaid}
          />
        )}
      </div>
    </div>
  );
};

/** What the activity tab read: the latest of the trail, with the names to show. */
export interface InboxActivity extends LatestActivity {
  directory: Directory;
}

type Who = "all" | "grasp" | "people";

const isWho = (value: string | null): value is Who =>
  value === "all" || value === "grasp" || value === "people";

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
    <Item size="xs">
      <ItemContent>
        <ItemTitle>
          {sentence}
          {record.type === null ? null : (
            <ItemNote>
              <Badge size="sm">{i18n._(typeLabels[record.type])}</Badge>
            </ItemNote>
          )}
        </ItemTitle>
        <ItemDescription>
          {`${actor} · ${formatDateTime(record.receivedAt)}`}
        </ItemDescription>
      </ItemContent>
    </Item>
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
  const shown = activity.records.filter((record) => {
    if (who === "all") {
      return true;
    }
    return who === "grasp" ? byGrasp(record) : !byGrasp(record);
  });
  return (
    <SectionCard
      actions={
        <>
          <Tabs
            onValueChange={(value) => {
              if (isWho(value)) {
                setWho(value);
              }
            }}
            value={who}
            variant="segmented"
          >
            <TabsList aria-label={t`Show activity by`}>
              <TabsTrigger value="all">
                <Trans context="activity filter: everyone">All</Trans>
              </TabsTrigger>
              <TabsTrigger value="grasp">Grasp</TabsTrigger>
              <TabsTrigger value="people">
                <Trans context="activity filter: what people did">People</Trans>
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <RouterLink to="/settings/audit">
            <Trans>The full audit trail</Trans>
          </RouterLink>
        </>
      }
      density="compact"
      flush
      title={t`Latest activity`}
    >
      <ItemGroup aria-label={t`Latest activity`} separated>
        {shown.map((record) => (
          <ActivityRow
            directory={activity.directory}
            key={record.seq}
            record={record}
          />
        ))}
      </ItemGroup>
    </SectionCard>
  );
};

/**
 * The inbox. `notLoaded` are the parts of what waits that couldn't be
 * read, said above the list rather than left to look like nothing waits.
 * `activity` is the latest of the audit trail, for admins only.
 */
export const InboxPage = ({
  items,
  chosen,
  group,
  notLoaded,
  olderFailures,
  activity,
}: {
  items: readonly InboxItem[];
  /** The item open, by its ID: the list's first when none is, or it waits no more. */
  chosen?: string;
  /** The group in view first, as an address may ask. */
  group?: Group;
  notLoaded: readonly Loaded<unknown>[];
  /** Whether core has failed workflows older than the ones listed: the dashboard shows them. */
  olderFailures: boolean;
  activity: Promise<Loaded<InboxActivity>> | undefined;
}) => {
  const { t, i18n } = useLingui();
  const [said, setSaid] = useState("");
  const toDo = (
    <ToDo
      chosen={chosen}
      initialGroup={group}
      items={items}
      notLoaded={notLoaded}
      olderFailures={olderFailures}
      onSaid={setSaid}
    />
  );
  return (
    <>
      <SiteHeader crumbs={[{ label: t`Inbox` }]} />
      <div {...stylex.props(styles.page)}>
        {activity === undefined ? (
          toDo
        ) : (
          <Tabs defaultValue="todo">
            <TabsList aria-label={t`Inbox`}>
              <TabsTrigger value="todo">
                <Trans context="inbox tab: what waits on you">To do</Trans>
              </TabsTrigger>
              <TabsTrigger value="activity">
                <Trans context="inbox tab: what Grasp and people did">
                  Activity
                </Trans>
              </TabsTrigger>
            </TabsList>
            <TabsContent value="todo">{toDo}</TabsContent>
            <TabsContent value="activity">
              <Await fallback={<LoadingLines />} promise={activity}>
                {(loaded) =>
                  loaded.state === "ready" ? (
                    <ActivityList activity={loaded.data} />
                  ) : (
                    <Empty tone="danger">
                      <EmptyHeader>
                        <EmptyMedia />
                        <EmptyTitle />
                        <EmptyDescription>
                          {notLoadedText(loaded, i18n) ?? t`It didn't load`}
                        </EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  )
                }
              </Await>
            </TabsContent>
          </Tabs>
        )}
      </div>
      {/* What was done with an item, for a screen reader: the list only loses it. */}
      <output {...stylex.props(styles.unseen)}>{said}</output>
    </>
  );
};
