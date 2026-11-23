import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@grasp-os/ui/components/sheet";
import {
  SidePanel,
  SidePanelContent,
} from "@grasp-os/ui/components/side-panel";
import { TabsLink, TabsNav } from "@grasp-os/ui/components/tabs";
import { Text } from "@grasp-os/ui/components/text";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  Icon,
} from "@grasp-os/ui/lib/icons";
import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { ReactNode } from "react";

import { formatDayMonth } from "../format.ts";
import { useWide } from "../frame/wide.ts";
import { notLoadedText } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { groupLabel, groupOrder } from "./groups.ts";
import { kindLabel, kindMark } from "./inbox-kind.tsx";
import { inboxStyles } from "./inbox-styles.ts";
import { ItemDetail } from "./item-detail.tsx";
import { groupOf, listed } from "./items.ts";
import type { Group, InboxItem } from "./items.ts";
import { orderOf, skip, stepFrom } from "./walk.ts";

// The Inbox, on Damsko: what waits on the person, to work through quickly.
// The list is the page; beside it on a wide window, Damsko's side panel
// holds the walk through what waits at its head ("1 of 3", back, next,
// Skip), then the item to decide. On a phone the list stands alone and a
// row opens the panel in a sheet. The open item is the page's address
// (`?item=<id>`), so a link, Back and a reload keep it, and so is the group
// in view (`?group=`); J and K (or the arrow keys in the list) go to the
// next and the one before; a settled item leaves the list and the one after
// it opens in its place. No tabs for what was done: what happened is
// Settings' audit trail. The weekly report stands at the head of the list
// once it is ready, quietly under it on other days. Items come from
// items.ts.

const styles = stylex.create({
  // The walk's head: where in what waits the item is, between its arrows, and Skip apart.
  walk: {
    display: "flex",
    alignItems: "center",
    gap: space["1"],
  },
  place: { fontVariantNumeric: "tabular-nums" },
  skip: { marginInlineStart: "auto" },
  inspector: {
    display: "flex",
    flexDirection: "column",
    gap: space["4"],
    minWidth: 0,
  },
  // Nothing waits: the report's row stands under the Empty, at a list's width.
  emptyFoot: {
    width: "100%",
    maxWidth: "24rem",
    marginInline: "auto",
  },
});

/** What a row says under its name: its kind and when it came in. */
const rowLine = (item: InboxItem, kind: string): string =>
  item.date === "" ? kind : `${kind} · ${formatDayMonth(item.date)}`;

/** Whether a key press belongs to something being typed, not to the inbox. */
const typing = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target.closest("input, textarea, select, [role='textbox']") !== null);

/**
 * What waits, with the item that is open marked as the current one; each
 * row a router link to its place.
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
      <ItemGroup aria-label={t`What waits on you`}>
        {list.map((item) => (
          <Item
            active={item.id === selected?.id}
            asChild
            key={item.id}
            size="xs"
          >
            <Link
              from="/inbox"
              replace
              search={(before) => ({ ...before, item: item.id })}
              to="/inbox"
            >
              <ItemMedia>
                <Icon icon={kindMark[item.kind]} />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>
                  {item.context}
                  {item.urgent ? (
                    <>
                      {" "}
                      <Badge size="sm" variant="warning">
                        <Trans context="inbox: something waits on this item">
                          Blocks work
                        </Trans>
                      </Badge>
                    </>
                  ) : null}
                </ItemTitle>
                <ItemDescription>
                  {rowLine(item, i18n._(kindLabel[item.kind]))}
                </ItemDescription>
              </ItemContent>
            </Link>
          </Item>
        ))}
      </ItemGroup>
    </div>
  );
};

/**
 * The groups as views of the list, each with its address and how many wait
 * in it: only when there is more than one, else the list is the one view.
 */
const GroupViews = ({
  items,
  current,
}: {
  items: readonly InboxItem[];
  current: Group;
}) => {
  const { t, i18n } = useLingui();
  const present = groupOrder.filter((group) =>
    items.some((item) => groupOf[item.kind] === group)
  );
  if (present.length < 2) {
    return null;
  }
  const countOf = (group: Group): number =>
    group === "all"
      ? items.length
      : items.filter((item) => groupOf[item.kind] === group).length;
  return (
    <TabsNav aria-label={t`Show`} variant="line">
      {(["all", ...present] as const).map((group) => {
        const count = countOf(group);
        return (
          <TabsLink asChild current={group === current} key={group}>
            <Link search={group === "all" ? {} : { group }} to="/inbox">
              {i18n._(groupLabel[group])}{" "}
              <span aria-hidden="true">{count}</span>
              <span {...stylex.props(visuallyHidden)}>
                {t`${plural(count, { one: "# waiting", other: "# waiting" })}`}
              </span>
            </Link>
          </TabsLink>
        );
      })}
    </TabsNav>
  );
};

/**
 * Nothing in the list: nothing waits, with the report's row under it; or
 * nothing loaded, said as a failure with Try again, never as an empty inbox.
 */
const NoItems = ({
  failed,
  foot,
}: {
  failed: readonly string[];
  foot: ReactNode;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  if (failed.length === 0) {
    return (
      <>
        <Empty size="lg">
          <EmptyHeader>
            <EmptyMedia illustration="done" />
            <EmptyTitle level={2}>{t`Nothing waits for you`}</EmptyTitle>
          </EmptyHeader>
        </Empty>
        {foot === undefined ? null : (
          <div {...stylex.props(styles.emptyFoot)}>{foot}</div>
        )}
      </>
    );
  }
  return (
    <Empty size="lg" variant="destructive">
      <EmptyHeader>
        <EmptyMedia />
        <EmptyTitle level={2}>{t`The inbox didn't load`}</EmptyTitle>
        <EmptyDescription>{failed.join(" ")}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        {/* Reads the inbox again, and works until it has. */}
        <Button
          errorLabel={t`Not loaded`}
          loadingLabel={t`Trying again…`}
          onClick={async () => {
            await router.invalidate({ sync: true });
          }}
          successLabel={t`Loaded`}
        >
          {t`Try again`}
        </Button>
      </EmptyContent>
    </Empty>
  );
};

/**
 * The walk's head over the item: where in what waits it is, the one before
 * and the next (round and round), and Skip, which puts it at the back.
 */
const WalkHead = ({
  place,
  count,
  onStep,
  onSkip,
}: {
  place: number;
  count: number;
  onStep: (by: 1 | -1) => void;
  onSkip: () => void;
}) => {
  const { t } = useLingui();
  // One alone has nowhere to go: no head.
  if (count < 2) {
    return null;
  }
  return (
    <div {...stylex.props(styles.walk)}>
      <Button
        aria-label={t`The one before`}
        onClick={() => {
          onStep(-1);
        }}
        size="icon-sm"
        variant="ghost"
      >
        <Icon icon={ChevronLeftIcon} />
      </Button>
      <span {...stylex.props(styles.place)}>
        <Text as="span" color="muted" size="sm">
          <Trans>
            {place} of {count}
          </Trans>
        </Text>
      </span>
      <Button
        aria-label={t`The next one`}
        onClick={() => {
          onStep(1);
        }}
        size="icon-sm"
        variant="ghost"
      >
        <Icon icon={ChevronRightIcon} />
      </Button>
      {/* Skipping is no answer: it stands apart from the item's own. */}
      <span {...stylex.props(styles.skip)}>
        <Button onClick={onSkip} size="sm" variant="ghost">
          <Trans context="put a to-do card at the back of the pile">Skip</Trans>
        </Button>
      </span>
    </div>
  );
};

/** The panel's content: the walk's head, then the item to decide, answered in place. */
const Inspector = ({
  selected,
  head,
  onSaid,
}: {
  selected: InboxItem;
  head: ReactNode;
  onSaid: (said: string) => void;
}) => (
  <SidePanelContent>
    <div {...stylex.props(styles.inspector)}>
      {head}
      <ItemDetail item={selected} key={selected.id} onSaid={onSaid} />
    </div>
  </SidePanelContent>
);

/**
 * The list and, beside it or in a sheet, the walk through it: the item
 * shown with its head.
 */
const ToDo = ({
  items,
  chosen,
  group,
  notLoaded,
  onSaid,
  foot,
  tail,
}: {
  items: readonly InboxItem[];
  chosen: string | undefined;
  /** The group in view, as the address has it (`?group=`). */
  group: Group;
  notLoaded: readonly Loaded<unknown>[];
  onSaid: (said: string) => void;
  /** What stands at the head of the list: the weekly report, once it is ready. */
  foot: ReactNode;
  /** What stands quietly under the list: the week's report so far. */
  tail: ReactNode;
}) => {
  const { i18n } = useLingui();
  const navigate = useNavigate();
  const wide = useWide();
  // Where the open item stood, so the one after it opens once it is settled.
  const [at, setAt] = useState(0);
  // What was skipped this visit, last skipped last: it waits at the back.
  const [skipped, setSkipped] = useState<readonly string[]>([]);
  // A group that has emptied falls back to everything.
  const current = items.some(
    (item) => group === "all" || groupOf[item.kind] === group
  )
    ? group
    : "all";
  const inGroup = listed(items, current);
  const ids = inGroup.map(({ id }) => id);
  const list = orderOf(ids, skipped).flatMap(
    (id) => inGroup.find((item) => item.id === id) ?? []
  );
  const index = list.findIndex(({ id }) => id === chosen);
  if (index !== -1 && index !== at) {
    setAt(index);
  }
  const selected =
    index === -1 ? list[Math.min(at, list.length - 1)] : list[index];
  // A row was chosen: on a phone its sheet opens.
  const reading = chosen !== undefined && selected !== undefined;
  const place = list.findIndex(({ id }) => id === selected?.id);

  const open = (id: string, focus: boolean) => {
    void navigate({
      from: "/inbox",
      to: "/inbox",
      search: (before) => ({ ...before, item: id }),
      replace: true,
    });
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
  const step = (by: 1 | -1) => {
    const next = list[stepFrom(list.length, place, by)];
    if (next !== undefined) {
      open(next.id, false);
    }
  };
  const skipShown = () => {
    if (selected === undefined) {
      return;
    }
    const after = skip(ids, {
      at: { id: selected.id, index: place },
      skipped,
    });
    setSkipped(after.skipped);
    if (after.at !== null) {
      open(after.at.id, false);
    }
  };
  const back = () => {
    void navigate({
      from: "/inbox",
      to: "/inbox",
      search: (before) => ({ ...before, item: undefined }),
      replace: true,
    });
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

  // Each reason once: when several reads fail for the same reason (Grasp
  // can't be reached), it is said once, not once per read.
  const failed = [
    ...new Set(notLoaded.flatMap((part) => notLoadedText(part, i18n) ?? [])),
  ];
  if (items.length === 0) {
    return (
      <div {...stylex.props(inboxStyles.page)}>
        <div {...stylex.props(inboxStyles.list, inboxStyles.listEmpty)}>
          <NoItems failed={failed} foot={foot ?? tail} />
        </div>
      </div>
    );
  }
  const label = selected === undefined ? "" : i18n._(kindLabel[selected.kind]);
  const inspector =
    selected === undefined ? null : (
      <Inspector
        head={
          <WalkHead
            count={list.length}
            onSkip={skipShown}
            onStep={step}
            place={place + 1}
          />
        }
        onSaid={onSaid}
        selected={selected}
      />
    );
  // Beside a wide list, the panel; on a phone, its sheet, open once a row is chosen.
  let beside: ReactNode = null;
  if (!wide) {
    beside = (
      <Sheet
        onOpenChange={(next) => {
          if (!next) {
            back();
          }
        }}
        open={reading}
      >
        <SheetContent side="end">
          <SheetHeader>
            <SheetTitle>{label}</SheetTitle>
          </SheetHeader>
          <SidePanel aria-label={label} framed={false}>
            {inspector}
          </SidePanel>
        </SheetContent>
      </Sheet>
    );
  } else if (inspector !== null) {
    beside = <SidePanel aria-label={label}>{inspector}</SidePanel>;
  }
  return (
    <div {...stylex.props(inboxStyles.page, wide && inboxStyles.pageBeside)}>
      {/* The list as the page: no card, the report's row at its head. */}
      <div {...stylex.props(inboxStyles.list)}>
        {failed.map((text) => (
          <Alert key={text} variant="warning">
            <AlertDescription>{text}</AlertDescription>
          </Alert>
        ))}
        <GroupViews current={current} items={items} />
        {foot}
        <ItemList
          list={list}
          onOpen={open}
          selected={wide || reading ? selected : undefined}
        />
        {tail}
      </div>
      {beside}
    </div>
  );
};

/**
 * The inbox. `notLoaded` are the parts of what waits that couldn't be
 * read, said above the list rather than left to look like nothing waits.
 */
export const InboxPage = ({
  items,
  chosen,
  group,
  notLoaded,
  foot,
  tail,
}: {
  items: readonly InboxItem[];
  /** The item open, by its ID: the list's first when none is, or it waits no more. */
  chosen?: string;
  /** The group in view, as the address has it; all when it has none. */
  group?: Exclude<Group, "all">;
  notLoaded: readonly Loaded<unknown>[];
  /** What stands at the head of the list: the weekly report, once it is ready. */
  foot?: ReactNode;
  /** What stands quietly under the list: the week's report so far. */
  tail?: ReactNode;
}) => {
  const [said, setSaid] = useState("");
  return (
    <>
      <ToDo
        chosen={chosen}
        foot={foot}
        group={group ?? "all"}
        items={items}
        notLoaded={notLoaded}
        onSaid={setSaid}
        tail={tail}
      />
      {/* What was done with an item, for a screen reader: the list only loses it. */}
      <output {...stylex.props(visuallyHidden)}>{said}</output>
    </>
  );
};
