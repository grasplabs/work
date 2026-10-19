// Files the Landscape hands the reader, made in the browser: its CSV
// exports, as the prototype makes them (`lib/download.ts`).

/** Hands the reader a CSV file to save. */
export const downloadCsv = (content: string, filename: string): void => {
  const url = URL.createObjectURL(
    new Blob([content], { type: "text/csv;charset=utf-8" })
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
};

const nonSlug = /[^a-z0-9]+/gu;
const slugEnds = /^-|-$/gu;

/** A name as it goes into a file name: "Microsoft Teams" as "microsoft-teams". */
export const fileSlug = (name: string): string =>
  name.toLowerCase().replaceAll(nonSlug, "-").replaceAll(slugEnds, "");

/** Today as it goes into a file name: "2026-09-29". */
export const fileDate = (): string => new Date().toISOString().slice(0, 10);
