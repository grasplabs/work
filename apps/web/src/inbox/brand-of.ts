import { brands } from "../grasp/brand-icon/index.ts";
import type { Brand } from "../grasp/brand-icon/index.ts";

/** Whether `key` is one of the brands, as chat-accounts.tsx asks. */
const isBrand = (key: string): key is Brand => Object.hasOwn(brands, key);

/** A letter or digit: what a whole word may not have beside it. */
const wordCharacter = /[\p{L}\p{N}]/u;

/** Whether `name` holds `brand` as a whole word ("Slack (ops)", "Microsoft 365"). */
const names = (name: string, brand: string): boolean => {
  const at = name.indexOf(brand);
  if (at === -1) {
    return false;
  }
  const before = at === 0 ? " " : (name[at - 1] ?? " ");
  const after = name[at + brand.length] ?? " ";
  return !wordCharacter.test(before) && !wordCharacter.test(after);
};

/**
 * The brand a connection's name names, as its icon stands for it: the
 * first brand whose own name is a whole word of it. None when it names
 * none; a guess is never drawn.
 */
export const brandOf = (name: string): Brand | undefined => {
  const lower = name.toLowerCase();
  const found = Object.entries(brands).find(([, brand]) =>
    names(lower, brand.name.toLowerCase())
  );
  return found !== undefined && isBrand(found[0]) ? found[0] : undefined;
};
