/**
 * Adding an organization: its web address made from its name as staff
 * type it, to put right before it is created (it can't change after).
 */
import { maxClientIdLength } from "../provision/client-id.ts";

const accents = /\p{M}/gu;
const notInAnAddress = /[^a-z0-9]+/gu;
const dashesAtEnds = /^-+|-+$/gu;

/**
 * `name` as a web address: accents dropped, lowercase letters and digits,
 * everything else one dash, no dash at either end, at most as long as an
 * address may be.
 */
export const slugOf = (name: string): string =>
  name
    .normalize("NFKD")
    .replaceAll(accents, "")
    .toLowerCase()
    .replaceAll(notInAnAddress, "-")
    .replaceAll(dashesAtEnds, "")
    .slice(0, maxClientIdLength)
    .replaceAll(dashesAtEnds, "");

/** The domain of an email address, lowercase; empty when it has none. */
export const domainOfEmail = (email: string): string => {
  const at = email.lastIndexOf("@");
  return at === -1
    ? ""
    : email
        .slice(at + 1)
        .trim()
        .toLowerCase();
};
