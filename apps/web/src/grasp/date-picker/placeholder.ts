// The format an empty date field shows, quietly, in the page's own order and separators:
// "mm/dd/yyyy" in en-US, "dd-mm-jjjj" in nl-NL with Dutch words. The words are the page's, so a
// product can translate them; the order and separators come from the locale itself.

/** The words for a date's three parts in a placeholder: day, month, year. */
export type DateFormatLabels = [day: string, month: string, year: string];

/** English: "dd", "mm", "yyyy". */
export const defaultFormatLabels: DateFormatLabels = ["dd", "mm", "yyyy"];

// The marks some locales put round a date to keep its direction; not shown.
const directionMarks = /[‎‏؜]/gu;

/** The format to type a date in, as the placeholder of an empty field. */
export const datePlaceholder = (
  locale: string | undefined,
  labels: DateFormatLabels
) => {
  const words: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {
    day: labels[0],
    month: labels[1],
    year: labels[2],
  };
  // Any date reads the order; the last day of a year has two digits in every part.
  const parts = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "UTC",
  }).formatToParts(Date.UTC(2026, 11, 31));
  return parts
    .map((part) => words[part.type] ?? part.value.replace(directionMarks, ""))
    .join("");
};
