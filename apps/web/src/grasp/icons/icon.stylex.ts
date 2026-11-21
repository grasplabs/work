// The two values an icon reads from whoever holds it. StyleX does not let a parent style its
// children (shadcn's `[&_svg]:size-4`), so a component that holds an icon sets these variables on
// itself and every Icon inside follows. Set them; never size an icon from outside.
//
//   const styles = stylex.create({ button: { [iconVars.size]: grasp.iconSm } });
import * as stylex from "@stylexjs/stylex";

export const iconVars = stylex.defineVars({
  /** Width and height of the icon. */
  size: "var(--grasp-icon-sm)",
  /** Stroke width, in the icon's 24-unit grid. */
  stroke: "var(--grasp-icon-stroke)",
});
