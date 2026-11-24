import { media } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { createContext, use, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import {
  attachField,
  attendField,
  carryField,
  poseField,
  releaseField,
} from "./engine.ts";
import type { Picture, Pose } from "./engine.ts";

// Stephen in the setup: never a figure, always the light behind the page.
// Two canvases the size of the window, one under the page and one over it,
// drawn by one shader (shader.ts, engine.ts). Any part of a screen reaches
// him through `useField`: `attend` an element and he gathers round it;
// `carry` from the element that was pressed and he takes the page to its
// next screen. Each screen gives him a `pose`, so he rests in another place
// and moves at another pace on every one. Decoration: hidden from assistive
// tech, not drawn in forced colours, and under reduced motion still, a
// carry only the page turning. Where WebGL can't run there is no light and
// every carry is only the page turning. He is one for the whole app (the
// engine keeps him), so a screen drawn anew, as when the language changes,
// finds him as he was, in the middle of a carry too.

const styles = stylex.create({
  layer: {
    position: "fixed",
    inset: 0,
    width: "100%",
    height: "100%",
    pointerEvents: "none",
    imageRendering: "pixelated",
    display: { default: "block", [media.forcedColors]: "none" },
  },
  under: { zIndex: -1 },
  over: { zIndex: 1 },
  // While he covers the page nothing under him can be pressed.
  covering: { pointerEvents: "auto" },
});

export interface Field {
  /** He gathers round an element; `null` lets go of all. */
  attend: (element: Element | null) => void;
  /** He lets go of this element, if he is still on it. */
  release: (element: Element) => void;
  /**
   * He carries the page on from the element that was pressed, showing a
   * picture first where he took one from it (a flag), and the page turns
   * under him: `turn` changes the screen and is over once it has.
   */
  carry: (
    from: Element,
    picture: Picture,
    turn: () => Promise<void>
  ) => Promise<void>;
}

/** Stephen himself: one for the whole app, whatever screen draws him. */
const field: Field = {
  attend: attendField,
  release: releaseField,
  carry: carryField,
};

/** No field round this part of the page: nothing gathers, and a carry is only the page turning. */
const noField: Field = {
  attend: () => {
    // Nobody to gather.
  },
  release: () => {
    // Nobody to let go.
  },
  carry: async (_from, _picture, turn) => {
    await turn();
  },
};

const FieldContext = createContext<Field>(noField);

export const useField = (): Field => use(FieldContext);

export const StephenField = ({
  pose,
  children,
}: {
  /** Where he rests on this screen and how he moves there. */
  pose: Pose;
  children: ReactNode;
}) => {
  const under = useRef<HTMLCanvasElement>(null);
  const over = useRef<HTMLCanvasElement>(null);
  const [covering, setCovering] = useState(false);
  // Before the page is shown: a screen drawn anew under a carry is covered from its first frame.
  useLayoutEffect(() => {
    if (under.current === null || over.current === null) {
      return () => {
        // Nothing started.
      };
    }
    const stop = attachField(under.current, over.current, setCovering);
    return () => {
      stop?.();
    };
  }, []);
  useLayoutEffect(() => {
    poseField(pose);
  }, [pose]);
  return (
    <FieldContext value={field}>
      <canvas
        aria-hidden="true"
        ref={under}
        {...stylex.props(styles.layer, styles.under)}
      />
      {children}
      <canvas
        aria-hidden="true"
        ref={over}
        {...stylex.props(
          styles.layer,
          styles.over,
          covering && styles.covering
        )}
      />
    </FieldContext>
  );
};
