import { BrandIcon } from "@grasp-os/ui/components/brand-icon";
import { colors, radius, shadow, size } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

// An app's mark beside its name, on the agents pages: the logo core serves
// for it (`CatalogEntry.logo`, on the deployment's own origin) on Brand
// icon's tile, else Brand icon's own first letter. Decorative: the name
// beside it says which app it is. Damsko's Brand icon takes a mark drawn
// as an icon, not a picture, so a served logo stands on a tile of the same
// size and corner here.

const styles = stylex.create({
  tile: {
    display: "inline-grid",
    placeItems: "center",
    flexShrink: 0,
    overflow: "hidden",
    boxSizing: "border-box",
    cornerShape: radius.shape,
    boxShadow: shadow.sm,
    backgroundColor: colors.card,
  },
  sm: {
    width: size.avatarSm,
    height: size.avatarSm,
    borderRadius: `min(${radius.base}, calc(${size.avatarSm} / 2))`,
  },
  default: {
    width: size.avatarDefault,
    height: size.avatarDefault,
    borderRadius: `min(${radius.base}, calc(${size.avatarDefault} / 2))`,
  },
  logo: { width: "60%", height: "60%", objectFit: "contain" },
});

/** An app's mark: its served logo, or its first letter. */
export const AppMark = ({
  name,
  logo,
  size: tile = "sm",
}: {
  name: string;
  logo: string | null;
  size?: "sm" | "default";
}) => {
  const [missing, setMissing] = useState<string>();
  const image = logo === null || logo === missing ? undefined : logo;
  if (image === undefined) {
    return <BrandIcon decorative label={name} size={tile} />;
  }
  return (
    <span aria-hidden="true" {...stylex.props(styles.tile, styles[tile])}>
      <img
        alt=""
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
