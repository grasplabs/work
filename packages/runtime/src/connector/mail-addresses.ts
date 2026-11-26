// The addresses of a mail header (`From`, `To`), read in one pass. Here,
// not in a connector, so connect reads the headers of the mail it watches
// (google-events.ts) without running any connector's code outside its
// isolate.

/** An address, as a header names it: `Name <address>`, or the address. */
export interface Address {
  name: string | null;
  address: string | null;
}

/** Splits an address list at its commas, but not those in quotes or `<>`. */
const splitAddresses = (value: string): string[] => {
  const found: string[] = [];
  let current = "";
  let quoted = false;
  let angled = false;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      escaped = false;
    } else if (character === "\\" && quoted) {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && character === "<") {
      angled = true;
    } else if (!quoted && character === ">") {
      angled = false;
    } else if (!(quoted || angled) && character === ",") {
      found.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  found.push(current);
  return found.map((each) => each.trim()).filter((each) => each !== "");
};

/**
 * `Name <address>` split at its last `<`, with no regex: a sender writes
 * the header, and a pattern that backtracks would let one header stall
 * whatever reads it. `null` for a bare address.
 */
const namedAddress = (
  value: string
): { name: string; address: string } | null => {
  const open = value.lastIndexOf("<");
  if (open === -1 || !value.endsWith(">")) {
    return null;
  }
  const address = value.slice(open + 1, -1);
  return address.includes(">")
    ? null
    : { name: value.slice(0, open).trimEnd(), address };
};

/** A display name, unquoted, with its escapes (`\"`) undone. */
const unquoted = (name: string): string => {
  const inner =
    name.length >= 2 && name.startsWith('"') && name.endsWith('"')
      ? name.slice(1, -1)
      : name;
  let plain = "";
  let escaped = false;
  for (const character of inner) {
    if (!escaped && character === "\\") {
      escaped = true;
      continue;
    }
    escaped = false;
    plain += character;
  }
  return plain.trim();
};

/**
 * The addresses of an address header (`From`, `To`), in order. Linear in
 * the header's length, however a sender writes it.
 */
export const addressesOf = (value: string | undefined): Address[] =>
  splitAddresses(value ?? "").map((each) => {
    const named = namedAddress(each);
    if (named === null) {
      return { name: null, address: each };
    }
    const name = unquoted(named.name);
    const address = named.address.trim();
    return {
      name: name === "" ? null : name,
      address: address === "" ? null : address,
    };
  });
