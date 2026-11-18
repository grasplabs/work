// Link: words that go somewhere, built for Grasp. shadcn has no link (it styles `a` in prose, and
// its Button has a link variant); Palermo draws its links as plain words with a soft underline.
// This is that: the words in the colour around them, an underline in ink at 30% that takes the
// words' colour under the pointer, the shared focus style for words, and a mark after a link
// that leaves the product.
//
//   <p>Read the <Link href="/guides/sharing">sharing guide</Link> first.</p>
//   <Link href="/reports" variant="standalone">View all reports</Link>
//   <Link href="https://status.example.com" external>Status page</Link>
//
// Plain semantic HTML (an `a`): UI SDK has no link primitive, and a link needs none. Every value
// is a token (src/tokens). A caller may set layout only (the `style` prop).
/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import * as stylex from "@stylexjs/stylex";
import { renderElement } from "@ui-sdk/react/primitive";
import type { RenderProp } from "@ui-sdk/react/primitive";
import type { AnchorHTMLAttributes, ReactNode } from "react";

import { focus } from "../focus/focus";
import { visuallyHidden } from "../hidden/hidden";
import { External, Icon } from "../icons";
import { iconVars } from "../icons/icon.stylex";
import type { LayoutStyle } from "../layout/layout";
import { simply } from "../motion/simply.stylex";
import { grasp, media } from "../tokens/tokens.stylex";
import { useWords, withGiven } from "../words/words";
import { linkWords } from "./words";

/** What a caller may style: where the link sits. Never its look. */
export type LinkLayoutStyle = LayoutStyle;

/** How a link stands: inside a sentence, or on its own. */
export type LinkVariant = "inline" | "standalone";

/** Every prop a Link takes: these, and the rest of an `a`'s (`download`, `hrefLang`, `rel`). */
export interface LinkProps extends Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "className" | "style" | "children" | "href"
> {
  /** The words: where it goes, said plainly ("Sharing guide"), never "Click here". */
  children: ReactNode;
  /** Where it goes. Leave it out when `render` is a router's own link that carries it. */
  href?: string;
  /**
   * The element it is drawn as, for a router's link (`render={<RouterLink to="/reports" />}`): it
   * gets the look, the words, the external mark and the props given here, and keeps its own, so
   * no wrapper is needed. Without it, an `<a href>`.
   */
  render?: RenderProp;
  /**
   * `inline` inside a sentence: the sentence's own colour and size, always underlined, so it is
   * found without colour. `standalone` on its own line ("View all reports"): ink, medium,
   * underlined only under the pointer.
   * @default "inline"
   */
  variant?: LinkVariant;
  /**
   * It leaves the product: it opens in a new tab, safely (`rel="noopener noreferrer"`, in place
   * of any `rel` given), with a mark after its words, and a screen reader hears "opens in a new
   * tab".
   * @default false
   */
  external?: boolean;
  /**
   * The words a screen reader hears after an external link's own, in the page's language.
   * @default "opens in a new tab"
   */
  externalLabel?: string;
  /** @deprecated Use `layout`. */
  style?: LinkLayoutStyle;
  /** Layout only: margins and alignment. The look belongs to the link. */
  layout?: LinkLayoutStyle;
}

const styles = stylex.create({
  link: {
    borderRadius: grasp.cornerMark,
    textDecorationLine: "underline",
    textDecorationThickness: grasp.linkUnderlineWidth,
    textUnderlineOffset: grasp.linkUnderlineOffset,
    // Under the pointer the line takes the words' own colour; in forced colours it is the link's.
    textDecorationColor: {
      default: grasp.linkUnderline,
      [media.hover]: { default: grasp.linkUnderline, ":hover": "currentColor" },
      [media.forced]: "LinkText",
    },
    transitionProperty: "text-decoration-color",
    transitionDuration: simply.hover,
    transitionTimingFunction: grasp.ease,
    cursor: "pointer",
  },
  // In a sentence: its colour, size and weight, so a link never changes the line it is in.
  inline: {
    color: "inherit",
  },
  // On its own: the system's words, with no line until the pointer is on it. On a touch screen an
  // unseen area makes it 44px each way, as a Button's; in a sentence the words around it are the room.
  standalone: {
    position: "relative",
    "::after": {
      content: '""',
      position: "absolute",
      insetInline: {
        default: 0,
        [media.coarse]: `min(0px, calc((100% - ${grasp.tap}) / 2))`,
      },
      insetBlock: {
        default: 0,
        [media.coarse]: `min(0px, calc((100% - ${grasp.tap}) / 2))`,
      },
    },
    fontFamily: grasp.fontSans,
    fontWeight: grasp.weightMedium,
    color: { default: grasp.ink, [media.forced]: "LinkText" },
    textDecorationColor: {
      default: "transparent",
      [media.hover]: { default: "transparent", ":hover": "currentColor" },
      [media.forced]: "LinkText",
    },
  },
  // The mark sits on the words' line, a step under their size.
  mark: {
    display: "inline-flex",
    verticalAlign: "-0.1em",
    marginInlineStart: grasp.linkMarkGap,
    [iconVars.size]: grasp.linkMark,
    // While the link's words fade in (an answer being written: src/motion/arrive-highlight.ts),
    // the mark arrives with them, at the step its newest words are at (ARRIVE_STEPS there).
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
    marginInlineStart: `calc(${grasp.space1} / 4)`,
    marginInlineEnd: `calc(${grasp.linkMark} * 0.27 + ${grasp.space1} / 4)`,
  },
  markCut: {
    width: `calc(${grasp.linkMark} * 0.73)`,
    overflow: "hidden",
  },
});

export const Link = ({
  children,
  href,
  render,
  variant = "inline",
  external = false,
  externalLabel: externalGiven,
  style: styleProp,
  layout,
  target,
  rel,
  ...rest
}: LinkProps) => {
  const { external: externalLabel } = withGiven(useWords("link", linkWords), {
    external: externalGiven,
  });
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
        styles[variant],
        focus.words,
        external && styles.external,
        layout ?? styleProp
      ),
      children: (
        <>
          {children}
          {external ? (
            <>
              <span {...stylex.props(styles.mark, styles.markCut)}>
                <Icon icon={External} />
              </span>
              <span
                {...stylex.props(visuallyHidden)}
              >{` (${externalLabel})`}</span>
            </>
          ) : null}
        </>
      ),
    },
    render
  );
};
