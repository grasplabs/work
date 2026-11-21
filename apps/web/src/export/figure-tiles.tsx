import { useLingui } from "@lingui/react/macro";

import { StatsGrid } from "../grasp/stats/index.ts";

// An export's key figures as tiles, as the prototype's board report sets
// them (`lib/report.ts`, `.tiles`): Grasp UI's Stats, each figure over
// what it counts, side by side. The report dialog shows them as the page
// it prints from does.

/** One key figure: its value, already written in the reader's locale, and what it counts. */
export interface ExportFigure {
  key: string;
  value: string;
  label: string;
}

/** The figures as tiles; nothing when there are none. */
export const FigureTiles = ({
  figures,
}: {
  figures: readonly ExportFigure[];
}) => {
  const { t } = useLingui();
  return figures.length === 0 ? null : (
    <StatsGrid
      aria-label={t`Key figures`}
      items={figures.map(({ value, label }) => ({ title: label, value }))}
    />
  );
};
