import type { AuditRecord } from "@grasp-os/shared/audit-log";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Await, Link, useNavigate, useRouter } from "@tanstack/react-router";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";

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
import { Button, useAction } from "../grasp/button/index.ts";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogTitle,
} from "../grasp/dialog/index.ts";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../grasp/empty/index.ts";
import { Agent, ChevronLeft, ChevronRight } from "../grasp/icons/index.ts";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemDetail as ItemNote,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { KeyValueList } from "../grasp/key-value/index.ts";
import { PanelSection } from "../grasp/panel-section/index.ts";
import {
  Panel,
  PanelHeader,
  PanelTexture,
  PanelView,
} from "../grasp/panel/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetTitle,
} from "../grasp/sheet/index.ts";
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
import { orderOf, skip, stepFrom } from "./walk.ts";

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

/** The page's own width at which the list and the item stand side by side; narrower, the item opens in a Sheet. */
const WIDE_REM = 52;

const styles = stylex.create({
  page: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space4,
    width: "100%",
  },
  split: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    alignItems: "start",
    gap: grasp.space4,
  },
  splitWide: {
    gridTemplateColumns: "minmax(18rem, 24rem) minmax(0, 1fr)",
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space3,
    minWidth: 0,
  },
  // The item stays in view while the list beside it scrolls.
  item: {
    position: "sticky",
    top: 0,
    display: "flex",
    flexDirection: "column",
    gap: grasp.space2,
    maxHeight: "calc(100dvh - 6rem)",
    overflowY: "auto",
    minWidth: 0,
    // As wide as the approval card it shows, so the walk's head spans the card.
    maxWidth: grasp.approvalWidth,
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
  // The list as the page's own column, top to bottom.
  pane: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space3,
    minWidth: 0,
    minHeight: "calc(100dvh - 9rem)",
  },
  paneBeside: {
    borderInlineEndWidth: grasp.hairline,
    borderInlineEndStyle: "solid",
    borderInlineEndColor: grasp.line,
    paddingInlineEnd: grasp.space4,
  },
  single: {
    width: "100%",
    maxWidth: "48rem",
    marginInline: "auto",
  },
  splitInspector: {
    gridTemplateColumns: `minmax(0, 1fr) ${grasp.inspectorWidth}`,
  },
  panel: {
    position: "sticky",
    top: 0,
    maxHeight: "calc(100dvh - 7rem)",
  },
  // The one thing to decide, alone beside the list, a little below its top.
  stage: {
    position: "sticky",
    top: 0,
    display: "flex",
    justifyContent: "center",
    minHeight: "calc(100dvh - 9rem)",
    paddingBlockStart: grasp.space10,
    paddingInline: grasp.space6,
    borderRadius: grasp.corner,
    overflow: "hidden",
  },
  // The card and its head stand over the stage's dither.
  overTexture: {
    position: "relative",
  },
  dialogStage: {
    position: "relative",
    padding: grasp.space4,
    borderRadius: grasp.corner,
    overflow: "hidden",
  },
  walkBox: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space2,
    width: "100%",
    maxWidth: grasp.approvalWidth,
  },
  // Nothing waits: the report's row stands under the Empty, at the list's width.
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

/** The Inbox's shapes Ruben chooses between (concept branch only). */
export const concepts = ["a", "b", "c"] as const;
export type Concept = (typeof concepts)[number];

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
      <ItemGroup aria-label={t`What waits on you`} separated>
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

/** What each concept's shape is given: the list, and the walk's head and item. */
interface ShapeProps {
  wide: boolean;
  /** A row was chosen: on a narrow page, or in B, the walk opens over the page. */
  open: boolean;
  selected: InboxItem | undefined;
  onClose: () => void;
  onSaid: (said: string) => void;
  list: ReactNode;
  head: ReactNode;
}

/** The kind of the item shown, as a sheet's or a dialog's title. */
const useKind = (selected: InboxItem | undefined): string => {
  const { i18n } = useLingui();
  return selected === undefined ? "" : i18n._(kindLabel[selected.kind]);
};

/** The item shown, answered in place. */
const Detail = ({ selected, onSaid }: ShapeProps) =>
  selected === undefined ? null : (
    <ItemDetail item={selected} key={selected.id} onSaid={onSaid} />
  );

/** On a narrow page, the walk in a Sheet once a row is chosen. */
const PhoneSheet = (shape: ShapeProps) => {
  const { wide, open, onClose, head } = shape;
  const kind = useKind(shape.selected);
  return !wide && open ? (
    <Sheet
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      open
      size="lg"
    >
      <SheetContent>
        <SheetTitle>{kind}</SheetTitle>
        <SheetBody>
          {head}
          <Detail {...shape} />
        </SheetBody>
      </SheetContent>
    </Sheet>
  ) : null;
};

/**
 * A: the list, and beside it the one thing to decide, alone on the page on
 * the dither, the walk's head above it.
 */
const StageShape = (shape: ShapeProps) => (
  <div {...stylex.props(styles.split, shape.wide && styles.splitWide)}>
    {shape.list}
    {shape.wide ? (
      <div {...stylex.props(styles.stage)}>
        <PanelTexture />
        <div {...stylex.props(styles.walkBox, styles.overTexture)}>
          {shape.head}
          <Detail {...shape} />
        </div>
      </div>
    ) : null}
    <PhoneSheet {...shape} />
  </div>
);

/**
 * B: the list is the page; a row opens the walk in a dialog, to decide one
 * after another without leaving it.
 */
const DialogShape = (shape: ShapeProps) => {
  const { list, open, onClose, head } = shape;
  const kind = useKind(shape.selected);
  return (
    <div {...stylex.props(styles.single)}>
      {list}
      {open ? (
        <Dialog
          onOpenChange={(next) => {
            if (!next) {
              onClose();
            }
          }}
          open
        >
          <DialogContent>
            <DialogTitle>{kind}</DialogTitle>
            <DialogBody>
              <div {...stylex.props(styles.dialogStage)}>
                <PanelTexture />
                <div {...stylex.props(styles.walkBox, styles.overTexture)}>
                  {head}
                  <Detail {...shape} />
                </div>
              </div>
            </DialogBody>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
};

/**
 * C: the list, and beside it an inspector that is always open: the card at
 * its head, what is known about the item in sections under it.
 */
const InspectorShape = (shape: ShapeProps) => {
  const { t } = useLingui();
  const { wide, head, selected } = shape;
  const kind = useKind(selected);
  const facts = selected?.facts ?? [];
  return (
    <div {...stylex.props(styles.split, wide && styles.splitInspector)}>
      {shape.list}
      {wide && selected !== undefined ? (
        <div {...stylex.props(styles.panel)}>
          <Panel aria-label={kind}>
            <PanelHeader actions={head} texture title={kind} />
            <PanelView>
              <PanelSection card={false} label={t`To decide`}>
                <Detail {...shape} />
              </PanelSection>
              {facts.length === 0 ? null : (
                <PanelSection label={t`Facts`}>
                  <KeyValueList
                    items={facts.map(({ label, value }) => ({
                      key: label,
                      value,
                    }))}
                    variant="inline"
                  />
                </PanelSection>
              )}
            </PanelView>
          </Panel>
        </div>
      ) : null}
      <PhoneSheet {...shape} />
    </div>
  );
};

/**
 * The list and, beside it, the walk through it: the item shown with its
 * head. On a narrow page the list stands alone, and a row opens the walk
 * in a Sheet.
 */
const ToDo = ({
  items,
  chosen,
  group,
  notLoaded,
  onSaid,
  wide,
  foot,
  concept,
}: {
  items: readonly InboxItem[];
  chosen: string | undefined;
  /** The group in view, as the address has it (`?group=`). */
  group: Group;
  notLoaded: readonly Loaded<unknown>[];
  onSaid: (said: string) => void;
  /** Whether the page has room for the walk beside the list. */
  wide: boolean;
  /** What stands at the foot of the list's column: the report's row. */
  foot: ReactNode;
  /** Which concept to show (concept branch only). */
  concept: Concept;
}) => {
  const { i18n } = useLingui();
  const navigate = useNavigate();
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
  // On a narrow page the walk opens in a Sheet once a row is chosen.
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

  const failed = notLoaded.flatMap((part) => notLoadedText(part, i18n) ?? []);
  if (items.length === 0) {
    return <NoItems failed={failed} foot={foot} />;
  }
  const beside = wide && concept !== "b";
  const shape: ShapeProps = {
    wide,
    open: reading,
    selected,
    onClose: back,
    onSaid,
    head: (
      <WalkHead
        count={list.length}
        onSkip={skipShown}
        onStep={step}
        place={place + 1}
      />
    ),
    // The list as the page's own full-height column: no card, no tabs (the
    // sidebar's Inbox view is the filter), the report's item at its head.
    list: (
      <div {...stylex.props(styles.pane, beside && styles.paneBeside)}>
        {failed.map((text) => (
          <Alert key={text} variant="attention">
            {text}
          </Alert>
        ))}
        {foot}
        <ItemList
          list={list}
          onOpen={open}
          selected={beside || reading ? selected : undefined}
        />
      </div>
    ),
  };
  if (concept === "b") {
    return <DialogShape {...shape} />;
  }
  return concept === "c" ? (
    <InspectorShape {...shape} />
  ) : (
    <StageShape {...shape} />
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
      {/* Who did it: a person's face, or Grasp's mark for what Grasp and its agents did. */}
      {byGrasp(record) ? (
        <ItemMedia icon={Agent} iconLook="inline" />
      ) : (
        <ItemMedia>
          <Avatar name={actor} size="xs" />
        </ItemMedia>
      )}
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
  activity,
  foot,
  concept,
}: {
  items: readonly InboxItem[];
  /** The item open, by its ID: the list's first when none is, or it waits no more. */
  chosen?: string;
  /** The group in view, as the address has it; all when it has none. */
  group?: Exclude<Group, "all">;
  notLoaded: readonly Loaded<unknown>[];
  activity: Promise<Loaded<InboxActivity>> | undefined;
  /** What stands at the foot of the list's column: the weekly report's row, with a programme. */
  foot?: ReactNode;
  /** A concept to show in place of the current page (concept branch only). */
  concept?: Concept;
}) => {
  const { t, i18n } = useLingui();
  const [said, setSaid] = useState("");
  // Whether the page has room for the walk beside the list, as the
  // library's approvals inbox measures its own screen.
  const page = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    const element = page.current;
    // In rem of 16px, as the library's approvals inbox measures its own.
    const watch = new ResizeObserver(([entry]) => {
      setWide((entry?.contentRect.width ?? 0) >= WIDE_REM * 16);
    });
    if (element !== null) {
      watch.observe(element);
    }
    return () => {
      watch.disconnect();
    };
  }, []);
  const toDo = (
    <ToDo
      chosen={chosen}
      foot={foot}
      group={group ?? "all"}
      items={items}
      notLoaded={notLoaded}
      onSaid={setSaid}
      wide={wide}
      concept={concept ?? "a"}
    />
  );
  return (
    <>
      <SiteHeader crumbs={[{ label: t`Inbox` }]} />
      <div ref={page} {...stylex.props(styles.page)}>
        {/* The concepts have no tabs: the sidebar's Inbox view is the Inbox's navigation. */}
        {activity === undefined || concept !== undefined ? (
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
