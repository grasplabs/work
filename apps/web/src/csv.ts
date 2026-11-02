// CSV files handed to the reader, made in the browser, as the prototype
// makes them (`lib/download.ts`).

const formulaStart = /^\s*[=+\-@]|^[\t\r]/u;
const csvSpecial = /[",\r\n]/u;

/** A cell as CSV: quoted where it has to be, and never read as a formula. */
const csvCell = (value: string): string => {
  const safe = formulaStart.test(value) ? `'${value}` : value;
  return csvSpecial.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

/** Rows as CSV, each cell quoted where it has to be. */
export const toCsv = (rows: readonly (readonly string[])[]): string =>
  rows.map((row) => row.map(csvCell).join(",")).join("\n");

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
