// What Tool shows as code (tool.tsx): a call's input or output as words. Pure, so tested without a
// page (scripts/tool-code.test.ts).

/**
 * A value as code: text as it is, anything else as JSON; as text when JSON cannot hold it (a
 * BigInt, a value that holds itself), so a strange output never breaks the page.
 */
export const codeOf = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
};
