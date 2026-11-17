// Arrive: how content comes in after it has loaded, in Damsko. It fades in over duration-mark on
// the one ease, where its placeholder stood: the placeholder goes at once, the content takes its
// exact place, so nothing moves. With reduced motion it is there at once. Like src/focus/focus.ts,
// it is one shared style:
//
//   {loading ? <Skeleton /> : <span {...stylex.props(arrive.in)}>{name}</span>}
//
// Give it to what replaces a placeholder, never to what was there on the first paint, so a page does
// not fade in as it opens. The words of an answer still being written fade in another way, with no
// element round them: arrive-highlight.ts.
import * as stylex from "@stylexjs/stylex";

import { grasp, media } from "../tokens/tokens.stylex";

const fade = stylex.keyframes({
  from: { opacity: 0 },
  to: { opacity: 1 },
});

export const arrive = stylex.create({
  in: {
    animationName: { default: fade, [media.reduced]: "none" },
    animationDuration: grasp.durationMark,
    animationTimingFunction: grasp.ease,
    animationFillMode: "both",
  },
  // For a picture that shows once it has loaded (UI SDK marks it so): it fades in at that moment.
  whenLoaded: {
    animationName: {
      default: "none",
      ":is([data-loading-status=loaded])": {
        default: fade,
        [media.reduced]: "none",
      },
    },
    animationDuration: grasp.durationMark,
    animationTimingFunction: grasp.ease,
    animationFillMode: "both",
  },
});
