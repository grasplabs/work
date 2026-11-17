// The words App building shows and says, in English. A product passes its own through `label` and
// `cursors`; any cursor name it leaves out is one of these.

/** The names on the cursors' tags, by what each builds. */
export interface AppBuildingCursors {
  /** The cursor that lays the frame out: the top bar and the sidebar. */
  layout: string;
  /** The cursor that builds the data: the chart and the table. */
  data: string;
  /** The cursor that writes the words: the cards. */
  copy: string;
}

export const englishCursors: AppBuildingCursors = {
  layout: "Layout",
  data: "Data",
  copy: "Copy",
};

/** The whole thing's name, said to a screen reader. */
export const englishLabel = "Building your app";

/** The cursors' names in the order the layouts number them (layouts.ts, builderOf). */
export const cursorNames = (
  cursors: Partial<AppBuildingCursors> | undefined
): readonly string[] => {
  const names = { ...englishCursors, ...cursors };
  return [names.layout, names.data, names.copy];
};
