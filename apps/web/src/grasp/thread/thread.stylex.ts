// The thread's lead (thread.tsx): how far the rows' box stands down from the top of its scroller
// while a wheel or a touch scroll is under way. The corrections that measuring rows above the view
// would write to the scroll are taken up here instead, as a write to the scroll cuts WebKit's wheel
// short; when the scroll ends the lead goes back into the scroll, in one step nobody sees.
import * as stylex from "@stylexjs/stylex";

export const threadVars = stylex.defineVars({
  lead: "0px",
});
