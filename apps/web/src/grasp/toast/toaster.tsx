// Toaster: where toasts appear, from shadcn's Sonner (registry/bases/base/ui/sonner.tsx), rebuilt on
// UI SDK's ToastRegion and made Grasp's after Palermo's Toast: a raised card with the popup's lift
// and the one corner, an icon in the toast's colour, a title over a muted sentence, and an action at
// the bottom end. A toast goes when its time is up, when it is swiped, on Escape, or when its action
// is pressed, and it always fades as it goes. Only a toast that stays (a loading one, or one given
// no time) has a close button, in its corner: nothing else in sight would put it away. Newer toasts stack in
// front; the stack opens under a pointer or focus. Place it once; call `toast()` from anywhere.
//
//   <Toaster />
//   toast.success("Report shared", { description: "Everyone on the team can read it." });
//   toast("Report archived", { action: { label: "Undo", onAction: restore } });
//
// F6 moves focus to the newest toast and back. Escape dismisses the focused one. A toast is
// announced to a screen reader without taking focus. Every value is a token (src/tokens).
"use client";

import * as stylex from "@stylexjs/stylex";
import {
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
  ToastState,
  ToastType,
} from "@ui-sdk/react/toast";
import type { ReactNode } from "react";

import { Button } from "../button";
import type { ButtonWords } from "../button";
import {
  Cross,
  Done,
  Failed,
  Icon,
  Info,
  Spinner,
  Alert as Warning,
} from "../icons";
import type { IconData } from "../icons";
import { queueOf, toast } from "./queue";
import { toastStyles as styles } from "./styles";

/** Every prop a Toaster takes. */
export interface ToasterProps {
  /**
   * The edge of the window it stands at. Swiping a toast towards it dismisses it.
   * @default "bottom"
   */
  side?: "top" | "bottom";
  /**
   * Where along that edge: `end` (the right in English) beside the work, `center` for a
   * message about the whole page. Start and end follow the reading direction.
   * @default "end"
   */
  align?: "start" | "center" | "end";
  /**
   * How many toasts show at once. Older ones wait, their timers stopped, until there is room.
   * @default 3
   */
  maxVisible?: number;
  /** Keep the stack open, each toast whole. Otherwise it opens under a pointer or focus. */
  expanded?: boolean;
  /** The queue it shows, from `createToaster()`. Leave it out for the page's own `toast`. */
  toaster?: ToasterQueue<ReactNode>;
  /**
   * The region's name for a screen reader, in the page's language.
   * @default "Notifications"
   */
  label?: string;
  /**
   * What a toast's action says when its work failed, in the page's language. The toast stays.
   * @default "Could not finish"
   */
  failedLabel?: string;
  /**
   * The key that moves focus to the newest toast and back. `null` turns it off.
   * @default "F6"
   */
  shortcut?: string | null;
  /**
   * What a screen reader hears once an action has been working for a second, in the page's language.
   * @default "Still working"
   */
  pendingLabel?: string;
  /**
   * The name of the close button a toast that stays shows, in the page's language.
   * @default "Close"
   */
  closeLabel?: string;
}

/** What a toast's `data` may carry: `icon` replaces its type's icon, `null` leaves it without one. */
export interface ToastLook {
  icon?: IconData | null;
}

const icons: Partial<Record<ToastType, IconData>> = {
  success: Done,
  error: Failed,
  warning: Warning,
  info: Info,
  loading: Spinner,
};

/** A toast's icon: its own (`null` for none) or its type's. A loading toast keeps its spinner, whatever icon it brings. */
const markOf = (type: ToastType, own: IconData | null | undefined) => {
  if (type === "loading") {
    return icons.loading;
  }
  return own === null ? undefined : (own ?? icons[type]);
};

/** An action's or a cancel's words, as a Button takes them. */
// SAFETY: a toast's action and cancel labels are the words the page wrote for a button.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
const wordsOf = (label: ReactNode) => label as ButtonWords;

/** Whether a description says anything: not left out, empty or false. */
const hasWords = (node: ReactNode) =>
  node !== undefined &&
  node !== null &&
  node !== false &&
  node !== "" &&
  node !== 0;

/** The action's words as text, for what it says once done. */
const textOf = (label: ReactNode) =>
  typeof label === "string" || typeof label === "number" ? String(label) : "";

/** The action button's state: working while its Promise runs, failed once it rejected. */
const actionState = (state: ToastButtonState) => {
  if (state.pending) {
    return "working";
  }
  return state.error !== undefined && state.error !== null ? "failed" : "idle";
};

/** Where toasts appear. Place it once, near the root of the page. */
export const Toaster = ({
  side = "bottom",
  align = "end",
  maxVisible = 3,
  expanded,
  toaster,
  label = "Notifications",
  failedLabel = "Could not finish",
  shortcut = "F6",
  pendingLabel = "Still working",
  closeLabel = "Close",
}: ToasterProps) => (
  <RegionPrimitive
    toaster={queueOf(toaster ?? toast)}
    shortcut={shortcut}
    pendingAnnouncement={pendingLabel}
    side={side}
    align={align}
    maxVisible={maxVisible}
    expanded={expanded}
    aria-label={label}
    {...stylex.props(styles.region, styles[side], styles[align])}
  >
    {(data) => {
      const type = data.type ?? "default";
      // A toast's own icon first (`data.icon`), `null` for none; otherwise its type's.
      // SAFETY: a toast's data is what the page gave toast(), which the types call a ToastLook.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
      const own = (data.data as ToastLook | undefined)?.icon;
      const mark = markOf(type, own);
      const top = side === "top";
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
            !mark && styles.noIcon,
            stays && (mark ? styles.closable : styles.closableNoIcon)
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
          {mark && (
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
            {hasWords(data.description) ? (
              <DescriptionPrimitive {...stylex.props(styles.description)} />
            ) : null}
            {data.action !== undefined || data.cancel !== undefined ? (
              <div {...stylex.props(styles.actions)}>
                {data.cancel ? (
                  <ClosePrimitive
                    action={data.cancel.onCancel}
                    render={(props: Record<string, unknown>) => (
                      <Button {...props} variant="ghost" size="sm">
                        {wordsOf(data.cancel?.label)}
                      </Button>
                    )}
                  />
                ) : null}
                {data.action ? (
                  <ActionPrimitive
                    render={(props, state: ToastButtonState) => {
                      const words = textOf(data.action?.label);
                      // A Promise from the action shows its work, and a failure says so, as a Button does.
                      const current = actionState(state);
                      return (
                        <Button
                          {...props}
                          variant="quiet"
                          size="sm"
                          state={current}
                          doneLabel={words}
                          failedLabel={failedLabel}
                        >
                          {wordsOf(data.action?.label)}
                        </Button>
                      );
                    }}
                  />
                ) : null}
              </div>
            ) : null}
          </div>
          {stays ? (
            <span {...stylex.props(styles.close, styles.content)}>
              <ClosePrimitive
                render={(props: Record<string, unknown>) => (
                  <Button
                    {...props}
                    variant="ghost"
                    size="xs"
                    icon={Cross}
                    label={closeLabel}
                  />
                )}
              />
            </span>
          ) : null}
        </ToastPrimitive>
      );
    }}
  </RegionPrimitive>
);
