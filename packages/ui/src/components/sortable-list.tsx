// Sortable list: a list a person puts in order by hand, by a handle on each item: dragged with a
// pointer or a finger, or moved from the keyboard, every step said to a screen reader.
// In StyleX, built on UI SDK's createReorder (@ui-sdk/core), which keeps the order being moved as a
// draft and hands the new one to `onValueChange` once it is dropped.
//
//   <SortableList aria-label="Steps, in order" value={order} onValueChange={setOrder}>
//     {order.map((id) => (
//       <SortableListItem key={id} value={id} textValue={names[id]}>
//         <SortableListHandle aria-label={`Move ${names[id]}`} />
//         <Field orientation="horizontal">…</Field>
//       </SortableListItem>
//     ))}
//   </SortableList>
//
// The handle carries the move, so an item holds its own controls (a switch, a field) and they
// keep their keys and presses. From the keyboard: Space or Enter on a handle picks its item up, the
// arrows move it (Home and End to either end), Space or Enter puts it down, Escape or Tab puts it
// back. While an item is up it is lifted on the raised ground; while a pointer drags it, it follows
// the pointer and the others make room. The order is the caller's: it renders the items in `value`
// and takes the new order from `onValueChange` once one is put down, as a list of its own data
// always is. Its words (the handles' instructions, what is said at each step) come from the
// I18nProvider.
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  createAutoScroll,
  createChange,
  createReorder,
  definePrimitive,
  reorderMessage,
} from "@ui-sdk/core";
import type { ChangeDetails, ReorderDraft, ReorderReason } from "@ui-sdk/core";
import { usePart, usePrimitive } from "@ui-sdk/react/primitive";
import { createContext, use, useId } from "react";
import type { ReactNode } from "react";

import { useI18n } from "../lib/i18n";
import { GripVerticalIcon, Icon } from "../lib/icons";
import { tapTarget } from "../lib/styles";
import {
  colors,
  duration,
  media,
  radius,
  shadow,
  size,
  space,
} from "../lib/tokens.stylex";
import { announce, className } from "../lib/utils";
import type { LayoutStyle } from "../lib/utils";
import { buttonVariants } from "./button";
import { ghostVars } from "./button.stylex";

/** Why the order changed: a pointer's drag, the keyboard, or code. */
export type SortableListChangeReason = ReorderReason;

/** Every prop a SortableList takes. */
export interface SortableListProps {
  /** Its SortableListItems, in the order the list holds. */
  children: ReactNode;
  /**
   * The items' values in the order the caller renders them, kept in state. The list draws an item
   * being moved where it is going, and gives the new order to `onValueChange` once it is put down.
   */
  value: string[];
  /**
   * Called with the new order once an item is put down, and why: a drag (`drag`), the keyboard
   * (`move-key`) or code (`imperative`). Render the items in it; `details.cancel()` puts the item
   * back.
   */
  onValueChange: (
    value: string[],
    details: ChangeDetails<SortableListChangeReason>
  ) => void;
  /**
   * No item can be moved: every handle out of use. Say why near it.
   * @default false
   */
  disabled?: boolean;
  /** What the list holds, as a screen reader says it ("Steps, in order"). */
  "aria-label": string;
  /** Layout only: margins, alignment and width. */
  style?: LayoutStyle;
}

/** Every prop a SortableListItem takes: one item of the list. */
export interface SortableListItemProps {
  /** Its value in the list's order: unique and the same between renders. */
  value: string;
  /** Its SortableListHandle, then what it shows: its words, its own controls. */
  children: ReactNode;
  /**
   * Its name, as a screen reader hears it at each step of a move ("Picked up Welcome, position 1
   * of 4"), when its words say more than its name. Without it, its text.
   */
  textValue?: string;
  /**
   * It cannot be picked up. It does not hold its place: the others still move past it.
   * @default false
   */
  disabled?: boolean;
  /** Layout only: alignment inside the item's row. */
  style?: LayoutStyle;
}

/** Every prop a SortableListHandle takes: the grip that moves its item. */
export interface SortableListHandleProps {
  /** What it does, with the item's name: "Move Welcome", as a screen reader says it. */
  "aria-label": string;
}

// ---- The behaviour --------------------------------------------------------------------------------

/** What the words of a step are made from. */
type Say = (
  type: "grab" | "move" | "drop" | "cancel",
  name: string,
  position: number,
  total: number
) => string;

interface SortableListOptions {
  value?: string[];
  onValueChange?: (
    value: string[],
    details: ChangeDetails<SortableListChangeReason>
  ) => void;
  disabled?: boolean;
  say?: Say;
}

interface ItemProps {
  value: string;
  textValue?: string;
  disabled?: boolean;
}

/** The draft at rest: nothing picked up. */
const notMoving = (): ReorderDraft | null => null;

const sortableList = definePrimitive({
  name: "sortable-list",
  options: {
    value: "value",
    onValueChange: "callback",
    disabled: "boolean",
    say: "value",
  },
  controlled: ["value"],
  state: (options: SortableListOptions) => ({
    value: options.value ?? [],
    moving: notMoving(),
  }),
  sync: (options) =>
    options.value === undefined ? {} : { value: options.value },
  api: (context) => {
    const change = createChange(context);
    const reorder = createReorder(context, {
      slot: "item",
      key: "value",
      draft: "moving",
      set: (value, details) => change("value", value, details),
      disabled: (item: { key: string; props: ItemProps }) =>
        context.options().disabled === true || item.props.disabled === true,
      label: (key) => context.props<ItemProps>("item", key)?.textValue,
      // Said through the page's one live region (lib/utils' announce), as every part of Damsko
      // speaks; the empty text left to UI SDK says nothing a second time.
      // A step takes the place of the one still waiting to be said, so what is said keeps up
      // with the item; a pick up, a drop and a put back are each said.
      message: (message) => {
        const { say } = context.options();
        announce(
          say === undefined
            ? reorderMessage(message)
            : say(message.type, message.label, message.position, message.total),
          "assertive",
          message.type === "move" ? `${context.id}-move` : undefined
        );
        return "";
      },
    });

    // A pointer's drag near the top or bottom of what scrolls (the list's box, the page) scrolls
    // it, so an item goes past what one screen shows. UI SDK scrolls only while it drags a copy of
    // the item; here the item itself is dragged, so that a native select in it keeps its choice and
    // it never goes sideways, and the scroll is followed here. UI SDK's createAutoScroll is the one
    // frame loop: it runs while the real pointer is in an edge's band, at most its speed a frame,
    // slower the shallower the pointer is in, and stops once the list's own end is on screen (past
    // it there is nowhere to drop) or what scrolls is at its end.
    // After each scroll the item keeps under the still pointer by what scrolled (--drag-scroll) and
    // finds its place again. Its translate is held within the list (--drag-min, --drag-max), so it
    // never makes the page or the box taller than it is. It all stops once the drag is over, for
    // whatever reason: put down, Escape, the pointer lost, the item gone, the list gone.
    // The one drag's scrolling at a time: a new press ends the last one's.
    let stopScrolling: (() => void) | undefined;
    context.onDestroy(() => {
      stopScrolling?.();
    });
    const scrollWhileDragging = (down: PointerEvent, key: string) => {
      stopScrolling?.();
      const item = context.element("item", key);
      const list = item?.parentElement;
      if (item === undefined || list === null || list === undefined) {
        return;
      }
      const doc = item.ownerDocument;
      const { top } = list.getBoundingClientRect();
      let y = down.clientY;
      let dragging = false;
      const dragged = () => {
        const { moving } = context.store.get();
        return moving?.pointer === true && moving.key === key;
      };
      // The item may stand from the list's top to its bottom, wherever the order being shown puts
      // it. Worked out from that order, not read from where it is drawn, so it holds in the very
      // frame the order changes in.
      const hold = () => {
        const order = context.store.get().moving?.order ?? [];
        const gap =
          Number(getComputedStyle(list).rowGap.replace(/px$/u, "")) || 0;
        let before = 0;
        for (const other of order.slice(0, order.indexOf(key))) {
          before += (context.element("item", other)?.offsetHeight ?? 0) + gap;
        }
        item.style.setProperty("--drag-min", `${-before}px`);
        item.style.setProperty(
          "--drag-max",
          `${list.clientHeight - before - item.offsetHeight}px`
        );
      };
      // The place under the pointer: past every other item whose middle is above it.
      const placeAt = () =>
        [...list.children].filter((other) => {
          if (other === item) {
            return false;
          }
          const rect = other.getBoundingClientRect();
          return rect.top + rect.height / 2 < y;
        }).length;
      // The part of the screen the list can show: the window, cut by every box round it that
      // scrolls or clips.
      const shown = () => {
        let from = 0;
        let to = doc.defaultView?.innerHeight ?? 0;
        for (let node = list.parentElement; node; node = node.parentElement) {
          if (getComputedStyle(node).overflowY !== "visible") {
            const rect = node.getBoundingClientRect();
            from = Math.max(from, rect.top);
            to = Math.min(to, rect.bottom);
          }
        }
        return { from, to };
      };
      // Whether more of the list lies past the edge the pointer is nearer: past the list's own end
      // there is nowhere to drop, so a scroll stops once that end is on screen.
      const more = () => {
        const { from, to } = shown();
        const rect = list.getBoundingClientRect();
        return y > (from + to) / 2
          ? rect.bottom > to + 0.5
          : rect.top < from - 0.5;
      };
      const scrolled = () => {
        if (!dragging) {
          return;
        }
        item.style.setProperty(
          "--drag-scroll",
          `${top - list.getBoundingClientRect().top}px`
        );
        hold();
        reorder.moveTo(placeAt());
      };
      const scroller = createAutoScroll({
        ignore: () => item,
        onScroll: () => {
          scrolled();
          if (!more()) {
            scroller.stop();
          }
        },
      });
      // Everything below ends with the drag, by this one signal.
      const listening = new AbortController();
      const { signal } = listening;
      const stop = () => {
        listening.abort();
      };
      const unsubscribe = context.store.subscribe(() => {
        if (!dragging) {
          return;
        }
        if (dragged()) {
          hold();
        } else {
          stop();
        }
      });
      signal.addEventListener("abort", () => {
        stopScrolling = undefined;
        scroller.stop();
        unsubscribe();
        for (const name of ["--drag-scroll", "--drag-min", "--drag-max"]) {
          item.style.removeProperty(name);
        }
        if (!dragging) {
          return;
        }
        // The list stays no scroll anchor until the frame after a drag ends: as the dragged item
        // drops its translate, Firefox anchors to the list and scrolls the page or the box back,
        // here to its top, undoing what the drag scrolled.
        list.style.overflowAnchor = "none";
        const view = doc.defaultView;
        view?.requestAnimationFrame(() => {
          view.requestAnimationFrame(() => {
            list.style.removeProperty("overflow-anchor");
          });
        });
      });
      const moved = (event: PointerEvent) => {
        if (event.pointerId !== down.pointerId || !dragged()) {
          return;
        }
        if (!dragging) {
          dragging = true;
          hold();
        }
        y = event.clientY;
        if (more()) {
          scroller.update(event.clientX, y);
        } else {
          scroller.stop();
        }
      };
      const ended = (event: PointerEvent) => {
        if (event.pointerId === down.pointerId) {
          stop();
        }
      };
      doc.addEventListener("pointermove", moved, { signal });
      doc.addEventListener("pointerup", ended, { signal });
      doc.addEventListener("pointercancel", ended, { signal });
      doc.addEventListener("scroll", scrolled, { capture: true, signal });
      stopScrolling = stop;
    };
    return { reorder, scrollWhileDragging };
  },
  slots: (slot) => ({
    root: slot<object, { moving: boolean }>({
      state: (state) => ({ moving: state.moving !== null }),
    }),
    item: slot<
      ItemProps,
      { moving: boolean; dragging: boolean; place: number | undefined }
    >({
      props: { value: "key", textValue: "string", disabled: "boolean" },
      state: (state, { api, key }) => ({
        moving: api.reorder.moving(state, key),
        dragging: api.reorder.dragging(state, key),
        // While an item is moved, each item's place in the order being shown.
        place:
          state.moving === null
            ? undefined
            : api.reorder.order(state).indexOf(key),
      }),
      attrs: (state, { api, key }) => ({
        "data-moving": api.reorder.moving(state, key) ? "" : undefined,
        "data-dragging": api.reorder.dragging(state, key) ? "" : undefined,
      }),
      bind: (el, part) => part.api.reorder.bind(el, part),
    }),
    handle: slot<{ value: string }, { moving: boolean }>({
      props: { value: "string" },
      state: (state, { api, key }) => ({
        moving: api.reorder.moving(state, key),
      }),
      attrs: (state, { api, key }) => ({
        type: "button",
        "aria-pressed": api.reorder.moving(state, key) ? "true" : undefined,
      }),
      // A press with no drag (a click, or a screen reader's activation, which sends no key) picks
      // the item up, and a second puts it down, as Space does; a press on another item's handle
      // puts the first back and picks that one up. A drag that ends swallows its click.
      // Focus goes to the handle first: a click does not give a button focus in WebKit, and the
      // arrows that move the item are the handle's.
      press: ({ api, key, store, el }, event) => {
        el?.focus({ preventScroll: true });
        const state = store.get();
        if (api.reorder.moving(state, key)) {
          api.reorder.drop(event);
          return;
        }
        if (state.moving !== null) {
          api.reorder.cancel();
        }
        api.reorder.grab(key);
      },
      on: {
        keydown: (event, { api, key }) => {
          api.reorder.keydown(event, key);
        },
        pointerdown: (event, { api, key }) => {
          api.reorder.pointerdown(event, key);
          api.scrollWhileDragging(event, key);
        },
      },
    }),
  }),
});

// ---- The look --------------------------------------------------------------------------------------

const FORCED = media.forcedColors;
const HOVER = media.hover;
const REDUCED = media.reducedMotion;

const styles = stylex.create({
  list: {
    display: "flex",
    flexDirection: "column",
    gap: space[1],
    // Each handle's touch target reaches the middle of the gap to the next row's (tapTarget).
    "--tap-room-block": `calc(${space[1]} / 2)`,
    minWidth: 0,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  // While an item is moved, no item is a scroll anchor: as the order changes under it, the browser
  // would scroll against the move. At rest the list keeps the page's place as any content does, when
  // something is added above a row on screen.
  listMoving: {
    overflowAnchor: "none",
  },
  // An item: its handle at the start, then what it holds, on the ground it stands on.
  item: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: space[2],
    // The handle's touch target reaches the middle of the gap to what stands beside it.
    "--tap-room-inline": `calc(${space[2]} / 2)`,
    minWidth: 0,
    borderRadius: radius.lg,
    cornerShape: radius.shape,
    // A real edge in forced colours while it is up, where the lift is dropped.
    outlineWidth: 1,
    outlineStyle: "solid",
    outlineColor: "transparent",
    transitionProperty: {
      default: "box-shadow, background-color",
      [REDUCED]: "none",
    },
    transitionDuration: duration.hover,
    transitionTimingFunction: duration.ease,
  },
  // Picked up: lifted on the raised ground, over its neighbours.
  moving: {
    zIndex: 1,
    backgroundColor: colors.popover,
    boxShadow: shadow.popupShadow,
    outlineColor: { default: "transparent", [FORCED]: "CanvasText" },
  },
  // Dragged: it follows the pointer up and down the list, never sideways.
  dragging: {
    // Held within the list, so it never makes what scrolls taller.
    transform:
      "translateY(clamp(var(--drag-min), var(--drag-y, 0px) + var(--drag-scroll, 0px), var(--drag-max)))",
    // Its words are not selected as it is dragged over.
    userSelect: "none",
  },
  // The grip: Button's ghost icon button (buttonVariants), which a finger drags the item by;
  // anywhere else on the item a finger scrolls the page. Its ink is quiet until the pointer comes.
  grip: {
    [ghostVars.ink]: {
      default: colors.mutedForeground,
      ":hover": { default: null, [HOVER]: colors.foreground },
    },
    cursor: { default: "grab", ":active": "grabbing" },
    touchAction: "none",
    userSelect: "none",
  },
  // Up: the press's fill stays while it is moved, and the press does not shrink it as it is
  // dragged.
  handleMoving: {
    [ghostVars.ink]: colors.foreground,
    backgroundColor: colors.accentActive,
    transform: "none",
  },
  handleDisabled: {
    opacity: size.opacityDisabled,
    backgroundColor: "transparent",
    cursor: "default",
  },
});

// The id of the instructions every handle is described by.
const Instructions = createContext("");
// Whether the list round a handle is out of use; the item round it, and whether that is.
const ListDisabled = createContext(false);
const ItemValue = createContext("");
const ItemDisabled = createContext(false);

/** A list a person puts in order by hand, by each item's handle. */
export const SortableList = ({
  children,
  value,
  onValueChange,
  disabled = false,
  "aria-label": ariaLabel,
  style,
}: SortableListProps) => {
  const words = useI18n().sortableList;
  const instructions = useId();
  const handle = usePrimitive(sortableList, {
    value,
    onValueChange,
    disabled,
    say: (type, name, position, total) => {
      const said = {
        grab: words.grabbed,
        move: words.moved,
        drop: words.dropped,
        cancel: words.cancelled,
      }[type];
      return said(name, position, total);
    },
  });
  const list = usePart(
    handle,
    "root",
    {},
    {
      "aria-label": ariaLabel,
      className: (state: { moving: boolean }) =>
        className(styles.list, state.moving && styles.listMoving, style),
      children,
    },
    "ul"
  );
  return (
    <Instructions value={instructions}>
      <ListDisabled value={disabled}>
        {list}
        <span id={instructions} hidden>
          {words.instructions}
        </span>
      </ListDisabled>
    </Instructions>
  );
};

/** One item: its handle, then what it holds. Lifted while it is moved. */
export const SortableListItem = ({
  value,
  children,
  textValue,
  disabled = false,
  style,
}: SortableListItemProps) =>
  usePart(
    sortableList,
    "item",
    { value, textValue, disabled },
    {
      className: (state: { moving: boolean; dragging: boolean }) =>
        className(
          styles.item,
          state.moving && styles.moving,
          state.dragging && styles.dragging,
          style
        ),
      // While an item is moved the items are drawn in the order being shown, and the page's own
      // order stays as it is until the new one is put down and given back: nothing is moved in the
      // document under a dragging pointer or a focused handle. At rest, no style at all.
      style: (state: { place: number | undefined }) =>
        state.place === undefined ? undefined : { order: state.place },
      children: (
        <ItemValue value={value}>
          <ItemDisabled value={disabled}>{children}</ItemDisabled>
        </ItemValue>
      ),
    },
    "li"
  );

/** The grip that moves its item: dragged, or Space and the arrows from the keyboard. */
export const SortableListHandle = ({
  "aria-label": ariaLabel,
}: SortableListHandleProps) => {
  const instructions = use(Instructions);
  const value = use(ItemValue);
  const disabled = use(ListDisabled) || use(ItemDisabled);
  return usePart(
    sortableList,
    "handle",
    // The item round it: the handle moves it.
    { value },
    {
      "aria-label": ariaLabel,
      "aria-describedby": instructions,
      disabled,
      className: (state: { moving: boolean }) =>
        className(
          buttonVariants({ variant: "ghost", size: "icon-sm" }),
          styles.grip,
          state.moving && styles.handleMoving,
          disabled && styles.handleDisabled
        ),
      children: (
        <>
          <span aria-hidden="true" {...stylex.props(tapTarget)} />
          <Icon icon={GripVerticalIcon} />
        </>
      ),
    },
    "button"
  );
};
