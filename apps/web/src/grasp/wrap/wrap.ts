// Wrap: how interface words break, in every component that shows them (a label, a note, an
// alert, a button, a badge, a card, a select's value). One rule: words hyphenate only when long,
// and never close to their ends. A short word ("already") is never cut; a long one (a Dutch
// compound, "aansprakelijkheidsverzekering", in a narrow column) breaks with a hyphen where its
// language allows, not mid-letter without one. Hyphenation follows the page's `lang`.
//
//   <p {...stylex.props(styles.note, wrap.words)}>…</p>
//
// The limit is `hyphenate-limit-chars: 12 5 5` (a word of 12 letters or more, 5 kept before and
// after a break), which Chromium and Firefox read. Safari reads its own two
// (`-webkit-hyphenate-limit-before` and `-after`, 5 each), so there too no word of fewer than 10
// letters breaks. Where hyphenation is not on (no dictionary for the language), a word too long for
// its line still breaks where it must, by the part's own overflow-wrap.
import * as stylex from "@stylexjs/stylex";

const styles = stylex.create({
  words: {
    hyphens: "auto",
    hyphenateLimitChars: "12 5 5",
    WebkitHyphenateLimitBefore: 5,
    WebkitHyphenateLimitAfter: 5,
  },
});

/** The one way interface words hyphenate: only a long word, never near its ends. */
export const wrap = { words: styles.words };
