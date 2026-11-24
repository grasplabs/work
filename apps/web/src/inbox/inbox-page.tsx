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
  ItemDetail as ItemNote,
  ItemSeparator,
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
  SidePanelSection,
} from "@grasp-os/ui/components/side-panel";
import { Text } from "@grasp-os/ui/components/text";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  Icon,
} from "@grasp-os/ui/lib/icons";
import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { Fragment, useEffect, useEffectEvent, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";

import { formatDayMonth } from "../format.ts";
import { SiteHeader } from "../frame/site-header.tsx";
import { useWide } from "../frame/wide.ts";
import { notLoadedText } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { kindLabel, kindMark } from "./inbox-kind.tsx";
import { inboxStyles } from "./inbox-styles.ts";
import { ItemDetail } from "./item-detail.tsx";
import type { Frame } from "./item-detail.tsx";
import type { InboxItem } from "./items.ts";
import { orderOf, placeIn, skip, stepFrom } from "./walk.ts";

// The Inbox, on Damsko, laid out as #2503's: what waits on the person, to
// work through quickly. The list is the page, under its bar; beside a wide
// list, flush with the card's end from the bar's top down, Damsko's side
// panel holds the walk through what waits at its head ("1 of 3", back,
// next, Skip), the item to decide, then its facts. On a phone the list
// stands alone and a row opens the panel in a sheet. The open item is the
// page's address (`?item=<id>`), so a link, Back and a reload keep it; J
// and K (or the arrow keys in the list) go to the next and the one before;
// a settled item leaves the list and the one after it opens in its place.
// No tabs: what happened is Settings' audit trail. The weekly report stands
// at the head of the list once it is ready, quietly under it on other
// days. Items come from items.ts.

const styles = stylex.create({
  // The walk's head: where in what waits the item is, between its arrows, and Skip apart.
  walk: {
    display: "flex",
    alignItems: "center",
    gap: space["1"],
  },
  place: { fontVariantNumeric: "tabular-nums" },
  skip: { marginInlineStart: "auto" },
  // The panel's parts stand as its own children, its gap between them.
  inspector: { display: "contents" },
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
                    <ItemNote>
                      <Badge size="sm" variant="warning">
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
            </Link>
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

/** An item's heading: an approval's title (approval-request.tsx), or a card's (item-detail.tsx). */
const itemHeading = "[data-item-heading]";

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

/** What is known about the item, in the panel under it: each fact, its label at the row's end. */
const Facts = ({ item }: { item: InboxItem }) => {
  const { t } = useLingui();
  if (item.facts.length === 0) {
    return null;
  }
  return (
    <SidePanelSection title={t`Facts`}>
      <ItemGroup aria-label={t`Facts`}>
        {item.facts.map(({ label, value }, index) => (
          <Fragment key={label}>
            {index === 0 ? null : <ItemSeparator />}
            <Item size="xs">
              <ItemContent>
                <ItemTitle>
                  {value}
                  <ItemNote>{label}</ItemNote>
                </ItemTitle>
              </ItemContent>
            </Item>
          </Fragment>
        ))}
      </ItemGroup>
    </SidePanelSection>
  );
};

/**
 * The panel's content: the walk's head, the item to decide, answered in
 * place, then what is known about it. One element holds them for the
 * focus to find the item's heading in, laid out as the panel's own.
 */
const Inspector = ({
  head,
  ref,
  ...frame
}: Frame & { head: ReactNode; ref: RefObject<HTMLDivElement | null> }) => (
  <SidePanelContent>
    <div ref={ref} {...stylex.props(styles.inspector)}>
      {head}
      <ItemDetail key={frame.item.id} {...frame} />
      <Facts item={frame.item} />
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

/** An item whose answer core refused, with the row chosen then. */
interface Refused {
  item: InboxItem;
  chosen: string | undefined;
}

/** The item kept after its answer was refused: while the row chosen then still is. */
const keptOf = (
  refused: Refused | undefined,
  chosen: string | undefined
): InboxItem | undefined =>
  refused?.chosen === chosen ? refused?.item : undefined;

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
      <div {...stylex.props(inboxStyles.panel)}>
        <SidePanel aria-label={label} framed={false}>
          {children}
        </SidePanel>
      </div>
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

/** The page's own column: its bar, named Inbox, then what stands under it. */
const PageColumn = ({ children }: { children: ReactNode }) => {
  const { t } = useLingui();
  return (
    <div {...stylex.props(inboxStyles.column)}>
      <SiteHeader crumbs={[{ label: t`Inbox` }]} />
      {children}
    </div>
  );
};

/**
 * The list as the page, under its bar: no card, no tabs, what failed to
 * load over it, the report's row at its head. Empty beside an item kept
 * after it waits no more: nothing else waits.
 */
const ListColumn = ({
  list,
  failed,
  selected,
  onOpen,
  foot,
  tail,
}: {
  list: readonly InboxItem[];
  failed: readonly string[];
  selected: InboxItem | undefined;
  onOpen: (id: string, focus: boolean) => void;
  foot: ReactNode;
  tail: ReactNode;
}) => {
  if (list.length === 0) {
    return (
      <PageColumn>
        <div {...stylex.props(inboxStyles.list, inboxStyles.listEmpty)}>
          <NoItems failed={failed} foot={foot ?? tail} />
        </div>
      </PageColumn>
    );
  }
  return (
    <PageColumn>
      <div {...stylex.props(inboxStyles.list)}>
        {failed.map((text) => (
          <Alert key={text} variant="warning">
            <AlertDescription>{text}</AlertDescription>
          </Alert>
        ))}
        {foot}
        <ItemList list={list} onOpen={onOpen} selected={selected} />
        {tail}
      </div>
    </PageColumn>
  );
};

/**
 * The list and, beside it or in a sheet, the walk through it: the item
 * shown with its head.
 */
const ToDo = ({
  items,
  chosen,
  notLoaded,
  onSaid,
  foot,
  tail,
}: {
  items: readonly InboxItem[];
  chosen: string | undefined;
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
  // under the pointer, before the refusal is read. Kept with the row chosen
  // then: once the person chooses another, it goes.
  const [refused, setRefused] = useState<Refused>();
  const kept = keptOf(refused, chosen);
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
  const ids = items.map(({ id }) => id);
  const list = orderOf(ids, skipped).flatMap(
    (id) => items.find((item) => item.id === id) ?? []
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
        <PageColumn>
          <div {...stylex.props(inboxStyles.list, inboxStyles.listEmpty)}>
            <NoItems failed={failed} foot={foot ?? tail} />
          </div>
        </PageColumn>
      </div>
    );
  }
  const label = i18n._(kindLabel[shownItem.kind]);
  return (
    <div {...stylex.props(inboxStyles.page, wide && inboxStyles.pageBeside)}>
      <ListColumn
        failed={failed}
        foot={foot}
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
            setRefused({ item: shownItem, chosen });
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
  notLoaded,
  foot,
  tail,
}: {
  items: readonly InboxItem[];
  /** The item open, by its ID: the list's first when none is; the one after it once it waits no more. */
  chosen?: string;
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
