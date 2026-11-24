// Toast: a small message that says something happened,
// with Sonner's `toast()` and `<Toaster />`, built on UI SDK's
// ToastRegion: a raised card with the popup's lift and the one corner, an icon in the toast's
// colour, a title over a muted sentence, and an action at the bottom end. A toast goes when its time
// is up, when it is swiped, on Escape, or when its action is pressed, and it always fades as it goes.
// Only a toast that stays (a loading one, or one given no time) has a close button, in its corner:
// nothing else in sight would put it away. Newer toasts stack in front; the stack opens under a
// pointer or focus. Place it once; call `toast()` from anywhere.
//
//   <Toaster />
//   toast.success("Report shared", { description: "Everyone on the team can read it." });
//   toast("Report archived", { action: { label: "Undo", onAction: restore } });
//
// F6 moves focus to the newest toast and back; Escape dismisses the focused one. A toast is
// announced to a screen reader without taking focus, by UI SDK's own live regions; what its action
// says when its work failed is said by the page's one live region (lib/utils `announce`).
"use client";

import * as stylex from "@stylexjs/stylex";
import {
  createToaster as createQueue,
  Toast as ToastPrimitive,
  ToastAction as ActionPrimitive,
  ToastClose as ClosePrimitive,
  ToastDescription as DescriptionPrimitive,
  ToastRegion as RegionPrimitive,
  ToastTitle as TitlePrimitive,
} from "@ui-sdk/react/toast";
import type {
  ToastButtonState,
  Toaster as ToasterQueue,
  ToastOptions as Options,
  ToastState,
  ToastType,
} from "@ui-sdk/react/toast";
import { isValidElement, useEffect, useRef } from "react";
import type { ReactNode } from "react";

import { useI18n } from "../lib/i18n";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  Icon,
  InfoIcon,
  LoaderIcon,
  TriangleAlertIcon,
  XIcon,
} from "../lib/icons";
import type { IconData } from "../lib/icons";
import {
  colors,
  duration,
  font,
  media,
  radius,
  shadow,
  size as sizes,
  space,
} from "../lib/tokens.stylex";
import { durations } from "../lib/tokens.values";
import { announce, isBlank } from "../lib/utils";
import { iconVars, motionVars, toastRegionMarker } from "../lib/vars.stylex";
import { Button } from "./button";
import { Spinner } from "./spinner";

export type { ToastData, ToastOptions, ToastType } from "@ui-sdk/react/toast";

// ---- The queue ------------------------------------------------------------------------------------
//
// The page's own toast queue, and the way to make another. A toast shows for toast-duration; one
// with an action shows for toast-duration-action, long enough to read it and reach the action, as
// only a toast that stays has a close button. A `duration` on a toast always wins.

type ToastOptionsOf = Options<ReactNode>;

// UI SDK knows a queue by the object it made, so the region is given that one, kept here.
const originals = new WeakMap<object, ToasterQueue<ReactNode>>();

/** The queue UI SDK made, for a ToastRegion; a queue made elsewhere is its own. */
const queueOf = (toaster: ToasterQueue<ReactNode>): ToasterQueue<ReactNode> =>
  originals.get(toaster) ?? toaster;

/** Whether a toast's first argument is its options rather than its message. */
const isOptions = (value: unknown): value is ToastOptionsOf =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !isValidElement(value);

/** An action's toast stays longer, unless it says how long itself. */
const timedOf = (options: ToastOptionsOf): ToastOptionsOf =>
  options.action !== undefined && options.duration === undefined
    ? { ...options, duration: durations.toastDurationAction }
    : options;
const timed = (
  options: ToastOptionsOf | undefined
): ToastOptionsOf | undefined =>
  options === undefined ? undefined : timedOf(options);

/** Shows a toast with one argument or two: the message, or the options, then the options. */
const shown =
  (
    show: (
      message: ReactNode | ToastOptionsOf,
      options?: ToastOptionsOf
    ) => string
  ) =>
  (message: ReactNode | ToastOptionsOf, options?: ToastOptionsOf) =>
    options === undefined && isOptions(message)
      ? show(timedOf(message))
      : show(message, timed(options));

/**
 * Makes a queue of toasts, for a second Toaster with its own toasts (`<Toaster toaster={…} />`).
 * Damsko's times are its defaults: `duration` sets the plain one.
 */
export const createToaster = ({
  duration: plain = durations.toastDuration,
}: { duration?: number } = {}): ToasterQueue<ReactNode> => {
  const queue = createQueue({ duration: plain });
  const made = Object.assign(shown(queue), queue, {
    success: shown(queue.success),
    error: shown(queue.error),
    info: shown(queue.info),
    warning: shown(queue.warning),
    update: (id: string, options: ReactNode | ToastOptionsOf) =>
      queue.update(id, isOptions(options) ? timedOf(options) : options),
  });
  originals.set(made, queue);
  // SAFETY: the queue itself with Damsko's own show functions over UI SDK's, which take the same arguments.
  return made as ToasterQueue<ReactNode>;
};

/** Shows a toast: `toast("Saved")`, `toast.success(…)`, `toast.promise(…)`, `toast.update(id, …)`. */
export const toast = createToaster();

// ---- The look ------------------------------------------------------------------------------------

const REDUCED = media.reducedMotion;
const FORCED = media.forcedColors;
// Where a toast is pulled to: the swipe, plus the way out once it leaves (set by `leaving` below).
const swipeX = "calc(var(--toast-swipe-x, 0px) + var(--toast-exit-x, 0px))";
const swipeY = "calc(var(--toast-swipe-y, 0px) + var(--toast-exit-y, 0px))";
const expanded = ":is([data-expanded])";
const enteringFront = ":is([data-starting-style][data-front])";
// It fades as it comes in, front or behind, and as it goes.
const fading = ":is([data-starting-style], [data-ending-style])";
// A toast that leaves without a swipe: its time ran out, its action ran, or Escape.
const leavingPlain = ":is([data-ending-style]:not([data-swipe-direction]))";
// While the stack is closed, only the front toast shows its words; the ones behind are quiet cards.
const behind = ":not([data-front], [data-expanded])";

// An icon arriving in place: the result of a promise taking the spinner's place.
const arrive = stylex.keyframes({
  from: { opacity: 0, transform: "scale(0.8)" },
  to: { opacity: 1, transform: "none" },
});
const arriveStill = stylex.keyframes({
  from: { opacity: 0 },
  to: { opacity: 1 },
});

// UI SDK's ToastRegion measures the toasts and sets the numbers a stack needs (--toast-index,
// --toast-offset, --toast-height and the region's --toast-front-height and --toast-stack-height);
// these styles place the toasts by them.
const styles = stylex.create({
  // The region: a fixed column at an edge of the window, as tall as the newest toast while the
  // stack is closed, and as tall as all of them while it is open. Clear of the edges by the gutter.
  region: {
    position: "fixed",
    boxSizing: "border-box",
    width: `min(${sizes.toastWidth}, 100vw - 2 * ${sizes.dialogGutter})`,
    height: {
      default: "var(--toast-front-height)",
      [expanded]: `calc(var(--toast-stack-height) + (var(--toast-count) - 1) * ${space.toastGap})`,
    },
    margin: 0,
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    overflow: "visible",
    listStyle: "none",
    inset: "auto",
    transitionProperty: "height",
    transitionDuration: motionVars.ui,
    transitionTimingFunction: duration.ease,
  },
  // Clear of a phone's home bar and notch too.
  bottom: {
    bottom: `calc(${sizes.dialogGutter} + var(--keyboard-inset, 0px) + env(safe-area-inset-bottom, 0px))`,
  },
  top: {
    top: `calc(${sizes.dialogGutter} + env(safe-area-inset-top, 0px))`,
  },
  start: { insetInlineStart: sizes.dialogGutter },
  end: { insetInlineEnd: sizes.dialogGutter },
  // UI SDK centres it with its own `translate: -50% 0`; a transform here would move it twice.
  center: { left: "50%" },

  // A toast: raised, the popup's lift, the one corner. Its icon beside its words, the action under them.
  toast: {
    [iconVars.size]: sizes.iconSm,
    [iconVars.stroke]: sizes.iconStroke,
    position: "absolute",
    insetInline: 0,
    // The newest in front: the further back in the stack, the lower.
    zIndex: "calc(-1 * var(--toast-index))",
    boxSizing: "border-box",
    display: "grid",
    gridTemplateColumns: "auto minmax(0, 1fr)",
    columnGap: space["3"],
    alignItems: "start",
    height: {
      default: "var(--toast-height)",
      [behind]: "var(--toast-front-height)",
    },
    overflow: "hidden",
    margin: 0,
    padding: space["4"],
    borderWidth: { default: 0, [FORCED]: 1 },
    borderStyle: "solid",
    borderColor: "CanvasText",
    borderRadius: radius.xl,
    cornerShape: radius.shape,
    backgroundColor: colors.card,
    boxShadow: shadow.md,
    color: colors.bodyForeground,
    fontFamily: font.sans,
    fontSize: font.textBase,
    lineHeight: font.textBaseLine,
    userSelect: "none",
    // Its icon and words read this: 0 behind the front toast while the stack is closed.
    "--toast-content": { default: 1, [behind]: 0 },
    opacity: { default: 1, [fading]: 0 },
    transitionProperty: {
      default: "translate, scale, opacity, height",
      [REDUCED]: "opacity",
    },
    // With reduced motion it is simply there, and simply gone.
    transitionDuration: {
      default: motionVars.open,
      ":is([data-starting-style], [data-swiping])": "0s",
      ":is([data-ending-style])": motionVars.leave,
    },
    transitionTimingFunction: duration.ease,
  },
  // The way out. A swiped toast carries on in the direction of the swipe, a whole toast further;
  // any other goes back a short way towards its edge. Both while they fade.
  leavingBottom: {
    "--toast-exit-x": {
      default: "0px",
      ":is([data-ending-style][data-swipe-direction=right])": {
        default: "100%",
        [REDUCED]: "0px",
      },
      ":is([data-ending-style][data-swipe-direction=left])": {
        default: "-100%",
        [REDUCED]: "0px",
      },
    },
    "--toast-exit-y": {
      default: "0px",
      ":is([data-ending-style][data-swipe-direction=down])": {
        default: "100%",
        [REDUCED]: "0px",
      },
      ":is([data-ending-style][data-swipe-direction=up])": {
        default: "-100%",
        [REDUCED]: "0px",
      },
      [leavingPlain]: { default: "50%", [REDUCED]: "0px" },
    },
  },
  leavingTop: {
    "--toast-exit-x": {
      default: "0px",
      ":is([data-ending-style][data-swipe-direction=right])": {
        default: "100%",
        [REDUCED]: "0px",
      },
      ":is([data-ending-style][data-swipe-direction=left])": {
        default: "-100%",
        [REDUCED]: "0px",
      },
    },
    "--toast-exit-y": {
      default: "0px",
      ":is([data-ending-style][data-swipe-direction=down])": {
        default: "100%",
        [REDUCED]: "0px",
      },
      ":is([data-ending-style][data-swipe-direction=up])": {
        default: "-100%",
        [REDUCED]: "0px",
      },
      [leavingPlain]: { default: "-50%", [REDUCED]: "0px" },
    },
  },
  // What the toast holds: hidden behind the front while the stack is closed, so one thing is read.
  content: {
    opacity: "var(--toast-content)",
    transitionProperty: "opacity",
    transitionDuration: motionVars.ui,
    transitionTimingFunction: duration.ease,
  },
  arrive: {
    display: "inline-flex",
    animationName: { default: arrive, [REDUCED]: arriveStill },
    animationDuration: duration.swap,
    animationTimingFunction: duration.ease,
  },
  noIcon: {
    gridTemplateColumns: "minmax(0, 1fr)",
  },
  // A toast that stays: a third column for its close button, in the top end corner.
  closable: { gridTemplateColumns: "auto minmax(0, 1fr) auto" },
  closableNoIcon: { gridTemplateColumns: "minmax(0, 1fr) auto" },
  // Level with the title's line, and as far into the corner as its own room allows, so the cross
  // stands as far from the edges as the icon does at the start.
  close: {
    display: "flex",
    marginBlock: `calc((${font.textBaseLine} - ${sizes.controlXs}) / 2)`,
    marginInlineEnd: `calc(-1 * ${space["2"]})`,
  },
  // Along the bottom: the newest at the foot, the older ones peeking above it, or stacked above
  // it while the stack is open. It rises a little as it fades in.
  atBottom: {
    bottom: 0,
    transformOrigin: "bottom center",
    translate: {
      default: `${swipeX} calc(var(--toast-index) * -1 * ${space.toastPeek} + ${swipeY})`,
      [expanded]: `${swipeX} calc(-1 * (var(--toast-offset) + var(--toast-index) * ${space.toastGap}) + ${swipeY})`,
      // It rises a short way, not a whole toast: from its first frame its action stands within
      // space-3 of where it comes to rest, so a press aimed there lands on it.
      [enteringFront]: `${swipeX} ${space["3"]}`,
    },
    scale: {
      default: `calc(1 - var(--toast-index) * ${sizes.toastPeekScale})`,
      [expanded]: 1,
    },
  },
  // Along the top, the same turned over.
  atTop: {
    top: 0,
    transformOrigin: "top center",
    translate: {
      default: `${swipeX} calc(var(--toast-index) * ${space.toastPeek} + ${swipeY})`,
      [expanded]: `${swipeX} calc(var(--toast-offset) + var(--toast-index) * ${space.toastGap} + ${swipeY})`,
      [enteringFront]: `${swipeX} calc(-1 * ${space["3"]})`,
    },
    scale: {
      default: `calc(1 - var(--toast-index) * ${sizes.toastPeekScale})`,
      [expanded]: 1,
    },
  },

  icon: {
    display: "inline-flex",
    alignItems: "center",
    height: font.textBaseLine,
  },
  default: { color: colors.mutedForeground },
  info: { color: colors.info },
  success: { color: colors.success },
  warning: { color: colors.warning },
  error: { color: colors.destructive },
  loading: { color: colors.mutedForeground },

  words: {
    display: "grid",
    rowGap: space["1"],
    minWidth: 0,
    overflowWrap: "anywhere",
    hyphens: "manual",
  },
  title: {
    margin: 0,
    lineHeight: font.textBaseLine,
    fontWeight: font.weightMedium,
    color: colors.foreground,
  },
  description: {
    margin: 0,
    color: colors.mutedForeground,
  },
  // The action at the bottom end, at its own width, a cancel to its start: the same on a phone.
  actions: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: space["2"],
    marginBlockStart: space["2"],
  },
});

// ---- The parts -----------------------------------------------------------------------------------

/** Where the Toaster stands: an edge of the window, and where along it (Sonner's positions). */
type Position =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

/** Every prop a Toaster takes. */
export interface ToasterProps {
  /**
   * Where it stands. Swiping a toast towards its edge dismisses it. `left` and `right` follow the
   * reading direction: the right is the end, which in a right-to-left page is the left. `*-right`
   * beside the work, `*-center` for a message about the whole page.
   * @default "bottom-right"
   */
  position?: Position;
  /**
   * How many toasts show at once. Older ones wait, their timers stopped, until there is room.
   * @default 3
   */
  visibleToasts?: number;
  /** Keep the stack open, each toast whole. Otherwise it opens under a pointer or focus. */
  expand?: boolean;
  /**
   * The key that moves focus to the newest toast and back. `null` turns it off.
   * @default "F6"
   */
  hotkey?: string | null;
  /** The queue it shows, from `createToaster()`. Leave it out for the page's own `toast`. */
  toaster?: ToasterQueue<ReactNode>;
}

/** What a toast's `data` may carry: `icon` replaces its type's icon, `null` leaves it without one. */
export interface ToastIconData {
  icon?: IconData | null;
}

const icons: Partial<Record<ToastType, IconData>> = {
  success: CircleCheckIcon,
  error: CircleAlertIcon,
  warning: TriangleAlertIcon,
  info: InfoIcon,
  loading: LoaderIcon,
};

/** A toast's icon: its own (`null` for none) or its type's. A loading toast keeps its spinner, whatever icon it brings. */
const markOf = (type: ToastType, own: IconData | null | undefined) => {
  if (type === "loading") {
    return icons.loading;
  }
  return own === null ? undefined : (own ?? icons[type]);
};

/** Every Toaster on the page, by the queue it draws: two on one queue show every toast twice. */
const regions = new Map<object, { where: string }[]>();

/**
 * Says so, in the console, when a second Toaster draws a queue another already draws: every toast
 * would show in both, both are live regions that say it, and F6 stops at both. One per page, at
 * its root, outside every layer. (Toasters on queues of their own, such as the docs' examples', are
 * each their own and fine.)
 */
const useOneRegion = (queue: object, where: string) => {
  useEffect(() => {
    const own = { where };
    const known = regions.get(queue) ?? [];
    if (known.length > 0) {
      const all = [...known, own].map((each) => each.where);
      const times = String(all.length);
      console.warn(
        `Toaster: ${times} Toasters draw the same toasts (${all.join("; ")}), so each toast shows ${times} times and is said ${times} times. Keep one <Toaster /> per page, at its root, outside every layer.`
      );
    }
    regions.set(queue, [...known, own]);
    return () => {
      const left = (regions.get(queue) ?? []).filter((each) => each !== own);
      if (left.length === 0) {
        regions.delete(queue);
      } else {
        regions.set(queue, left);
      }
    };
  }, [queue, where]);
};

/**
 * A toast's action, as UI SDK's ToastAction hands it: a small outline Button that shows its work
 * while the action's Promise runs, and says `errorText` once it failed, once to a screen reader
 * through the page's live region. The toast stays then.
 */
const ActionButton = ({
  props,
  state,
  label,
  errorText,
}: {
  props: Record<string, unknown>;
  state: ToastButtonState;
  label: ReactNode;
  errorText: string;
}) => {
  const failed = state.error !== undefined && state.error !== null;
  const said = useRef(false);
  useEffect(() => {
    if (failed && !said.current) {
      announce(errorText);
    }
    said.current = failed;
  }, [failed, errorText]);
  return (
    <Button {...props} variant="outline" size="sm">
      {state.pending && <Spinner />}
      {failed && !state.pending ? errorText : label}
    </Button>
  );
};

/** Where the toasts appear. Once per page, at its root, outside every layer. */
export const Toaster = ({
  position = "bottom-right",
  visibleToasts = 3,
  expand,
  hotkey = "F6",
  toaster,
}: ToasterProps) => {
  const words = useI18n().toast;
  const [edge, along] = position.split("-");
  const side = edge === "top" ? "top" : "bottom";
  let align: "start" | "center" | "end" = "end";
  if (along === "left") {
    align = "start";
  } else if (along === "center") {
    align = "center";
  }
  useOneRegion(toaster ?? toast, position);
  const top = side === "top";
  return (
    <RegionPrimitive
      toaster={queueOf(toaster ?? toast)}
      shortcut={hotkey}
      pendingAnnouncement={words.loading}
      side={side}
      align={align}
      maxVisible={visibleToasts}
      expanded={expand}
      aria-label={words.name}
      // It keeps UI SDK's slot, toast-region: UI SDK's own styles place the
      // region, raise it and reset its popover box by that name.
      {...stylex.props(
        toastRegionMarker,
        styles.region,
        styles[side],
        styles[align]
      )}
    >
      {(data) => {
        const type = data.type ?? "default";
        // A toast's own icon first (`data.icon`), `null` for none; otherwise its type's.
        // SAFETY: a toast's data is what the page gave toast(), which the types call a ToastIconData.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
        const own = (data.data as ToastIconData | undefined)?.icon;
        const mark = markOf(type, own);
        // A toast with no time of its own goes only when someone puts it away: it shows how.
        const stays =
          data.duration === Number.POSITIVE_INFINITY &&
          data.dismissible !== false;
        return (
          <ToastPrimitive
            {...stylex.props(
              styles.toast,
              top ? styles.atTop : styles.atBottom,
              top ? styles.leavingTop : styles.leavingBottom,
              mark === undefined && styles.noIcon,
              stays &&
                (mark === undefined ? styles.closableNoIcon : styles.closable)
            )}
            // A quiet card behind the front, or one on its way out, cannot be reached or read.
            render={(props: Record<string, unknown>, state: ToastState) => (
              <li
                {...props}
                inert={
                  state.leaving ||
                  (!state.expanded && state.index > 0) ||
                  undefined
                }
              />
            )}
          >
            {mark !== undefined && (
              // Keyed by type, so when a promise settles the result arrives in the spinner's place.
              <span
                key={type}
                aria-hidden="true"
                {...stylex.props(styles.icon, styles.content, styles[type])}
              >
                {/* The arrival runs inside, so a quiet card behind the front stays quiet. */}
                <span {...stylex.props(styles.arrive)}>
                  <Icon icon={mark} />
                </span>
              </span>
            )}
            <div {...stylex.props(styles.words, styles.content)}>
              <TitlePrimitive {...stylex.props(styles.title)} />
              {!isBlank(data.description) && (
                <DescriptionPrimitive {...stylex.props(styles.description)} />
              )}
              {(data.action !== undefined || data.cancel !== undefined) && (
                <div {...stylex.props(styles.actions)}>
                  {data.cancel !== undefined && (
                    <ClosePrimitive
                      action={data.cancel.onCancel}
                      render={
                        <Button variant="ghost" size="sm">
                          {data.cancel.label}
                        </Button>
                      }
                    />
                  )}
                  {data.action !== undefined && (
                    <ActionPrimitive
                      render={(
                        props: Record<string, unknown>,
                        state: ToastButtonState
                      ) => (
                        <ActionButton
                          props={props}
                          state={state}
                          label={data.action?.label}
                          errorText={words.error}
                        />
                      )}
                    />
                  )}
                </div>
              )}
            </div>
            {stays && (
              <span {...stylex.props(styles.close, styles.content)}>
                <ClosePrimitive
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={words.close}
                    >
                      <Icon icon={XIcon} />
                    </Button>
                  }
                />
              </span>
            )}
          </ToastPrimitive>
        );
      }}
    </RegionPrimitive>
  );
};
