// The kit's own few words follow the page's language: a document's `lang`,
// which the frame of an App's screen takes from the page around it. The
// kit stays free of Lingui (App screens share it), so each part keeps its
// words here in the languages the frontend speaks, and a screen can still
// say them otherwise through the part's `text` prop.

/** The languages the kit speaks besides English. */
type OtherLanguage = "de" | "nl" | "es" | "fr";

/** One part's words, in English and each other language. */
export type Texts<Text> = { readonly en: Text } & Readonly<
  Record<OtherLanguage, Text>
>;

/** The language of the document a screen runs in: English outside one. */
export const documentLanguage = (): string =>
  typeof document === "undefined" ? "en" : document.documentElement.lang;

/** `texts` in `language` (`de`, `de-AT`, …), English for any other. */
export const textIn = <Text>(texts: Texts<Text>, language: string): Text => {
  const base = language.toLowerCase().split("-")[0] ?? "";
  return base === "de" || base === "nl" || base === "es" || base === "fr"
    ? texts[base]
    : texts.en;
};

/** `texts` in the page's language. */
export const pageText = <Text>(texts: Texts<Text>): Text =>
  textIn(texts, documentLanguage());
