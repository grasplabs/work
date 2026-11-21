// Breadcrumb's own words, in English. The product gives them in its languages through GraspWords
// (src/words); a caller's `aria-label` and `hiddenLabel` still win until the breaking release's step 5.
export const breadcrumbWords = {
  /** Its name, as a navigation landmark. */
  name: "Breadcrumb",
  /** The button that shows the levels folded away in the middle. */
  hidden: "Show hidden levels",
};

export type BreadcrumbWords = typeof breadcrumbWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    breadcrumb: BreadcrumbWords;
  }
}
