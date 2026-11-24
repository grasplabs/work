import { colors, media, radius } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { createContext, use, useEffect, useRef } from "react";
import type { ReactNode } from "react";

import { attachField, attendField, poseField, releaseField } from "./engine.ts";
import type { Pose } from "./engine.ts";

// Stephen in the setup: never a figure, always the light behind the page.
// One canvas the size of the window under the page, drawn by one shader
// (shader.ts, engine.ts). Any part of a screen reaches him through
// `useField`: `attend` an element and he gathers round it, `release` it
// and his light fades there; anything that can be pressed, chosen or typed
// in reaches him by itself, on every screen. Each screen gives him a `pose`, so he rests in
// another place and moves at another pace on every one. He is one for the
// whole app (the engine keeps him), so a screen drawn anew, as when the
// language changes, finds him as he was. Decoration: hidden from assistive
// tech, not drawn in forced colours, and under reduced motion still. Where
// WebGL can't run there is no light.

const styles = stylex.create({
  layer: {
    position: "fixed",
    inset: 0,
    zIndex: -1,
    width: "100%",
    height: "100%",
    pointerEvents: "none",
    imageRendering: "pixelated",
    display: { default: "block", [media.forcedColors]: "none" },
  },
  // Where he listens for what is under the pointer or the keyboard's focus; no box of its own.
  listening: { display: "contents" },
  // His line on the edge of a thing he holds: placed and shown by the engine, a frame at a time.
  ring: {
    position: "fixed",
    insetBlockStart: 0,
    insetInlineStart: 0,
    zIndex: 1,
    pointerEvents: "none",
    opacity: 0,
    cornerShape: radius.shape,
    boxShadow: `0 0 0 2px ${colors.mint}`,
    display: { default: "block", [media.forcedColors]: "none" },
  },
});

/** What he comes to: anything that can be pressed, chosen or typed in. */
const ALIVE =
  "button, a[href], input, textarea, select, [role=button], [role=radio], [role=option], [role=checkbox], [role=switch], [role=tab]";

/** How many rings: as many things as he lights at once. */
const RINGS = 4;

/**
 * The thing to press an event happened on, if any. A row whose press is
 * its title (Damsko's Item: the title's target is stretched over the row)
 * is the row itself, so he lies round all of it, not round its words.
 */
const aliveAt = (target: EventTarget | null): Element | null => {
  const press = target instanceof Element ? target.closest(ALIVE) : null;
  if (press?.closest("[data-slot=item-title]") === null || press === null) {
    return press;
  }
  return press.closest("[data-slot=item]") ?? press;
};

export interface Field {
  /** He gathers round an element; `null` lets go of all. */
  attend: (element: Element | null) => void;
  /** He lets go of this element, if he is still on it. */
  release: (element: Element) => void;
}

/** Stephen himself: one for the whole app, whatever screen draws him. */
const field: Field = { attend: attendField, release: releaseField };

const FieldContext = createContext<Field>(field);

export const useField = (): Field => use(FieldContext);

export const StephenField = ({
  pose,
  children,
}: {
  /** Where he rests on this screen and how he moves there. */
  pose: Pose;
  children: ReactNode;
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const rings = useRef<(HTMLSpanElement | null)[]>([]);
  useEffect(() => {
    if (canvas.current === null) {
      return () => {
        // Nothing started.
      };
    }
    const stop = attachField(
      canvas.current,
      rings.current.filter((ring) => ring !== null)
    );
    return () => {
      stop?.();
    };
  }, []);
  useEffect(() => {
    poseField(pose);
  }, [pose]);
  return (
    <FieldContext value={field}>
      <canvas aria-hidden="true" ref={canvas} {...stylex.props(styles.layer)} />
      {/* He comes to whatever is pressed, chosen or typed in, on every screen, and lets go once it is left. */}
      <div
        onBlur={(event) => {
          const left = aliveAt(event.target);
          if (left !== null) {
            releaseField(left);
          }
        }}
        onFocus={(event) => {
          attendField(aliveAt(event.target));
        }}
        onPointerOut={(event) => {
          const left = aliveAt(event.target);
          if (left !== null && !left.contains(aliveAt(event.relatedTarget))) {
            releaseField(left);
          }
        }}
        onPointerOver={(event) => {
          const over = aliveAt(event.target);
          if (over !== null) {
            attendField(over);
          }
        }}
        {...stylex.props(styles.listening)}
      >
        {children}
      </div>
      {Array.from({ length: RINGS }, (_, slot) => (
        <span
          aria-hidden="true"
          key={slot}
          ref={(ring) => {
            rings.current[slot] = ring;
          }}
          {...stylex.props(styles.ring)}
        />
      ))}
    </FieldContext>
  );
};
