// Link: words that go somewhere, drawn as plain words with a soft underline: the words in the colour
// around them, an underline in ink at 30% that takes the words' colour under the pointer, the
// shared focus style for words, and a mark after a link that leaves the product.
//
//   <p>Read the <Link href="/guides/sharing">sharing guide</Link> first.</p>
//   <Link href="/reports" variant="plain">View all reports</Link>
//   <Link href="https://status.example.com" external>Status page</Link>
//   <Link asChild><RouterLink to="/reports">Reports</RouterLink></Link>
//
// Plain semantic HTML (an `a`): a link needs no primitive. It knows no router: a router's own link
// comes in as the child, with `asChild`. A caller may set layout only (the `style` prop).
import * as stylex from "@stylexjs/stylex";
import { mergeProps, renderElement } from "@ui-sdk/react/primitive";
import { createElement, isValidElement } from "react";
import type { AnchorHTMLAttributes, ReactNode } from "react";

import { useI18n } from "../lib/i18n";
import { ArrowUpRightIcon, Icon } from "../lib/icons";
import { focusRingText, tapTarget, visuallyHidden } from "../lib/styles";
import {
  colors,
  duration,
  font,
  media,
  radius,
  size,
  space,
} from "../lib/tokens.stylex";
import type { LayoutStyle } from "../lib/utils";
import { iconVars, motionVars } from "../lib/vars.stylex";

/** How a link stands: inside a sentence, or on its own. */
export type LinkVariant = "underline" | "plain";

/** Every prop a Link takes: these, and the rest of an `a`'s (`download`, `hrefLang`, `rel`). */
export interface LinkProps extends Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "className" | "style" | "children"
> {
  /**
   * The words: where it goes, said plainly ("Sharing guide"), never "Click here". With `asChild`,
   * the one element drawn as the link (a router's own link), holding the words.
   */
  children: ReactNode;
  /** Where it goes. Leave it out with `asChild` when the child carries it. */
  href?: string;
  /**
   * Draws the child instead of an `a` (`<Link asChild><RouterLink to="/reports">Reports</RouterLink></Link>`):
   * it gets the look, the external mark and the props given here, and keeps its own.
   * @default false
   */
  asChild?: boolean;
  /**
   * `underline` inside a sentence: the sentence's own colour and size, always underlined, so it is
   * found without colour. `plain` on its own line ("View all reports"): foreground, medium,
   * underlined only under the pointer.
   * @default "underline"
   */
  variant?: LinkVariant;
  /**
   * It leaves the product: it opens in a new tab, safely (`rel="noopener noreferrer"`, in place
   * of any `rel` given), with a mark after its words, and a screen reader hears "opens in a new
   * tab" (`link.external` in the I18nProvider).
   * @default false
   */
  external?: boolean;
  /** Layout only: margins and alignment. The look belongs to the link. */
  style?: LayoutStyle;
}

const styles = stylex.create({
  link: {
    borderRadius: radius.sm,
    cornerShape: radius.shape,
    textDecorationLine: "underline",
    textDecorationThickness: size.linkUnderlineWidth,
    textUnderlineOffset: size.linkUnderlineOffset,
    // Under the pointer the line takes the words' own colour; in forced colours it is the link's.
    textDecorationColor: {
      default: colors.linkUnderline,
      [media.hover]: {
        default: colors.linkUnderline,
        ":hover": "currentColor",
      },
      [media.forcedColors]: "LinkText",
    },
    transitionProperty: "text-decoration-color",
    transitionDuration: motionVars.hover,
    transitionTimingFunction: duration.ease,
    cursor: "pointer",
  },
  // In a sentence: its colour, size and weight, so a link never changes the line it is in.
  underline: {
    color: "inherit",
  },
  // On its own: the system's words, with no line until the pointer is on it. On a touch screen an
  // unseen area makes it 44px each way, as a Button's; in a sentence the words around it are the room.
  plain: {
    position: "relative",
    fontFamily: font.sans,
    fontWeight: font.weightMedium,
    color: { default: colors.foreground, [media.forcedColors]: "LinkText" },
    textDecorationColor: {
      default: "transparent",
      [media.hover]: { default: "transparent", ":hover": "currentColor" },
      [media.forcedColors]: "LinkText",
    },
  },
  // The mark sits on the words' line, a step under their size.
  mark: {
    display: "inline-flex",
    verticalAlign: "-0.1em",
    marginInlineStart: size.linkMarkGap,
    [iconVars.size]: size.linkMark,
    // While the link's words fade in (Markdown writing an answer step by step), the mark arrives
    // with them, at the step its newest words are at.
    opacity: {
      default: null,
      ':is([data-arrive-step="0"] *)': 0.14,
      ':is([data-arrive-step="1"] *)': 0.3,
      ':is([data-arrive-step="2"] *)': 0.45,
      ':is([data-arrive-step="3"] *)': 0.58,
      ':is([data-arrive-step="4"] *)': 0.7,
      ':is([data-arrive-step="5"] *)': 0.8,
      ':is([data-arrive-step="6"] *)': 0.88,
      ':is([data-arrive-step="7"] *)': 0.95,
    },
  },
  // The mark's drawing ends short of its box (the arrow's own room, about 0.27 of its size), so the
  // focus ring would stand further off its end than off the words' start. The mark's box stops
  // where the drawing does (the cut room is empty) and the link gives that room back as margin:
  // the ring sits as far off the arrow as off the first letter, and nothing after the link moves.
  external: {
    // Its own direction run, so in a right-to-left page the mark stands at the words' logical end
    // (their left), where the cut is, even when the words are left-to-right ones.
    unicodeBidi: "isolate",
    // One box for the ring in every engine: as an inline box Firefox draws the outline round each
    // direction fragment (two rings, a double bar between arrow and words, in right to left) and
    // WebKit rounds the fragments' edges unevenly. An inline block is one rectangle; an external
    // link is a name, short enough to keep to one line, so it does not wrap.
    display: "inline-block",
    // An isolated box takes the word space beside it into its own run: in right to left the space
    // falls on the far side, and the ring's outer edge (its offset and width, 2.5px) stood 0.8px
    // off the next word. A quarter step each side gives the ring its room from the words around
    // it, in either direction; it is there at rest, so nothing moves on focus.
    marginInlineStart: `calc(${space["1"]} / 4)`,
    marginInlineEnd: `calc(${size.linkMark} * 0.27 + ${space["1"]} / 4)`,
  },
  markCut: {
    width: `calc(${size.linkMark} * 0.73)`,
    overflow: "hidden",
  },
});

export const Link = ({
  children,
  href,
  asChild = false,
  variant = "underline",
  external = false,
  style,
  target,
  rel,
  ...rest
}: LinkProps) => {
  const { link: words } = useI18n();
  // With asChild the words are the child's own; the external mark goes after them, inside it.
  const own =
    asChild && isValidElement<{ children?: ReactNode }>(children)
      ? children
      : undefined;
  const content = (
    <>
      {variant === "plain" ? (
        <span aria-hidden="true" {...stylex.props(tapTarget)} />
      ) : null}
      {own === undefined ? children : own.props.children}
      {external ? (
        <>
          <span {...stylex.props(styles.mark, styles.markCut)}>
            <Icon icon={ArrowUpRightIcon} />
          </span>
          <span
            {...stylex.props(visuallyHidden)}
          >{` (${words.external})`}</span>
        </>
      ) : null}
    </>
  );
  // The child is drawn with the link's props under its own, and the words and mark inside it.
  const render =
    own === undefined
      ? undefined
      : (props: Record<string, unknown>) =>
          createElement(own.type, mergeProps(props, own.props), content);
  return renderElement(
    "a",
    {
      ...rest,
      href,
      target: external ? "_blank" : target,
      // An external link always takes these two words, written out so a linter can see them; a
      // caller's own `rel` is for a link that stays in the product.
      rel: external ? "noopener noreferrer" : rel,
      "data-slot": "link",
      "data-variant": variant,
      ...stylex.props(
        styles.link,
        variant === "plain" ? styles.plain : styles.underline,
        focusRingText,
        external && styles.external,
        style
      ),
      children: content,
    },
    render
  );
};
