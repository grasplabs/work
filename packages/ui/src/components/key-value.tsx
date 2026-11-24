// KeyValueList: facts about one thing, each a quiet name and its value, as a description list (`dl`,
// `dt`, `dd`), so a screen reader hears each name with its value. Vertical, the name stands above
// the value; horizontal, the value stands at the end of the row and drops under the name when the
// row is too narrow. A value can be copied (CopyButton), and an id can be set in the mono face.
//
//   <KeyValueList items={[
//     { id: "owner", label: "Owner", value: "Anna de Vries" },
//     { id: "user", label: "User ID", value: "usr_4f81c2", mono: true, copyable: true },
//   ]} />
//
// Horizontal, a row can open in place (a facts rail): with a `detail`, the row is a Collapsible
// whose trigger is the row's name, a button over the whole row, and whose panel holds the detail.
// The list keeps which row is open, so one is open at a time, and only the rows below it move. A
// `group` starts after a little room, and a `loading` value waits as Skeleton's dot field at its
// own width, then crossfades in.
//
//   <KeyValueList orientation="horizontal" items={[
//     { id: "model", label: "Model", value: "Large", group: "what", detail: <Models /> },
//     { id: "runs", label: "Runs", value: "On request", group: "where", detail: "It answers when asked." },
//   ]} />
//
// Every value is a token. A caller may set layout only (the `style` prop).
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  Tooltip as TooltipPrimitive,
  TooltipTrigger as TriggerPrimitive,
} from "@ui-sdk/react/tooltip";
import { useId, useState } from "react";
import type { ReactNode } from "react";

import { useI18n } from "../lib/i18n";
import type { I18nCatalog } from "../lib/i18n";
import { ChevronDownIcon, Icon } from "../lib/icons";
import type { IconData } from "../lib/icons";
import { disclosureStyles, focusRing, visuallyHidden } from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  size,
  space,
} from "../lib/tokens.stylex";
import { durations } from "../lib/tokens.values";
import type { LayoutStyle } from "../lib/utils";
import { iconVars, motionVars } from "../lib/vars.stylex";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./collapsible";
import { CopyButton } from "./copy-button";
import { Skeleton } from "./skeleton";
import { TooltipContent } from "./tooltip";

/** One fact: its name and its value. */
export interface KeyValueItem {
  /** Names the row: its React key, and the open row for `value` and `onValueChange`. */
  id: string;
  /** The name, in a few words ("Owner", "Last active"). */
  label: string;
  /** The value, as words or a node. */
  value: ReactNode;
  /**
   * An icon before the name, in the name's muted ink at 1em, on a column of its own. Horizontal, a
   * list with icons draws as a facts rail; rows without one keep its room.
   */
  icon?: IconData;
  /** A CopyButton at the end that copies it: `true` copies the value's words, a string copies that. */
  copyable?: boolean | string;
  /**
   * The value is still on its way: it waits as Skeleton's dot field at the value's width (give a
   * likely value, or it is a short line), then crossfades in. At once with reduced motion.
   * @default false
   */
  loading?: boolean;
  /**
   * What opens under the row, horizontal only: the row's name becomes a button that shows it, one
   * row open at a time. Without it, the row is only read.
   */
  detail?: ReactNode;
  /** Rows of one group stand together; a row whose group differs from the one before starts after a little room. */
  group?: string;
  /** Set in the mono face, for ids, keys and codes. */
  mono?: boolean;
}

/** The words a KeyValueList says itself, by the I18nProvider's `keyValue` part. */
export type KeyValueLabels = I18nCatalog["keyValue"];

/** Every prop a KeyValueList takes. */
export interface KeyValueListProps {
  /** The facts, in order. */
  items: readonly KeyValueItem[];
  /**
   * `vertical` puts each name above its value; `horizontal` puts the value at the end of the row,
   * for a short list in a small space, or a facts rail.
   * @default "vertical"
   */
  orientation?: "vertical" | "horizontal";
  /**
   * A line between the rows, for a list that stands on its own.
   * @default false
   */
  divided?: boolean;
  /** The row open now, by its `id`, or `null` for none: with `onValueChange`, the caller keeps it. */
  value?: string | null;
  /**
   * The row open at first, when the list keeps its own.
   * @default null
   */
  defaultValue?: string | null;
  /** Called with the row that opens, or `null` when the open one closes. */
  onValueChange?: (id: string | null) => void;
  /**
   * In a list where a row opens, where each value stands: `end` at the row's end, `start` on one
   * column just after the widest name, close to its name. The chevrons keep to the row's end.
   * @default "end"
   */
  valueAlign?: "end" | "start";
  /**
   * Horizontal, how a row with an `icon` shows its name: `text` beside the icon, or `icon` alone,
   * for a tight rail, with the name as its accessible name and a Tooltip on hover and focus. A row
   * without an icon always shows its name.
   * @default "text"
   */
  labelDisplay?: "text" | "icon";
  /** Layout only: where it sits and how wide it is. */
  style?: LayoutStyle;
}

const styles = stylex.create({
  list: {
    display: "grid",
    minWidth: 0,
    margin: 0,
    fontFamily: font.sans,
  },
  spaced: {
    rowGap: space[4],
  },
  // A row is a `div` of one `dt` and its `dd`, as a description list allows: the name above the
  // value, or beside it.
  row: {
    position: "relative",
    minWidth: 0,
  },
  rowDivided: {
    paddingBlock: space[3],
    boxShadow: {
      default: `inset 0 -1px 0 ${colors.border}`,
      ":last-child": "none",
    },
  },
  // Horizontal: the value at the end, and under the name when the row is too narrow for both.
  rowHorizontal: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    justifyContent: "space-between",
    columnGap: space[4],
    rowGap: space[1],
  },
  // A value that can be copied: its CopyButton stands at the row's end, on the middle of the name
  // and the value together, in room the row keeps for it.
  rowCopyable: {
    paddingInlineEnd: `calc(${size.controlSm} + ${space[2]})`,
  },
  copy: {
    position: "absolute",
    insetInlineEnd: 0,
    top: "50%",
    display: "inline-flex",
    transform: "translateY(-50%)",
  },
  label: {
    margin: 0,
    fontSize: font.textXs,
    lineHeight: font.textXsLine,
    fontWeight: font.weightMedium,
    color: colors.mutedForeground,
  },
  value: {
    margin: 0,
    marginBlockStart: space[1],
    minWidth: 0,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.foreground,
    overflowWrap: "anywhere",
  },
  valueHorizontal: {
    marginBlockStart: 0,
    textAlign: "end",
  },
  mono: {
    fontFamily: font.mono,
    fontSize: font.textXs,
  },

  // ---- A group, and a value on its way ----
  // A new group: a little room above it, more than between its rows.
  groupStart: { marginBlockStart: space[4] },
  // The value and its placeholder in one cell: the placeholder takes the value's width, and the
  // two crossfade. A value with no words yet waits as a short line.
  waits: { display: "inline-grid", minWidth: 0, verticalAlign: "top" },
  waitsEmpty: { minWidth: `calc(${space[12]} * 2)` },
  layer: {
    gridArea: "1 / 1",
    minWidth: 0,
    transitionProperty: "opacity, visibility",
    transitionDuration: motionVars.ui,
    transitionTimingFunction: duration.ease,
    transitionBehavior: "allow-discrete",
  },
  gone: { opacity: 0, visibility: "hidden" },

  // ---- A facts rail: rows that open in place ----
  rail: { rowGap: space[1] },
  // Room a stretched list gives a row goes to its head, never to a closed detail's panel.
  railRow: { display: "grid", gridTemplateRows: "1fr auto", minWidth: 0 },
  // The row's head: its name and its value on one line, the whole of it the button's to press.
  head: {
    [iconVars.size]: size.iconSm,
    [iconVars.stroke]: size.iconStroke,
    position: "relative",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    columnGap: space[4],
    rowGap: space[1],
    boxSizing: "border-box",
    // A finger's 44px on a touch screen.
    minHeight: {
      default: size.controlDefault,
      [media.pointerCoarse]: size.tapTarget,
    },
    paddingBlock: space[2],
    paddingInline: space[2],
  },
  // The row's button, the Collapsible's trigger: the whole head, under the words, so a press
  // anywhere on the row opens it. It is named by the row's name, and wears the disclosure's quiet
  // fill (disclosureStyles.ghost) on a row's corner.
  toggle: {
    position: "absolute",
    inset: 0,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    borderRadius: `min(${radius.lg}, calc(${size.controlDefault} / 2))`,
    cornerShape: radius.shape,
    cursor: "pointer",
    transitionProperty: "background-color",
    transitionDuration: duration.hover,
    transitionTimingFunction: duration.ease,
  },
  // The hover's fill stays while the row is open.
  toggleOpen: { backgroundColor: colors.accent },
  // The words of a row that opens: drawn over its button, and a press on them goes through to it.
  over: { position: "relative", pointerEvents: "none" },
  railLabel: {
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    fontWeight: font.weightNormal,
  },
  // The name's cell with an icon column: the icon, or its room, then the name.
  named: {
    display: "flex",
    alignItems: "center",
    gap: space[2],
    minWidth: 0,
  },
  mark: {
    [iconVars.size]: "1em",
    display: "inline-flex",
    flexShrink: 0,
    width: "1em",
    color: colors.mutedForeground,
  },
  // An icon alone that names its row: focusable, so its Tooltip opens for the keyboard too.
  markAlone: {
    position: "relative",
    borderRadius: radius.sm,
    cornerShape: radius.shape,
  },
  // At the end: the value takes the room left after its name, the chevron's room after it.
  headEnd: { columnGap: space[2] },
  valueEnd: { flexGrow: 1, marginBlockStart: 0, textAlign: "end" },
  // At the start: one grid for the list, the names' column as wide as the widest, every row on it.
  railStart: { gridTemplateColumns: "max-content minmax(0, 1fr) auto" },
  onGrid: {
    display: "grid",
    gridTemplateColumns: "subgrid",
    gridColumn: "1 / -1",
  },
  headStart: { columnGap: space[4] },
  valueStart: { marginBlockStart: 0, textAlign: "start" },
  across: { gridColumn: "1 / -1" },
  // Where the detail's panel stands in the row.
  under: { minWidth: 0 },
  // The chevron, or its room in a row that does not open (or not yet): every value ends on one line.
  tail: {
    display: "inline-flex",
    alignItems: "center",
    justifySelf: "end",
    gap: space[2],
  },
  room: { visibility: "hidden" },
  chevron: { color: colors.mutedForeground },
  // Over the name's reach: a copy button in an opening row is pressed on its own.
  above: { position: "relative", display: "inline-flex" },
  // The detail, in the Collapsible's panel, which keeps it a step off the row above and below.
  detail: {
    display: "flex",
    flexDirection: "column",
    gap: space[4],
    margin: 0,
    paddingBlock: space[4],
    paddingInline: space[4],
    borderWidth: size.hairline,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radius.xl,
    cornerShape: radius.shape,
    fontSize: font.textSm,
    lineHeight: font.textSmLine,
    color: colors.bodyForeground,
  },
});

/** The words of a value, for copying: a string or number as it is, anything else not at all. */
const plainText = (value: ReactNode) =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";

/** What a row's copy button copies: its own text, its value's words, or nothing. */
const copyText = (copyable: string | boolean | undefined, value: ReactNode) => {
  if (typeof copyable === "string") {
    return copyable;
  }
  return copyable === true ? plainText(value) : "";
};

/** A row's CopyButton, named for its fact ("Copy email"), so the buttons of one list are told apart. */
const CopyValue = ({ label, text }: { label: string; text: string }) => {
  const { keyValue: words } = useI18n();
  return <CopyButton value={text} aria-label={words.copy(label)} />;
};

/** A value that waits: its placeholder at its width while it is on its way; the two crossfade. */
const Waiting = ({ item }: { item: KeyValueItem }) => {
  const { keyValue: words } = useI18n();
  const waiting = item.loading === true;
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
        <span {...stylex.props(visuallyHidden)}>{words.loading}</span>
      ) : null}
    </span>
  );
};

/** The value as given, or, for a row that may wait, the value and its placeholder. */
const ValueOf = ({ item }: { item: KeyValueItem }): ReactNode =>
  item.loading === undefined ? item.value : <Waiting item={item} />;

/** Where a row starts: after a little room when its group differs from the row before it. */
const startsGroup = (items: readonly KeyValueItem[], index: number) =>
  index > 0 &&
  items[index]?.group !== undefined &&
  items[index - 1]?.group !== items[index]?.group;

/** The icon before a name, or its room in a row without one. */
const Mark = ({ icon }: { icon: IconData | undefined }) => (
  <span
    aria-hidden="true"
    data-slot="key-value-icon"
    {...stylex.props(styles.mark, styles.over)}
  >
    {icon === undefined ? null : <Icon icon={icon} />}
  </span>
);

/** The row's button: the Collapsible's trigger, over the whole head. */
const Toggle = ({
  isOpen,
  ...props
}: { isOpen: boolean } & Record<string, unknown>) => (
  <CollapsibleTrigger asChild>
    <button
      {...props}
      type="button"
      {...stylex.props(
        styles.toggle,
        disclosureStyles.ghost,
        isOpen && styles.toggleOpen,
        focusRing
      )}
    />
  </CollapsibleTrigger>
);

/** A name shown as its icon alone: the name is its accessible name, shown in a Tooltip. */
const IconLabel = ({
  label,
  icon,
  opens,
  isOpen,
}: {
  label: string;
  icon: IconData;
  opens: boolean;
  isOpen: boolean;
}) => (
  // UI SDK's Tooltip as a label: the icon has no name of its own, so the tooltip's words are it.
  <TooltipPrimitive delay={durations.tooltipDelay} type="label">
    <TriggerPrimitive
      render={(trigger: Record<string, unknown>) =>
        opens ? (
          <Toggle {...trigger} isOpen={isOpen} />
        ) : (
          <span
            {...trigger}
            // An icon, drawn as SVG and named by its Tooltip.
            role="img"
            // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the icon stands for its row's name, which its Tooltip shows to the keyboard too
            tabIndex={0}
            {...stylex.props(styles.mark, styles.markAlone, focusRing)}
          >
            <Icon icon={icon} />
          </span>
        )
      }
    />
    <TooltipContent side="top" align="start">
      {label}
    </TooltipContent>
  </TooltipPrimitive>
);

/** The row's name: its button when it opens, its icon or the icon's room, and its words. */
const Label = ({
  item,
  opens,
  isOpen,
  icons,
  alone,
}: {
  item: KeyValueItem;
  opens: boolean;
  isOpen: boolean;
  icons: boolean;
  alone: boolean;
}) => {
  const labelId = useId();
  if (alone && item.icon !== undefined) {
    return (
      <>
        <IconLabel
          label={item.label}
          icon={item.icon}
          opens={opens}
          isOpen={isOpen}
        />
        {opens ? <Mark icon={item.icon} /> : null}
      </>
    );
  }
  return (
    <>
      {opens ? <Toggle aria-labelledby={labelId} isOpen={isOpen} /> : null}
      {icons ? <Mark icon={item.icon} /> : null}
      <span id={labelId} {...stylex.props(opens && styles.over)}>
        {item.label}
      </span>
    </>
  );
};

/** A row opens when it has a detail and its value has landed. */
const opensOf = (item: KeyValueItem) =>
  item.detail !== undefined && item.loading !== true;

/** The row's end: its chevron, or the chevron's room, so every value ends on one line; and its copy button. */
const Tail = ({
  item,
  opens,
  isOpen,
}: {
  item: KeyValueItem;
  opens: boolean;
  isOpen: boolean;
}) => {
  const text = copyText(item.copyable, item.value);
  return (
    <span {...stylex.props(styles.tail)}>
      <span
        aria-hidden="true"
        data-slot="key-value-chevron"
        {...stylex.props(
          disclosureStyles.chevron,
          styles.chevron,
          styles.over,
          isOpen && disclosureStyles.chevronOpen,
          !opens && styles.room
        )}
      >
        <Icon icon={ChevronDownIcon} />
      </span>
      {text ? (
        <span {...stylex.props(styles.above)}>
          <CopyValue label={item.label} text={text} />
        </span>
      ) : null}
    </span>
  );
};

/** One row of a list that can open: its head, and, when it has a detail, the panel under it. */
interface RailRowProps {
  item: KeyValueItem;
  isOpen: boolean;
  starts: boolean;
  start: boolean;
  /** Some row in the list has an icon: every row keeps the icon column's room. */
  icons: boolean;
  labelDisplay: "text" | "icon";
  onOpenChange: (open: boolean) => void;
}

const RailRow = ({
  item,
  isOpen,
  starts,
  start,
  icons,
  labelDisplay,
  onOpenChange,
}: RailRowProps) => {
  const opens = opensOf(item);
  const head = (
    <div
      {...stylex.props(
        styles.head,
        start ? [styles.onGrid, styles.headStart] : styles.headEnd
      )}
    >
      <dt
        {...stylex.props(styles.label, styles.railLabel, icons && styles.named)}
      >
        <Label
          item={item}
          opens={opens}
          isOpen={isOpen}
          icons={icons}
          alone={labelDisplay === "icon" && item.icon !== undefined}
        />
      </dt>
      <dd
        {...stylex.props(
          styles.value,
          start ? styles.valueStart : styles.valueEnd,
          item.mono === true && styles.mono,
          opens && styles.over
        )}
      >
        <ValueOf item={item} />
      </dd>
      <Tail item={item} opens={opens} isOpen={isOpen} />
    </div>
  );
  const row = (
    <div
      data-slot="key-value-item"
      {...stylex.props(
        styles.railRow,
        start && styles.onGrid,
        starts && styles.groupStart
      )}
    >
      {head}
      {opens ? (
        <div {...stylex.props(styles.under, start && styles.across)}>
          <CollapsibleContent>
            <dd {...stylex.props(styles.detail)}>{item.detail}</dd>
          </CollapsibleContent>
        </div>
      ) : null}
    </div>
  );
  // A row with a detail is a Collapsible from the start, drawn as the row, so a value that lands
  // does not draw the row anew; its trigger and its panel come only once it has.
  return item.detail === undefined ? (
    row
  ) : (
    <Collapsible asChild open={isOpen} onOpenChange={onOpenChange}>
      {row}
    </Collapsible>
  );
};

/** Which row is open: the caller's (`value`), or the list's own. One at a time. */
const useOpenRow = (
  value: string | null | undefined,
  defaultValue: string | null,
  onValueChange: ((id: string | null) => void) | undefined
) => {
  const [own, setOwn] = useState<string | null>(defaultValue);
  const current = value === undefined ? own : value;
  const change = (next: string | null) => {
    setOwn(next);
    onValueChange?.(next);
  };
  return [current, change] as const;
};

/** The rows of a list that can open in place. */
interface RailProps {
  items: readonly KeyValueItem[];
  value: string | null | undefined;
  defaultValue: string | null;
  onValueChange: ((id: string | null) => void) | undefined;
  start: boolean;
  labelDisplay: "text" | "icon";
  style: LayoutStyle | undefined;
}

const Rail = ({
  items,
  value,
  defaultValue,
  onValueChange,
  start,
  labelDisplay,
  style,
}: RailProps) => {
  const [current, change] = useOpenRow(value, defaultValue, onValueChange);
  const icons = items.some((item) => item.icon !== undefined);
  return (
    <dl
      data-slot="key-value-list"
      data-orientation="horizontal"
      data-value-align={start ? "start" : "end"}
      {...stylex.props(
        styles.list,
        styles.rail,
        start && styles.railStart,
        style
      )}
    >
      {items.map((item, index) => (
        <RailRow
          key={item.id}
          item={item}
          isOpen={current === item.id && opensOf(item)}
          starts={startsGroup(items, index)}
          start={start}
          icons={icons}
          labelDisplay={labelDisplay}
          onOpenChange={(open) => {
            change(open ? item.id : null);
          }}
        />
      ))}
    </dl>
  );
};

export const KeyValueList = ({
  items,
  orientation = "vertical",
  divided = false,
  value,
  defaultValue = null,
  onValueChange,
  valueAlign = "end",
  labelDisplay = "text",
  style,
}: KeyValueListProps) => {
  const horizontal = orientation === "horizontal";
  if (
    horizontal &&
    items.some((item) => item.detail !== undefined || item.icon !== undefined)
  ) {
    return (
      <Rail
        items={items}
        value={value}
        defaultValue={defaultValue}
        onValueChange={onValueChange}
        start={valueAlign === "start"}
        labelDisplay={labelDisplay}
        style={style}
      />
    );
  }
  return (
    <dl
      data-slot="key-value-list"
      data-orientation={orientation}
      {...stylex.props(styles.list, !divided && styles.spaced, style)}
    >
      {items.map((item, index) => {
        const text = copyText(item.copyable, item.value);
        return (
          <div
            key={item.id}
            data-slot="key-value-item"
            {...stylex.props(
              styles.row,
              horizontal && styles.rowHorizontal,
              divided && styles.rowDivided,
              text !== "" && styles.rowCopyable,
              startsGroup(items, index) && styles.groupStart
            )}
          >
            <dt {...stylex.props(styles.label)}>{item.label}</dt>
            <dd
              {...stylex.props(
                styles.value,
                horizontal && styles.valueHorizontal,
                item.mono === true && styles.mono
              )}
            >
              <ValueOf item={item} />
              {text ? (
                <span {...stylex.props(styles.copy)}>
                  <CopyValue label={item.label} text={text} />
                </span>
              ) : null}
            </dd>
          </div>
        );
      })}
    </dl>
  );
};
