// Corners that nest in the composer's card (App shell FRESH.md F71, batch 4): a control at the
// card's corner takes the card's corner less the room between them, so the two curves run the same
// distance apart all the way round. The card says what that corner is (`--grasp-composer-nested`,
// composer.tsx `card` and `compactCard`), and each side of its row says it to its first or its last
// control (`--grasp-composer-first`, `--grasp-composer-last`, composer.tsx `side`); a control further
// in keeps its own corner.
//
// A Button reads the system's corner, so a part that draws one (Add, an action, Send) stands it in
// `nest`, which gives the Button inside the nested corner while it is first or last in its side.
import * as stylex from "@stylexjs/stylex";

export const cornerStyles = stylex.create({
  nest: {
    display: "contents",
    "--grasp-corner": {
      default: null,
      ":first-child:not(:last-child)": "var(--grasp-composer-first)",
      ":last-child:not(:first-child)": "var(--grasp-composer-last)",
      ":only-child":
        "min(var(--grasp-composer-first), var(--grasp-composer-last))",
    },
  },
});
