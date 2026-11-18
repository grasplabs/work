// Tabs' own words, in English. The product gives them in its languages through GraspWords
// (src/words).
export const tabsWords = {
  /** The name of a tab's close button: what it closes. */
  close: (name: string) => `Close ${name}`,
};

export type TabsWords = typeof tabsWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    tabs: TabsWords;
  }
}
