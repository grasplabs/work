import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { ReactNode } from "react";

import { formatDayMonth } from "../format.ts";
import { PagePanel } from "../frame/page-panel.tsx";
import { SiteHeader } from "../frame/site-header.tsx";
import { useWide } from "../frame/wide.ts";
import { Alert } from "../grasp/alert/index.ts";
import { Avatar, AvatarFallback } from "../grasp/avatar/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import { BrandIcon } from "../grasp/brand-icon/index.ts";
import { Button, useAction } from "../grasp/button/index.ts";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../grasp/empty/index.ts";
import { ChevronLeft, ChevronRight } from "../grasp/icons/index.ts";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemDetail as ItemNote,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { PanelSection } from "../grasp/panel-section/index.ts";
import { Panel, PanelView } from "../grasp/panel/index.ts";
import { RowList, RowListItem } from "../grasp/row-list/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { notLoadedText } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { brandOf } from "./brand-of.ts";
import { kindLabel, kindMark } from "./inbox-kind.tsx";
import { ItemDetail } from "./item-detail.tsx";
import { groupOf, listed } from "./items.ts";
import type { Group, InboxItem } from "./items.ts";
import { orderOf, skip, stepFrom } from "./walk.ts";

// The Inbox, on Grasp UI: what waits on the person, to work through
// quickly. The list is the page, in the shell's own room; its inspector is
// the shell's page panel (frame/page-panel.tsx), always open beside a wide
// page: the walk through what waits at its head ("1 of 3", back, next,
// Skip), the item to decide, then its facts (Ruben's pick, 18 November). On
// a phone the list stands alone and a row opens the panel as the shell's
// sheet. The open item is the page's address (`?item=<id>`), so a link, Back
// and a reload keep it; J and K (or the arrow keys in the list) go to the
// next and the one before; a settled item leaves the list and the one after
// it opens in its place. No tabs: the sidebar's Inbox view is the Inbox's
// filter, and what happened is Settings' audit trail. The weekly report
// stands at the head of the list once it is ready. Items come from items.ts.
//
// The shell unmounts the panel's content while the panel has given way to
// the docked chat or its sheet is closed: where the walk stands, what was
// skipped and what was said are the page's, kept here. The panel keeps only
// what an item keeps until it is stepped away from (an answer being typed).

const styles = stylex.create({
  // The list, the page itself, in the shell's room.
  list: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space3,
    width: "100%",
    minWidth: 0,
  },
  // Nothing in the list: its state in the middle of the page.
  listEmpty: {
    flexGrow: 1,
    justifyContent: "center",
  },
  // The walk's head: where in what waits the item is, between its arrows, and Skip apart.
  walk: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space1,
  },
  place: {
    fontVariantNumeric: "tabular-nums",
  },
  skip: {
    marginInlineStart: "auto",
  },
  // Nothing waits: the report's item stands under the Empty, at a list's width.
  emptyFoot: {
    width: "100%",
    maxWidth: "24rem",
    marginInline: "auto",
  },
  unseen: {
    position: "absolute",
    width: grasp.hairline,
    height: grasp.hairline,
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
  },
});

/**
 * The groups, short enough that the filter fits beside the list. The
 * sidebar's Inbox view names its rows by these too.
 */
export const groupLabel: Record<Group, MessageDescriptor> = {
  all: msg({ message: "All", context: "inbox filter, short" }),
  asked: msg({ message: "Asked of you", context: "inbox filter" }),
  brain: msg({ message: "Brain", context: "inbox filter, short" }),
  approvals: msg({ message: "Approvals", context: "inbox filter" }),
  outcomes: msg({
    message: "Changes we couldn’t confirm",
    context: "inbox filter",
  }),
};

/** The groups in the filter's order; the address (`?group=`) takes these. */
// Workflows' and Apps' asks are one group, Approvals (Ruben, 17 November).
export const groupOrder = ["asked", "brain", "approvals", "outcomes"] as const;

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
      <ItemGroup aria-label={t`What waits on you`}>
        {list.map((item) => (
          <Item
            current={item.id === selected?.id}
            key={item.id}
            render={
              <Link
                from="/inbox"
                replace
                search={(before) => ({ ...before, item: item.id })}
                to="/inbox"
              />
            }
            size="xs"
          >
            {item.face === undefined ? (
              <ItemMedia icon={kindMark[item.kind]} iconLook="inline" />
            ) : (
              <ItemMedia>
                <Avatar name={item.face} size="xs">
                  <AvatarFallback />
                </Avatar>
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
  // Nothing loaded: Try again reads the inbox again, and works until it has.
  const retry = useAction(
    async () => {
      await router.invalidate({ sync: true });
    },
    { working: t`Trying again…`, done: t`Loaded`, failed: t`Not loaded` }
  );
  if (failed.length === 0) {
    return (
      <>
        <Empty size="lg">
          <EmptyHeader>
            <EmptyMedia picture="done" />
            <EmptyTitle>{t`Nothing waits for you`}</EmptyTitle>
          </EmptyHeader>
        </Empty>
        {foot === undefined ? null : (
          <div {...stylex.props(styles.emptyFoot)}>{foot}</div>
        )}
      </>
    );
  }
  return (
    <Empty size="lg" tone="danger">
      <EmptyHeader>
        <EmptyMedia />
        <EmptyTitle>{t`The inbox didn't load`}</EmptyTitle>
        <EmptyDescription>{failed.join(" ")}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="ink" {...retry.props}>
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
        icon={ChevronLeft}
        onClick={() => {
          onStep(-1);
        }}
        size="sm"
        variant="ghost"
      />
      <span {...stylex.props(styles.place)}>
        <Text element="span" size="sm" tone="muted">
          <Trans>
            {place} of {count}
          </Trans>
        </Text>
      </span>
      <Button
        aria-label={t`The next one`}
        icon={ChevronRight}
        onClick={() => {
          onStep(1);
        }}
        size="sm"
        variant="ghost"
      />
      {/* Skipping is no answer: it stands apart from the item's own. */}
      <Button layout={styles.skip} onClick={onSkip} size="sm" variant="ghost">
        <Trans context="put a to-do card at the back of the pile">Skip</Trans>
      </Button>
    </div>
  );
};

/**
 * What the shell's page panel holds: the walk's head, the item to decide,
 * answered in place, then what is known about it.
 */
const Inspector = ({
  selected,
  head,
  onSaid,
}: {
  selected: InboxItem;
  /** The walk through what waits. */
  head: ReactNode;
  onSaid: (said: string) => void;
}) => {
  const { t } = useLingui();
  return (
    // No name of its own: the shell names the panel, and its sheet, by the item's kind.
    <Panel framed={false}>
      <PanelView>
        {/* In the view, not a PanelHeader: a header with only actions keeps an empty room and a line under its bar. */}
        {head}
        {/* The request is the one title here: the row already names its kind. */}
        <ItemDetail item={selected} key={selected.id} onSaid={onSaid} />
        {selected.facts.length === 0 ? null : (
          <PanelSection label={t`Facts`}>
            <RowList aria-label={t`Facts`} noActions>
              {selected.facts.map(({ label, value }) => (
                <RowListItem detail={label} key={label} name={value} />
              ))}
            </RowList>
          </PanelSection>
        )}
      </PanelView>
    </Panel>
  );
};

/**
 * Whether the page asks its panel open, as the shell takes it: open once a
 * row is chosen, which opens its sheet on a phone and sends a docked chat
 * floating; closed once it gave way to the docked chat or its sheet was
 * closed; else the shell's own (open beside a wide page, a closed sheet on
 * a phone).
 */
const panelOpen = (reading: boolean, gaveWay: boolean): boolean | undefined => {
  if (reading) {
    return true;
  }
  return gaveWay ? false : undefined;
};

/**
 * The list and, in the shell's page panel, the walk through it: the item
 * shown with its head. On a phone the list stands alone, and a row opens
 * the panel as a sheet.
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
  // Only for which row is marked: the shell decides where the panel stands.
  const wide = useWide();
  // The panel gave way to the docked chat, or its sheet was closed: it
  // stays away until a row is chosen.
  const [gaveWay, setGaveWay] = useState(false);
  // Where the open item stood, so the one after it opens once it is settled.
  const [at, setAt] = useState(0);
  // What was skipped this visit, last skipped last: it waits at the back.
  const [skipped, setSkipped] = useState<readonly string[]>([]);
  const counts = new Map<Group, number>();
  for (const item of items) {
    const each = groupOf[item.kind];
    counts.set(each, (counts.get(each) ?? 0) + 1);
  }
  // A group that has emptied falls back to everything.
  const current = group === "all" || counts.has(group) ? group : "all";
  const inGroup = listed(items, current, "urgent");
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
  // A row was chosen: the panel is asked open, on a phone as its sheet.
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
      <div {...stylex.props(styles.list, styles.listEmpty)}>
        <NoItems failed={failed} foot={foot ?? tail} />
      </div>
    );
  }
  // The row of the item the panel shows; none while the panel is away.
  const shown = reading || (wide && !gaveWay);
  return (
    <>
      {/* The list as the page: no card, no tabs (the sidebar's Inbox view
          is the filter), the report's item at its head. */}
      <div {...stylex.props(styles.list)}>
        {failed.map((text) => (
          <Alert key={text} tone="attention">
            {text}
          </Alert>
        ))}
        {foot}
        <ItemList
          list={list}
          onOpen={open}
          selected={shown ? selected : undefined}
        />
        {tail}
      </div>
      {selected === undefined ? null : (
        <PagePanel
          label={i18n._(kindLabel[selected.kind])}
          onOpenChange={(next) => {
            // The chat docked, or the sheet was closed: the item is open no more.
            if (!next) {
              setGaveWay(true);
              back();
            }
          }}
          open={panelOpen(reading, gaveWay)}
        >
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
        </PagePanel>
      )}
    </>
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
  const { t } = useLingui();
  const [said, setSaid] = useState("");
  return (
    <>
      <SiteHeader crumbs={[{ label: t`Inbox` }]} />
      <ToDo
        chosen={chosen}
        foot={foot}
        group={group ?? "all"}
        tail={tail}
        items={items}
        notLoaded={notLoaded}
        onSaid={setSaid}
      />
      {/* What was done with an item, for a screen reader: the list only loses it. */}
      <output {...stylex.props(styles.unseen)}>{said}</output>
    </>
  );
};
