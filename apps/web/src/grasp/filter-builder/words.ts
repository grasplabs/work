// Filter builder's own words, in English. The product gives them in its languages through
// GraspWords (src/words); a caller's placeholders, `aria-label` and `segmentLabels` still win until
// the breaking release's step 5. The fields' and operators' names are the caller's.
export const filterBuilderWords = {
  /** The field's placeholder, before one is chosen. */
  field: "Field",
  /** The operator's placeholder. */
  operator: "Operator",
  /** The value's placeholder. */
  value: "Value",
  /** The condition's name, as a group. */
  name: "Filter condition",
  /** Each segment's name, for a screen reader. */
  segments: {
    field: "Filter field",
    operator: "Filter operator",
    value: "Filter value",
  },
};

export type FilterBuilderWords = typeof filterBuilderWords;

declare module "../words/words" {
  interface GraspWordsCatalog {
    filterBuilder: FilterBuilderWords;
  }
}
