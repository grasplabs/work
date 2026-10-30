import { Stat } from "@grasp-os/ui/components/stat";
// An export's key figures as tiles, as the prototype's board report sets
// them (`lib/report.ts`, `.tiles`): each figure in Newsreader
// (the kit's Stat) over what it counts, side by side in one bordered row.
// The report dialog shows them as the page it prints from does.

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
}) =>
  figures.length === 0 ? null : (
    <dl className="bg-border grid break-inside-avoid grid-cols-2 gap-px overflow-hidden rounded-xl border sm:grid-cols-4">
      {figures.map(({ key, value, label }) => (
        // The value stands over its label, as the prototype's tile; the
        // label still comes first to a screen reader, as a list says it.
        <div
          className="bg-card flex flex-col-reverse gap-1 px-4 py-3"
          key={key}
        >
          <dt className="text-muted-foreground text-xs">{label}</dt>
          <Stat render={<dd />}>{value}</Stat>
        </div>
      ))}
    </dl>
  );
