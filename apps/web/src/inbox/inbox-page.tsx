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
import type { ReactNode, RefObject } from "react";

import { formatDayMonth } from "../format.ts";
import { useWide } from "../frame/wide.ts";
import { notLoadedText } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { groupLabel, groupOrder } from "./groups.ts";
import { kindLabel, kindMark } from "./inbox-kind.tsx";
import { inboxStyles } from "./inbox-styles.ts";
import { ItemDetail } from "./item-detail.tsx";
import type { Frame } from "./item-detail.tsx";
import { groupOf, listed } from "./items.ts";
import type { Group, InboxItem } from "./items.ts";
import { orderOf, placeIn, skip, stepFrom } from "./walk.ts";

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
  // Beside the list, the panel stops clear of the chat box, which the
  // frame centres over the page's foot, list and panel together: short by
  // the box's height, its gap to the card's foot and a little air, so the
  // box floats under the panel's end, never across its edge. Once the
  // frame seats the panel itself (#2617's page panel), the box centres
  // over the list alone and this goes.
  besideClearOfChat: { height: `calc(100% - ${space["20"]})`, minHeight: 0 },
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
          errorText={t`Not loaded`}
          loadingText={t`Trying again…`}
          onClick={async () => {
            await router.invalidate({ sync: true });
          }}
          successText={t`Loaded`}
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
  /** Where the item stands in what waits; undefined once it waits no more. */
  place: number | undefined;
  count: number;
  onStep: (by: 1 | -1) => void;
  onSkip: () => void;
}) => {
  const { t } = useLingui();
  // One alone has nowhere to go: no head. One kept after it waits no more
  // has the rest to go on to.
  if (place === undefined ? count < 1 : count < 2) {
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
          {place === undefined ? (
            <Trans>No longer waits for you</Trans>
          ) : (
            <Trans>
              {place} of {count}
            </Trans>
          )}
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
      {place === undefined ? null : (
        <span {...stylex.props(styles.skip)}>
          <Button onClick={onSkip} size="sm" variant="ghost">
            <Trans context="put a to-do card at the back of the pile">
              Skip
            </Trans>
          </Button>
        </span>
      )}
    </div>
  );
};

/**
 * An item's heading: an approval's title (Damsko's Confirmation, which
 * makes it a focus target itself), or a card's (item-detail.tsx).
 */
const itemHeading = "[data-slot='confirmation-title'], [data-item-heading]";

/** Whether focus fell to the page: its element went, or was turned off. */
const focusFell = (): boolean => {
  const active = document.activeElement;
  return (
    active === null ||
    active === document.body ||
    !active.isConnected ||
    active.matches(":disabled")
  );
};

/** The panel's content: the walk's head, then the item to decide, answered in place. */
const Inspector = ({
  head,
  ref,
  ...frame
}: Frame & { head: ReactNode; ref: RefObject<HTMLDivElement | null> }) => (
  <SidePanelContent>
    <div ref={ref} {...stylex.props(styles.inspector)}>
      {head}
      <ItemDetail key={frame.item.id} {...frame} />
    </div>
  </SidePanelContent>
);

/**
 * The item the panel shows: the one whose answer core refused while it is
 * kept, as it is now if it still waits, else as it was; otherwise the one
 * selected. With where it stands in the list, and whether it waits no
 * more (`gone`: kept, with nothing left to answer).
 */
const shownOf = (
  list: readonly InboxItem[],
  selected: InboxItem | undefined,
  refused: InboxItem | undefined
): { item: InboxItem | undefined; place: number; gone: boolean } => {
  const item =
    refused === undefined
      ? selected
      : (list.find(({ id }) => id === refused.id) ?? refused);
  const place =
    item === undefined ? -1 : list.findIndex(({ id }) => id === item.id);
  return { item, place, gone: item !== undefined && place === -1 };
};

/** An item whose answer core refused, with the row and the group chosen then. */
interface Refused {
  item: InboxItem;
  chosen: string | undefined;
  group: Group;
}

/** The item kept after its answer was refused: while the row and the group chosen then still are. */
const keptOf = (
  refused: Refused | undefined,
  chosen: string | undefined,
  group: Group
): InboxItem | undefined =>
  refused?.chosen === chosen && refused?.group === group
    ? refused?.item
    : undefined;

/**
 * The item selected: the one chosen; once it waits no more, the one that
 * came after it, now in its place, the first after the last (walk.ts).
 * With the address that one takes from then on (`successor`), so a reload
 * opens it again: none while the one chosen still waits, or is kept after
 * a refusal, whose address it still is.
 */
const selectedIn = (
  list: readonly InboxItem[],
  chosen: string | undefined,
  at: number,
  kept: InboxItem | undefined
): { selected: InboxItem | undefined; successor: string | undefined } => {
  const selected =
    list[
      placeIn(
        list.map(({ id }) => id),
        { id: chosen ?? "", index: at }
      )
    ];
  const moved =
    chosen !== undefined &&
    kept === undefined &&
    selected !== undefined &&
    selected.id !== chosen;
  return { selected, successor: moved ? selected.id : undefined };
};

/** Puts `item` in the page's address in place of the one there, once there is one. */
const useAddressOf = (item: string | undefined): void => {
  const navigate = useNavigate();
  useEffect(() => {
    if (item !== undefined) {
      void navigate({
        from: "/inbox",
        to: "/inbox",
        search: (before) => ({ ...before, item }),
        replace: true,
      });
    }
  }, [navigate, item]);
};

/** The panel beside a wide list; on a phone, its sheet, open once a row is chosen. */
const Beside = ({
  wide,
  reading,
  label,
  onBack,
  children,
}: {
  wide: boolean;
  reading: boolean;
  label: string;
  onBack: () => void;
  children: ReactNode;
}) => {
  if (wide) {
    return (
      <SidePanel aria-label={label} style={styles.besideClearOfChat}>
        {children}
      </SidePanel>
    );
  }
  return (
    <Sheet
      onOpenChange={(next) => {
        if (!next) {
          onBack();
        }
      }}
      open={reading}
    >
      <SheetContent side="end">
        <SheetHeader>
          <SheetTitle>{label}</SheetTitle>
        </SheetHeader>
        <SidePanel aria-label={label} framed={false}>
          {children}
        </SidePanel>
      </SheetContent>
    </Sheet>
  );
};

/**
 * The list as the page: no card, what failed to load over it, the groups,
 * the report's row at its head. Empty beside an item kept after it waits
 * no more: nothing else waits.
 */
const ListColumn = ({
  items,
  list,
  current,
  failed,
  selected,
  onOpen,
  foot,
  tail,
}: {
  items: readonly InboxItem[];
  list: readonly InboxItem[];
  current: Group;
  failed: readonly string[];
  selected: InboxItem | undefined;
  onOpen: (id: string, focus: boolean) => void;
  foot: ReactNode;
  tail: ReactNode;
}) => {
  if (list.length === 0) {
    return (
      <div {...stylex.props(inboxStyles.list, inboxStyles.listEmpty)}>
        <NoItems failed={failed} foot={foot ?? tail} />
      </div>
    );
  }
  return (
    <div {...stylex.props(inboxStyles.list)}>
      {failed.map((text) => (
        <Alert key={text} variant="warning">
          <AlertDescription>{text}</AlertDescription>
        </Alert>
      ))}
      <GroupViews current={current} items={items} />
      {foot}
      <ItemList list={list} onOpen={onOpen} selected={selected} />
      {tail}
    </div>
  );
};

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
  // An item whose answer core refused, kept in place with core's reason
  // until the person moves on: read again, it may wait no more (answered
  // elsewhere), and the one after it must not take its place, its answers
  // under the pointer, before the refusal is read. Kept with the row and
  // the group chosen then: once the person chooses another, it goes.
  const [refused, setRefused] = useState<Refused>();
  const kept = keptOf(refused, chosen, group);
  if (refused !== undefined && kept === undefined) {
    setRefused(undefined);
  }
  // The item an answer settled: the one that opens in its place holds its
  // answers back a moment (item-detail.tsx).
  const [answered, setAnswered] = useState<string>();
  // Once an answer is through or refused, focus that fell to the page (the
  // button pressed went with its item, or was turned off) goes to the
  // heading of the item in view: the one after it, or the one kept.
  const panel = useRef<HTMLDivElement>(null);
  const [landed, setLanded] = useState(0);
  useEffect(() => {
    if (landed > 0 && focusFell()) {
      panel.current
        ?.querySelector<HTMLElement>(itemHeading)
        ?.focus({ preventScroll: true });
    }
  }, [landed]);
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
  const { selected, successor } = selectedIn(list, chosen, at, kept);
  useAddressOf(successor);
  const { item: shownItem, place, gone } = shownOf(list, selected, kept);
  // A row was chosen: on a phone its sheet opens.
  const reading = chosen !== undefined && shownItem !== undefined;

  const open = (id: string, focus: boolean) => {
    setRefused(undefined);
    setAnswered(undefined);
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
  // One on or one back, round and round, as the arrows and J and K go.
  // From an item kept after it waits no more: on to the one that came
  // after it, now in its place, or back to the one before.
  const step = (by: 1 | -1) => {
    const from = gone ? at - (by === 1 ? 1 : 0) : place;
    const next = list[stepFrom(list.length, from, by)];
    if (next !== undefined) {
      open(next.id, false);
    }
  };
  const skipShown = () => {
    if (shownItem === undefined || gone) {
      return;
    }
    const after = skip(ids, {
      at: { id: shownItem.id, index: place },
      skipped,
    });
    setSkipped(after.skipped);
    if (after.at !== null) {
      open(after.at.id, false);
    }
  };
  const back = () => {
    setRefused(undefined);
    setAnswered(undefined);
    void navigate({
      from: "/inbox",
      to: "/inbox",
      search: (before) => ({ ...before, item: undefined }),
      replace: true,
    });
  };

  // J and K anywhere on the page, but not while something is typed: the
  // next one and the one before, as the arrows go.
  const onKey = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (
      (event.key !== "j" && event.key !== "k") ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      typing(event.target) ||
      shownItem === undefined
    ) {
      return;
    }
    event.preventDefault();
    step(event.key === "j" ? 1 : -1);
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
  if (shownItem === undefined) {
    return (
      <div {...stylex.props(inboxStyles.page)}>
        <div {...stylex.props(inboxStyles.list, inboxStyles.listEmpty)}>
          <NoItems failed={failed} foot={foot ?? tail} />
        </div>
      </div>
    );
  }
  const label = i18n._(kindLabel[shownItem.kind]);
  return (
    <div {...stylex.props(inboxStyles.page, wide && inboxStyles.pageBeside)}>
      <ListColumn
        current={current}
        failed={failed}
        foot={foot}
        items={items}
        list={list}
        onOpen={open}
        selected={wide || reading ? shownItem : undefined}
        tail={tail}
      />
      <Beside label={label} onBack={back} reading={reading} wide={wide}>
        <Inspector
          ref={panel}
          arriving={answered !== undefined && answered !== shownItem.id}
          gone={gone}
          head={
            <WalkHead
              count={list.length}
              onSkip={skipShown}
              onStep={step}
              place={gone ? undefined : place + 1}
            />
          }
          item={shownItem}
          onLanded={() => {
            setLanded((count) => count + 1);
          }}
          onRefused={() => {
            setRefused({ item: shownItem, chosen, group });
          }}
          onSaid={(said) => {
            // Through at last, after a refusal: kept no longer, the one
            // after it opens in its place.
            setRefused(undefined);
            setAnswered(shownItem.id);
            onSaid(said);
          }}
        />
      </Beside>
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
  /** The item open, by its ID: the list's first when none is; the one after it once it waits no more. */
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
