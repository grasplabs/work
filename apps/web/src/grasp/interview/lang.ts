// One rule for words across Interview's parts: without the text's language, no automatic hyphens
// (so English never reads "re-minding") and a long word breaks only where it would run out of its
// box (`overflow-wrap: anywhere`, on each part's words); with it (`lang`), words hyphenate by that
// language's rules, so Dutch compounds break where they should. Set on each part's root, so it
// reaches every word inside by inheritance.
import * as stylex from "@stylexjs/stylex";

import { hasWords } from "./read";

const styles = stylex.create({
  manual: { hyphens: "manual" },
  auto: { hyphens: "auto" },
});

/** A part's language and its words' rule: the part's own `lang`, else its interview's. */
export const langOf = (own: string | undefined, shared: string | undefined) => {
  const lang = hasWords(own) ? own : shared;
  return {
    lang: hasWords(lang) ? lang : undefined,
    words: hasWords(lang) ? styles.auto : styles.manual,
  };
};
