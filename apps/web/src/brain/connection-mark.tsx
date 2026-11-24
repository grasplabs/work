import { BrandIcon } from "@grasp-os/ui/components/brand-icon";
import { ItemMedia } from "@grasp-os/ui/components/item";
import { size } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";

import { brands } from "../connections/brands.ts";
import type { Brand } from "../connections/brands.ts";
import { IntegrationsIcon } from "../frame/integrations-icon.tsx";

// A connection's mark on the Sources page, as #2503 draws it, in the middle of its row: the
// brand its name names, its own mark with no tile beside the words; else the mark of a
// connection. Core gives these rows a name alone (no connector id, no logo: `connectionsOf` in
// brain-rpc.ts, `connections()` in brain-sources-rpc.ts), so the name is what finds the brand.
// Damsko's icons have no cable (logged); the product's own mark for an integration, the
// sidebar's, stands in.

/** Whether `key` is one of the brands the product draws. */
const isBrand = (key: string): key is Brand => Object.hasOwn(brands, key);

/** A letter or digit: what a whole word may not have beside it. */
const wordCharacter = /[\p{L}\p{N}]/u;

/** Whether `name` holds `word` as a whole word ("Microsoft 365", "Slack (ops)"). */
const holds = (name: string, word: string): boolean => {
  const at = name.indexOf(word);
  if (at === -1) {
    return false;
  }
  const before = name[at - 1] ?? " ";
  const after = name[at + word.length] ?? " ";
  return !wordCharacter.test(before) && !wordCharacter.test(after);
};

/**
 * The brand a connection's name names: the first whose own name is a whole word of it, in any
 * case. None when it names none; a guess is never drawn.
 */
export const brandOf = (name: string): Brand | undefined => {
  const lower = name.toLowerCase();
  const found = Object.entries(brands).find(([, brand]) =>
    holds(lower, brand.name.toLowerCase())
  );
  return found !== undefined && isBrand(found[0]) ? found[0] : undefined;
};

const styles = stylex.create({
  // At the size and stroke of the house icons, in the middle of a brand mark's room, so every
  // connection's name starts in one place.
  connection: {
    display: "block",
    flexShrink: 0,
    width: size.iconSm,
    height: size.iconSm,
    marginInline: `calc((${size.avatarDefault} / 2 - ${size.iconSm}) / 2)`,
    strokeWidth: size.iconStroke,
  },
});

/** A connection's row mark, by its name: decorative, the name stands beside it. */
export const ConnectionMark = ({ name }: { name: string }) => {
  const brand = brandOf(name);
  return (
    <ItemMedia align="center">
      {brand === undefined ? (
        <IntegrationsIcon {...stylex.props(styles.connection)} />
      ) : (
        <BrandIcon
          decorative
          logo={brands[brand].logo}
          name={brands[brand].name}
          size="default"
          tile={false}
        />
      )}
    </ItemMedia>
  );
};
