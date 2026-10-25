// What the Word and OneNote readers share in turning markup into text.

/** A named entity or a character reference, `&amp;`, `&#8364;`, `&#x20AC;`. */
const reference = /&(?:#x(?<hex>[\da-fA-F]+)|#(?<decimal>\d+)|(?<name>\w+));/gu;

/** The highest code point. */
const maxCodePoint = 0x10_ff_ff;

const characterOf = (
  whole: string,
  { hex, decimal, name }: Partial<Record<"hex" | "decimal" | "name", string>>,
  names: Readonly<Record<string, string>>
): string => {
  if (name !== undefined) {
    return names[name] ?? whole;
  }
  const code = hex === undefined ? Number(decimal) : Number.parseInt(hex, 16);
  return code > 0 && code <= maxCodePoint ? String.fromCodePoint(code) : whole;
};

/**
 * `text` with its character references, and the entities `names` names,
 * as the characters they stand for; any other left as it is.
 */
export const decoded = (
  text: string,
  names: Readonly<Record<string, string>>
): string => {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(reference)) {
    out += text.slice(last, match.index);
    out += characterOf(match[0], match.groups ?? {}, names);
    last = match.index + match[0].length;
  }
  return out + text.slice(last);
};
