import { BrandIcon } from "@grasp-os/ui/components/brand-icon";
import { colors, radius, size as sizes } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { brands } from "./brands.ts";
import type { Brand } from "./brands.ts";

// A provider's mark wherever an app is named on the Integrations pages,
// on Damsko's BrandIcon tile: the logo core serves for it
// (`CatalogEntry.logo`) wins; where core serves none, the product's own
// mark for a connector whose id is exactly one it has (brands.ts); else
// BrandIcon's neutral first letter, as for a logo that doesn't load. Never
// by its name: a name that starts like a brand's is not that brand.
// BrandIcon's sizes: `sm` 32px on a tile, `default` 40px at the head of an
// app's panel, `lg` 48px at the head of its page.

/** The size of an app's mark: Damsko's BrandIcon's own, by where it stands. */
export type MarkSize = "sm" | "default" | "lg";

/** Whether the product has its own mark for the connector `id`, by that id exactly. */
const isBrand = (id: string): id is Brand => Object.hasOwn(brands, id);

const styles = stylex.create({
  // A served logo on BrandIcon's tile: its ground, its edge and its corner.
  tile: {
    display: "inline-grid",
    placeItems: "center",
    flexShrink: 0,
    overflow: "hidden",
    boxSizing: "border-box",
    borderRadius: radius.base,
    cornerShape: radius.shape,
    boxShadow: sizes.borderStrong,
    backgroundColor: colors.card,
  },
  sm: { width: sizes.avatarSm, height: sizes.avatarSm },
  default: { width: sizes.avatarDefault, height: sizes.avatarDefault },
  lg: { width: sizes.avatarLg, height: sizes.avatarLg },
  logo: { width: "60%", height: "60%", objectFit: "contain" },
});

/** An app's mark, beside its name: decorative, the name says who it is. */
export const ProviderMark = ({
  id,
  name,
  logo,
  size = "sm",
}: {
  /** Its catalog id: a native provider (`microsoft`) or a toolkit's slug. */
  id: string;
  name: string;
  logo: string | null;
  size?: MarkSize;
}) => {
  const { t } = useLingui();
  const [missing, setMissing] = useState<string>();
  const image = logo === null || logo === missing ? undefined : logo;
  if (image === undefined) {
    return (
      <BrandIcon
        decorative
        name={name}
        logo={logo === null && isBrand(id) ? brands[id].logo : undefined}
        size={size}
      />
    );
  }
  return (
    <span aria-hidden="true" {...stylex.props(styles.tile, styles[size])}>
      <img
        alt={t`${name} logo`}
        decoding="async"
        loading="lazy"
        onError={() => {
          setMissing(image);
        }}
        src={image}
        {...stylex.props(styles.logo)}
      />
    </span>
  );
};
