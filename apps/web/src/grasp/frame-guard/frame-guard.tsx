// FrameGuard: an iframe that keeps the page's scroll until it is asked for. A framed page takes
// every wheel turn and touch over it and never hands them back, so a page with one inside stops
// scrolling there. The guard lies over the frame as a button: the wheel and touch go to the page;
// a press on it (or Enter, or Space, or Tab into the frame) makes the frame live, and then it takes
// them. A press outside, focus coming back to the page, Escape, or the Done control gives the page
// its scroll back, and the focus to the guard.
//
//   const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
//   const [live, setLive] = useState(false);
//   <div {...stylex.props(styles.box, live && focus.frame)}>   // the box draws its own live ring
//     <iframe ref={setFrame} … />
//     <FrameGuard frame={frame} label="Use the app" hint="Press to use the app" done="Done" onLiveChange={setLive} />
//   </div>
//
// The box holding the frame must be positioned (relative): the guard covers it. A frame sized to
// its own content has nothing to scroll and needs no guard: `guard="never"`. Shared by App preview
// and Artifact viewer. Every value is a token; every word a prop.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import { focus } from "../focus/focus";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { guardMarker } from "./frame-guard.stylex";

/** Every prop a FrameGuard takes. */
export interface FrameGuardProps {
  /** The iframe it guards. */
  frame: HTMLIFrameElement | null;
  /** The guard's name, as a button: what pressing it does ("Use the app"). */
  label: string;
  /** What shows in the box's middle, on a soft veil, under a pointer or with the focus ("Press to use the app"). */
  hint: string;
  /** The name of the control that gives the page its scroll back while the frame is live ("Done"). */
  done: string;
  /** Called when the frame becomes live, or gives the page back: the box shows that it is live. */
  onLiveChange?: (live: boolean) => void;
  /**
   * `always`: the frame waits for a press. `never`: no guard, for a frame sized to its own content,
   * which has nothing to scroll and so never keeps the wheel.
   * @default "always"
   */
  guard?: "always" | "never";
}

const HOVER = media.hover;
// The band of ground round the Done control: the ring's width, and a hairline of ground past it.
const PLATE = `calc(${grasp.ringWidth} + ${grasp.ringOffset} + ${grasp.hairline})`;
const COARSE = media.coarse;

const styles = stylex.create({
  // Over the frame, unseen: the wheel and touch go through to the page round it.
  shield: {
    position: "absolute",
    inset: 0,
    zIndex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    margin: 0,
    padding: grasp.space3,
    borderWidth: 0,
    // Under a pointer or the keyboard's focus the app takes a soft veil and the hint stands in its
    // middle: covering the app is then plainly the state "press to use it", never a chip that
    // happens to hide one row (B-app-preview-01). At rest, and on a touch screen, nothing covers it.
    backgroundColor: {
      default: "transparent",
      ":focus-visible": `color-mix(in oklch, ${grasp.popupFill} 55%, transparent)`,
      ":hover": {
        default: null,
        [HOVER]: `color-mix(in oklch, ${grasp.popupFill} 55%, transparent)`,
      },
    },
    transitionProperty: "background-color",
    transitionDuration: simply.hover,
    transitionTimingFunction: grasp.ease,
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
  },
  hint: {
    paddingBlock: grasp.space1,
    paddingInline: grasp.space3,
    borderRadius: grasp.cornerPill,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.popupFill,
    boxShadow: grasp.liftLow,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    lineHeight: grasp.textSmLine,
    color: grasp.text,
    // Not on a touch screen: there the first tap makes the frame live, and a chip that is always
    // there would always cover a part of the app.
    opacity: {
      default: 0,
      [stylex.when.ancestor(":focus-visible", guardMarker)]: 1,
      [stylex.when.ancestor(":hover", guardMarker)]: { default: 0, [HOVER]: 1 },
    },
    transitionProperty: "opacity",
    transitionDuration: simply.hover,
    transitionTimingFunction: grasp.ease,
  },
  // Live: a small control at the box's foot, at its end, that gives the page back: never at its
  // top corner, where a framed app puts its own actions. Round it runs a band of its own ground
  // (popupFill), a ring's width and a hairline wide, so the system's one ring always falls on that
  // ground and reads 3:1 or more, light and dark, whatever the framed page paints under it: on a
  // light page in the dark theme the ring alone read 1.11:1 (App preview) and 1.27:1 (Artifact
  // viewer). At rest the band and the button read as one pill.
  plate: {
    position: "absolute",
    insetBlockEnd: `calc(${grasp.space2} - ${PLATE})`,
    insetInlineEnd: `calc(${grasp.space2} - ${PLATE})`,
    zIndex: 1,
    display: "flex",
    padding: PLATE,
    borderRadius: grasp.cornerPill,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.popupFill,
    boxShadow: grasp.liftLow,
  },
  done: {
    minHeight: { default: grasp.controlXs, [COARSE]: grasp.tap },
    paddingInline: grasp.space3,
    // In forced colours, where its fill is dropped, a real edge. An edge, not an outline: an
    // outline width set here would win over the ring's (focus.ring), which it did, so Done showed
    // no ring at all for the keyboard (0px).
    borderWidth: { default: 0, [media.forced]: grasp.hairline },
    borderStyle: "solid",
    borderColor: { default: "transparent", [media.forced]: "ButtonText" },
    borderRadius: grasp.cornerPill,
    cornerShape: grasp.cornerShape,
    backgroundColor: grasp.popupFill,
    fontFamily: grasp.fontSans,
    fontSize: grasp.textSm,
    color: grasp.ink,
    cursor: "pointer",
  },
});

/** Listens while the frame is live for what gives the page back. Returns the clean-up. */
const watchRelease = (
  box: HTMLElement,
  frame: HTMLIFrameElement | null,
  release: () => void,
  enter: () => void
) => {
  const blur = () => {
    // The window gives up the focus before the frame holds it: look a moment later, and again a
    // tick on (Firefox moves it later).
    const look = () => {
      if (frame !== null && document.activeElement === frame) {
        enter();
      }
    };
    requestAnimationFrame(look);
    setTimeout(look, 50);
  };
  // The focus back on the page: the page has its scroll back, unless it came to the Done control
  // inside the box, whose own press gives it back (releasing here would put the guard under the
  // pointer, and the same press would make the frame live again).
  const back = () => {
    requestAnimationFrame(() => {
      const at = document.activeElement;
      if (!(at !== null && at !== frame && box.contains(at))) {
        release();
      }
    });
  };
  const press = (event: PointerEvent) => {
    if (!(event.target instanceof Node && box.contains(event.target))) {
      release();
    }
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      release();
    }
  };
  window.addEventListener("blur", blur);
  window.addEventListener("focus", back);
  document.addEventListener("pointerdown", press, true);
  document.addEventListener("keydown", escape);
  return () => {
    window.removeEventListener("blur", blur);
    window.removeEventListener("focus", back);
    document.removeEventListener("pointerdown", press, true);
    document.removeEventListener("keydown", escape);
  };
};

/** Keeps an iframe from taking the page's scroll until it is asked for. */
export const FrameGuard = ({
  frame,
  label,
  hint,
  done,
  onLiveChange,
  guard = "always",
}: FrameGuardProps) => {
  const [live, setLive] = useState(false);
  const button: RefObject<HTMLButtonElement | null> = useRef(null);
  const holder = useRef<HTMLSpanElement>(null);
  // Where the focus goes once the guard is back: to it, when the frame or the Done control had it.
  const [refocus, setRefocus] = useState(false);

  const change = (next: boolean, returnFocus: boolean) => {
    setLive(next);
    onLiveChange?.(next);
    if (next) {
      frame?.focus();
    } else {
      setRefocus(returnFocus);
    }
  };

  useEffect(() => {
    if (!live && refocus) {
      button.current?.focus();
    }
  }, [live, refocus]);

  useEffect(() => {
    const box = holder.current?.parentElement ?? null;
    const stop =
      box === null
        ? null
        : watchRelease(
            box,
            frame,
            () => {
              if (live) {
                // The focus back on the guard when it was in the box (the frame, Done) or nowhere.
                const at = document.activeElement;
                change(
                  false,
                  at === document.body || at === null || box.contains(at)
                );
              }
            },
            () => {
              if (!live) {
                change(true, false);
              }
            }
          );
    return () => {
      stop?.();
    };
  });

  if (guard === "never") {
    return null;
  }
  return (
    <span
      ref={holder}
      data-slot="frame-guard"
      data-live={live ? "" : undefined}
    >
      {live ? (
        <span data-slot="frame-guard-plate" {...stylex.props(styles.plate)}>
          <button
            type="button"
            onClick={() => {
              change(false, true);
            }}
            {...stylex.props(styles.done, focus.ring)}
          >
            {done}
          </button>
        </span>
      ) : (
        <button
          ref={button}
          type="button"
          aria-label={label}
          onClick={() => {
            change(true, false);
          }}
          {...stylex.props(styles.shield, focus.inside, guardMarker)}
        >
          <span aria-hidden="true" {...stylex.props(styles.hint)}>
            {hint}
          </span>
        </button>
      )}
    </span>
  );
};
