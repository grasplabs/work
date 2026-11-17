// Export: rows as CSV, saved as a file the browser downloads.

// Words that start like a formula (=, +, -, @, a tab or a return) run as one when a spreadsheet
// opens the file: a leading apostrophe keeps them text. Figures are numbers and are left alone.
const formula = /^[=+\-@\t\r]/u;

const cell = (value: string | number) => {
  const text =
    typeof value === "string" && formula.test(value)
      ? `'${value}`
      : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

/** The head and the rows as CSV, each line ended as a spreadsheet expects. */
export const toCsv = (
  head: readonly string[],
  rows: readonly (readonly (string | number)[])[]
) => [head, ...rows].map((line) => line.map(cell).join(",")).join("\r\n");

/** Saves the text as a file of that name. */
export const save = (text: string, name: string) => {
  const href = URL.createObjectURL(
    new Blob([text], { type: "text/csv;charset=utf-8" })
  );
  const link = document.createElement("a");
  link.href = href;
  link.download = name.endsWith(".csv") ? name : `${name}.csv`;
  link.click();
  // Freed once the download has started, not before: some browsers drop a download whose address
  // is gone by the time they read it.
  setTimeout(() => {
    URL.revokeObjectURL(href);
  }, 0);
};
