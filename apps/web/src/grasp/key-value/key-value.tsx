// Key and value rows: facts about one thing, each a quiet name over its value, as the Grasp product
// shows an account or a workspace's details. Stacked, the name stands above the value; side by side,
// the value stands at the end of the row and drops under the name when the row is too narrow. A
// value can be copied, and an id can be set in the mono face.
//
//   <KeyValueList items={[
//     { key: "Owner", value: "Anna de Vries" },
//     { key: "User ID", value: "usr_4f81c2", mono: true, copy: true },
//   ]} />
//
// Side by side, a row can open in place (a facts rail): with a `detail`, its name is a button that
// shows the detail under the row, one row open at a time, and only the rows below it move. A
// `group` starts after a little room, and a `pending` value waits as Skeleton's dot field at its
// own width, then crossfades in.
//
//   <KeyValueList layout="inline" items={[
//     { key: "Model", value: "Claude Opus", group: "what", detail: <Models /> },
//     { key: "Runs", value: "On request", group: "where", detail: "It answers when someone asks." },
//   ]} />
//
// It is a description list, so a screen reader hears each name with its value. Every value is a
// token (src/tokens).
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  Tooltip as TooltipPrimitive,
  TooltipTrigger as TriggerPrimitive,
} from "@ui-sdk/react/tooltip";
import { useId, useState } from "react";
import type { ReactNode } from "react";

import { CopyButton } from "../button/copy";
import { focus } from "../focus/focus";
import { ChevronDown, Icon } from "../icons";
import type { IconData } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import type { LayoutStyle } from "../layout/layout";
import { Skeleton } from "../skeleton";
import { grasp, media } from "../tokens/tokens.stylex";
import { ms } from "../tokens/tokens.values";
import { TooltipPanel } from "../tooltip";

/** What a caller may style: where it sits and how wide it is. */
export type KeyValueLayoutStyle = LayoutStyle;

/** One fact: its name and its value. */
export interface KeyValueItem {
  /** The name, in a few words ("Owner", "Last active"). */
  key: string;
  /** The value, as words or a node. */
  value: ReactNode;
  /** Set in the mono face, for ids, keys and codes. */
  mono?: boolean;
  /** A button at the end that copies it: `true` copies the value's words, a string copies that. */
  copy?: boolean | string;
  /**
   * What opens under the row, side by side only (`layout="inline"`): the row's name becomes a
   * button that shows it, one row open at a time. Without it, the row is only read.
   */
  detail?: ReactNode;
  /** Names the row for `open` and `onOpenChange`. @default its `key` */
  id?: string;
  /**
   * An icon from src/icons before the name, in the name's muted ink at 1em, on a column of its own.
   * Side by side, a list with icons draws as a facts rail; rows without one keep its room.
   */
  icon?: IconData;
  /** Rows of one group stand together; a row whose group differs from the one before starts after a little room. */
  group?: string;
  /**
   * The value is still on its way: it waits as Skeleton's dot field at the value's width (give a
   * likely value, or it is a short line), then crossfades in. At once with reduced motion.
   * @default false
   */
  pending?: boolean;
}

/** Every prop a KeyValueList takes. */
export interface KeyValueListProps {
  /** The facts, in order. */
  items: readonly KeyValueItem[];
  /**
   * `stacked` puts each name above its value; `inline` puts the value at the end of the row, for a
   * short list in a small space.
   * @default "stacked"
   */
  layout?: "stacked" | "inline";
  /**
   * A line between the rows, for a list that stands on its own.
   * @default false
   */
  divided?: boolean;
  /**
   * What a copy button says: its name, from the fact's name, and what it says once pressed.
   * @default { copy: (name) => `Copy ${name}`, copied: "Copied", failed: "Could not copy" }
   */
  labels?: Partial<KeyValueLabels>;
  /** The row open now, by its `id`, or `null` for none: with `onOpenChange`, the caller keeps it. */
  open?: string | null;
  /** The row open at first, when the list keeps its own. @default null */
  defaultOpen?: string | null;
  /** Called with the row that opens, or `null` when the open one closes. */
  onOpenChange?: (id: string | null) => void;
  /**
   * In a list where a row opens, where each value stands: `end` at the row's end, `start` on one
   * column just after the widest name, close to its name. The chevrons keep to the row's end.
   * @default "end"
   */
  valueAlign?: "end" | "start";
  /**
   * Side by side, how a row with an `icon` shows its name: `shown` beside the icon, or `icon`
   * alone, for a tight rail, with the name as its accessible name and a Tooltip on hover and
   * focus. A row without an icon always shows its name.
   * @default "shown"
   */
  names?: "shown" | "icon";
  /** Layout only: where it sits and how wide it is. */
  style?: KeyValueLayoutStyle;
}

/** The words a copy button says, so the product can say them in its own language. */
export interface KeyValueLabels {
  /** The button's name, from the fact's name ("Copy owner"). */
  copy: (name: string) => string;
  /** What it says once the value is copied. */
  copied: string;
  /** What it says when it could not copy. */
  failed: string;
  /** What a screen reader hears for a value that is still on its way. */
  pending: string;
}

/** Its words in English: replace any of them through `labels`. */
const englishLabels: KeyValueLabels = {
  copy: (name) => `Copy ${name.toLowerCase()}`,
  copied: "Copied",
  failed: "Could not copy",
  pending: "Loading",
};

const styles = stylex.create({
  list: {
    display: "grid",
    minWidth: 0,
    margin: 0,
    fontFamily: grasp.fontSans,
  },
  spaced: {
    rowGap: grasp.space4,
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
  },
  rowDivided: {
    paddingBlock: grasp.space3,
    boxShadow: {
      default: `inset 0 -1px 0 ${grasp.line}`,
      ":last-child": "none",
    },
  },
  pair: {
    flexGrow: 1,
    minWidth: 0,
  },
  // Side by side: the value at the end, and under the name when the row is too narrow for both.
  pairInline: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    justifyContent: "space-between",
    columnGap: grasp.space4,
    rowGap: grasp.space1,
  },
  key: {
    margin: 0,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    fontWeight: grasp.weightMedium,
    color: grasp.muted,
  },
  value: {
    margin: 0,
    marginBlockStart: grasp.space1,
    minWidth: 0,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.ink,
    overflowWrap: "anywhere",
  },
  valueInline: {
    marginBlockStart: 0,
    textAlign: "end",
  },
  mono: {
    fontFamily: grasp.fontMono,
    fontSize: grasp.textXs,
  },

  // ---- A group, and a value on its way ----
  // A new group: a little room above it, more than between its rows.
  groupStart: { marginBlockStart: grasp.space4 },
  // The value and its placeholder in one cell: the placeholder takes the value's width, and the
  // two crossfade. A value with no words yet waits as a short line.
  waits: { display: "inline-grid", minWidth: 0, verticalAlign: "top" },
  waitsEmpty: { minWidth: `calc(${grasp.space12} * 2)` },
  layer: {
    gridArea: "1 / 1",
    minWidth: 0,
    transitionProperty: "opacity, visibility",
    transitionDuration: { default: grasp.durationUi, [media.reduced]: "0s" },
    transitionTimingFunction: grasp.ease,
    transitionBehavior: "allow-discrete",
  },
  gone: { opacity: 0, visibility: "hidden" },
  unseen: {
    position: "absolute",
    width: 1,
    height: 1,
    overflow: "hidden",
    clipPath: "inset(50%)",
    whiteSpace: "nowrap",
  },

  // ---- A facts rail: rows that open in place ----
  rail: { rowGap: grasp.space1 },
  railRow: { display: "grid", minWidth: 0 },
  // The row's head: its name and its value on one line, the whole of it the button's to press.
  head: {
    [iconVars.size]: grasp.iconSm,
    [iconVars.stroke]: grasp.iconStroke,
    position: "relative",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    columnGap: grasp.space4,
    rowGap: grasp.space1,
    boxSizing: "border-box",
    // A finger's 44px on a touch screen.
    minHeight: { default: grasp.controlMd, [media.coarse]: grasp.tap },
    paddingBlock: grasp.space2,
    paddingInline: grasp.space2,
    borderRadius: grasp.cornerMark,
    cornerShape: grasp.cornerShape,
    transitionProperty: "background-color",
    transitionDuration: grasp.durationHover,
    transitionTimingFunction: grasp.ease,
  },
  headLive: {
    backgroundColor: {
      default: "transparent",
      ":has(> dt > button:hover)": {
        default: null,
        [media.hover]: grasp.ghostFillHover,
      },
      ":has(> dt > button:active)": grasp.ghostFillPress,
    },
  },
  headOpen: { backgroundColor: grasp.ghostFillHover },
  // The row's button: the whole head, under the words, so a press anywhere on the row opens it. It
  // is named by the row's name.
  toggle: {
    position: "absolute",
    inset: 0,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    borderRadius: grasp.cornerMark,
    cornerShape: grasp.cornerShape,
    backgroundColor: "transparent",
    cursor: "pointer",
  },
  railKey: {
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    fontWeight: grasp.weightRegular,
  },
  // The name's cell with an icon column: the icon, or its room, then the name.
  named: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space2,
    minWidth: 0,
  },
  mark: {
    [iconVars.size]: "1em",
    display: "inline-flex",
    flexShrink: 0,
    width: "1em",
    color: grasp.muted,
  },
  // An icon alone that names its row: focusable, so its Tooltip opens for the keyboard too.
  markAlone: {
    position: "relative",
    borderRadius: grasp.cornerMark,
    cornerShape: grasp.cornerShape,
  },
  // At the end: the value takes the room left after its name, the chevron's room after it.
  headEnd: { columnGap: grasp.space2 },
  valueEnd: { flexGrow: 1, marginBlockStart: 0, textAlign: "end" },
  // At the start: one grid for the list, the names' column as wide as the widest, every row on it.
  railStart: { gridTemplateColumns: "max-content minmax(0, 1fr) auto" },
  onGrid: {
    display: "grid",
    gridTemplateColumns: "subgrid",
    gridColumn: "1 / -1",
  },
  headStart: { columnGap: grasp.space4 },
  valueStart: { marginBlockStart: 0, textAlign: "start" },
  across: { gridColumn: "1 / -1" },
  // The chevron, or its room in a row that does not open (or not yet): every value ends on one line.
  tail: {
    display: "inline-flex",
    alignItems: "center",
    justifySelf: "end",
    gap: grasp.space2,
  },
  room: { visibility: "hidden" },
  chevron: {
    display: "inline-flex",
    flexShrink: 0,
    color: grasp.muted,
    transitionProperty: "transform",
    transitionDuration: { default: grasp.durationUi, [media.reduced]: "0s" },
    transitionTimingFunction: grasp.ease,
  },
  chevronOpen: { transform: "rotate(0.5turn)" },
  // Over the name's reach: a copy button in an opening row is pressed on its own.
  above: { position: "relative", display: "inline-flex" },
  detail: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space4,
    marginInline: 0,
    marginBlock: grasp.space2,
    paddingBlock: grasp.space4,
    paddingInline: grasp.space4,
    borderWidth: grasp.hairline,
    borderStyle: "solid",
    borderColor: grasp.line,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.text,
  },
});

/** The copy button at the end of a row: it says Copied, or that it could not. */
const CopyValue = ({
  name,
  text,
  labels,
}: {
  name: string;
  text: string;
  labels: KeyValueLabels;
}) => (
  <CopyButton
    text={text}
    label={labels.copy(name)}
    copiedLabel={labels.copied}
    failedLabel={labels.failed}
  />
);

/** The words of a value, for copying: a string or number as it is, anything else not at all. */
const wordsOf = (value: ReactNode) =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";

/** What a row's copy button copies: its own text, its value's words, or nothing. */
const copyText = (copy: string | boolean | undefined, value: ReactNode) => {
  if (typeof copy === "string") {
    return copy;
  }
  return copy === true ? wordsOf(value) : "";
};

/** A value that waits: its placeholder at its width while it is on its way; the two crossfade. */
const Waiting = ({
  item,
  labels,
}: {
  item: KeyValueItem;
  labels: KeyValueLabels;
}) => {
  const waiting = item.pending === true;
  const empty =
    item.value === null || item.value === undefined || item.value === "";
  return (
    <span
      aria-busy={waiting}
      {...stylex.props(styles.waits, waiting && empty && styles.waitsEmpty)}
    >
      <span
        aria-hidden={waiting}
        {...stylex.props(styles.layer, waiting && styles.gone)}
      >
        {item.value}
      </span>
      <span
        aria-hidden="true"
        {...stylex.props(styles.layer, !waiting && styles.gone)}
      >
        <Skeleton />
      </span>
      {waiting ? (
        <span {...stylex.props(styles.unseen)}>{labels.pending}</span>
      ) : null}
    </span>
  );
};

/** Where a row starts: after a little room when its group differs from the row before it. */
const startsGroup = (items: readonly KeyValueItem[], index: number) =>
  index > 0 &&
  items[index]?.group !== undefined &&
  items[index - 1]?.group !== items[index]?.group;

/** One row of a list that can open: its head, and its detail under it while open. */
interface RailRowProps {
  item: KeyValueItem;
  isOpen: boolean;
  starts: boolean;
  start: boolean;
  /** Some row in the list has an icon: every row keeps the icon column's room. */
  icons: boolean;
  names: "shown" | "icon";
  labels: KeyValueLabels;
  onToggle: () => void;
}

/** The icon before a name, or its room in a row without one. */
const Mark = ({ icon }: { icon: IconData | undefined }) => (
  <span
    aria-hidden="true"
    data-slot="key-value-icon"
    {...stylex.props(styles.mark)}
  >
    {icon === undefined ? null : <Icon icon={icon} />}
  </span>
);

/** What a row's button needs: whether it is open, the detail it controls, and its press. */
interface ToggleProps {
  isOpen: boolean;
  detailId: string;
  onToggle: () => void;
}

/** A name shown as its icon alone: the name is its accessible name and a Tooltip. */
const IconName = ({
  name,
  icon,
  opens,
  toggle,
}: {
  name: string;
  icon: IconData;
  opens: boolean;
  toggle: ToggleProps;
}) => {
  const { isOpen, detailId, onToggle } = toggle;
  return (
    <TooltipPrimitive delay={ms.tooltipDelay} type="label">
      <TriggerPrimitive
        render={(trigger: Record<string, unknown>) =>
          opens ? (
            <button
              {...trigger}
              type="button"
              aria-expanded={isOpen}
              aria-controls={isOpen ? detailId : undefined}
              onClick={onToggle}
              {...stylex.props(styles.toggle, focus.ring)}
            />
          ) : (
            <span
              {...trigger}
              // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- an icon from src/icons, drawn as SVG and named by its Tooltip
              role="img"
              // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the icon stands for its row's name, which its Tooltip shows to the keyboard too
              tabIndex={0}
              {...stylex.props(styles.mark, styles.markAlone, focus.ring)}
            >
              <Icon icon={icon} />
            </span>
          )
        }
      />
      <TooltipPanel side="top" align="start">
        {name}
      </TooltipPanel>
    </TooltipPrimitive>
  );
};

/** The row's name: its button when it opens, its icon or the icon's room, and its words. */
const Name = ({
  item,
  opens,
  icons,
  alone,
  keyId,
  toggle,
}: {
  item: KeyValueItem;
  opens: boolean;
  icons: boolean;
  alone: boolean;
  keyId: string;
  toggle: ToggleProps;
}) => {
  const { isOpen, detailId, onToggle } = toggle;
  if (alone && item.icon !== undefined) {
    return (
      <>
        <IconName
          name={item.key}
          icon={item.icon}
          opens={opens}
          toggle={toggle}
        />
        {opens ? <Mark icon={item.icon} /> : null}
      </>
    );
  }
  return (
    <>
      {opens ? (
        <button
          type="button"
          aria-labelledby={keyId}
          aria-expanded={isOpen}
          aria-controls={isOpen ? detailId : undefined}
          onClick={onToggle}
          {...stylex.props(styles.toggle, focus.ring)}
        />
      ) : null}
      {icons ? <Mark icon={item.icon} /> : null}
      <span id={keyId}>{item.key}</span>
    </>
  );
};

/** A row opens when it has a detail and its value has landed. */
const opensOf = (item: KeyValueItem) =>
  item.detail !== undefined && item.pending !== true;

/** The row's end: its chevron, or the chevron's room, so every value ends on one line; and its copy button. */
const Tail = ({
  item,
  opens,
  isOpen,
  labels,
}: {
  item: KeyValueItem;
  opens: boolean;
  isOpen: boolean;
  labels: KeyValueLabels;
}) => {
  const text = copyText(item.copy, item.value);
  return (
    <span {...stylex.props(styles.tail)}>
      <span
        aria-hidden="true"
        data-slot="key-value-chevron"
        {...stylex.props(
          styles.chevron,
          isOpen && styles.chevronOpen,
          !opens && styles.room
        )}
      >
        <Icon icon={ChevronDown} />
      </span>
      {text ? (
        <span {...stylex.props(styles.above)}>
          <CopyValue name={item.key} text={text} labels={labels} />
        </span>
      ) : null}
    </span>
  );
};

const RailRow = ({
  item,
  isOpen,
  starts,
  start,
  icons,
  names,
  labels,
  onToggle,
}: RailRowProps) => {
  const detailId = useId();
  const keyId = useId();
  const opens = opensOf(item);
  const alone = names === "icon" && item.icon !== undefined;
  return (
    <div
      data-slot="key-value-row"
      data-open={isOpen}
      {...stylex.props(
        styles.railRow,
        start && styles.onGrid,
        starts && styles.groupStart
      )}
    >
      <div
        {...stylex.props(
          styles.head,
          start ? [styles.onGrid, styles.headStart] : styles.headEnd,
          opens && styles.headLive,
          isOpen && styles.headOpen
        )}
      >
        <dt
          {...stylex.props(styles.key, styles.railKey, icons && styles.named)}
        >
          <Name
            item={item}
            opens={opens}
            icons={icons}
            alone={alone}
            keyId={keyId}
            toggle={{ isOpen, detailId, onToggle }}
          />
        </dt>
        <dd
          {...stylex.props(
            styles.value,
            start ? styles.valueStart : styles.valueEnd,
            item.mono === true && styles.mono
          )}
        >
          {item.pending === undefined ? (
            item.value
          ) : (
            <Waiting item={item} labels={labels} />
          )}
        </dd>
        <Tail item={item} opens={opens} isOpen={isOpen} labels={labels} />
      </div>
      {isOpen ? (
        <dd
          id={detailId}
          {...stylex.props(styles.detail, start && styles.across)}
        >
          {item.detail}
        </dd>
      ) : null}
    </div>
  );
};

/** Which row is open: the caller's (`open`), or the list's own. One at a time. */
const useOpenRow = (
  open: string | null | undefined,
  defaultOpen: string | null,
  onOpenChange: ((id: string | null) => void) | undefined
) => {
  const [own, setOwn] = useState<string | null>(defaultOpen);
  const current = open === undefined ? own : open;
  const toggle = (id: string) => {
    const next = current === id ? null : id;
    setOwn(next);
    onOpenChange?.(next);
  };
  return [current, toggle] as const;
};

/** The rows of a list that can open in place. */
interface RailProps {
  items: readonly KeyValueItem[];
  labels: KeyValueLabels;
  open: string | null | undefined;
  defaultOpen: string | null;
  onOpenChange: ((id: string | null) => void) | undefined;
  start: boolean;
  names: "shown" | "icon";
  style: KeyValueLayoutStyle | undefined;
}

const Rail = ({
  items,
  labels,
  open,
  defaultOpen,
  onOpenChange,
  start,
  names,
  style,
}: RailProps) => {
  const [current, toggle] = useOpenRow(open, defaultOpen, onOpenChange);
  const icons = items.some((item) => item.icon !== undefined);
  return (
    <dl
      data-slot="key-value"
      data-layout="inline"
      data-value-align={start ? "start" : "end"}
      {...stylex.props(
        styles.list,
        styles.rail,
        start && styles.railStart,
        style
      )}
    >
      {items.map((item, index) => {
        const id = item.id ?? item.key;
        return (
          <RailRow
            key={id}
            item={item}
            isOpen={current === id && opensOf(item)}
            starts={startsGroup(items, index)}
            start={start}
            icons={icons}
            names={names}
            labels={labels}
            onToggle={() => {
              toggle(id);
            }}
          />
        );
      })}
    </dl>
  );
};

export const KeyValueList = ({
  items,
  layout = "stacked",
  divided = false,
  labels: given,
  open,
  defaultOpen = null,
  onOpenChange,
  valueAlign = "end",
  names = "shown",
  style,
}: KeyValueListProps) => {
  const labels = { ...englishLabels, ...given };
  const inline = layout === "inline";
  if (
    inline &&
    items.some((item) => item.detail !== undefined || item.icon !== undefined)
  ) {
    return (
      <Rail
        items={items}
        labels={labels}
        open={open}
        defaultOpen={defaultOpen}
        onOpenChange={onOpenChange}
        start={valueAlign === "start"}
        names={names}
        style={style}
      />
    );
  }
  return (
    <dl
      data-slot="key-value"
      data-layout={layout}
      {...stylex.props(styles.list, !divided && styles.spaced, style)}
    >
      {items.map((item, index) => {
        const text = copyText(item.copy, item.value);
        return (
          <div
            key={item.id ?? item.key}
            {...stylex.props(
              styles.row,
              divided && styles.rowDivided,
              startsGroup(items, index) && styles.groupStart
            )}
          >
            <div {...stylex.props(styles.pair, inline && styles.pairInline)}>
              <dt {...stylex.props(styles.key)}>{item.key}</dt>
              <dd
                {...stylex.props(
                  styles.value,
                  inline && styles.valueInline,
                  item.mono === true && styles.mono
                )}
              >
                {item.pending === undefined ? (
                  item.value
                ) : (
                  <Waiting item={item} labels={labels} />
                )}
              </dd>
            </div>
            {text ? (
              <CopyValue name={item.key} text={text} labels={labels} />
            ) : null}
          </div>
        );
      })}
    </dl>
  );
};
