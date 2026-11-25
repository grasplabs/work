// Where a link out of Grasp leads, as the two questions that ask before
// one opens name it: the chat's "Open external link?" (chat/answer-words.tsx)
// and an App page's (link-confirmation.tsx). Both name it as the browser
// will go there, parsed by its URL parser: the host as ASCII, so a
// look-alike name ("pаypal.com" with a Cyrillic а) shows as the punycode
// it is (`xn--…`), and every other character outside ASCII, a bidi
// control or one nobody sees among them, percent-encoded, so nothing in
// it hides or reorders what is read. What is opened is that same address.

/** Where a link leads: its origin and its whole address, all in ASCII. */
export interface LinkAddress {
  readonly origin: string;
  readonly href: string;
}

/**
 * Where `href` leads, read against `base` when it is relative (`//host`),
 * as the browser reads it; none for what isn't a URL.
 */
export const linkAddress = (
  href: string,
  base?: string
): LinkAddress | undefined => {
  try {
    const url = new URL(href, base);
    return { origin: url.origin, href: url.href };
  } catch {
    return undefined;
  }
};
