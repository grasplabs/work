import { BrandIcon } from "@grasp-os/ui/components/brand-icon";
import { colors, radius, size as sizes } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { brands } from "./brands.ts";
import type { Brand } from "./brands.ts";

// A provider's mark wherever an app is named on the Integrations pages:
// Damsko's BrandIcon with the brand's own mark where the product has it
// (brands.ts), else the logo core serves for it (`CatalogEntry.logo`) on
// the same small tile, else its first letter. BrandIcon's sizes: `sm` 32px
// on a tile, `md` (Damsko's `default`) 40px at the head of an app's panel,
// `lg` 48px at the head of its page.

/** The product's brands, by their keys. */
const isBrand = (key: string): key is Brand => Object.hasOwn(brands, key);
const brandKeys = Object.keys(brands).filter((key) => isBrand(key));

/** Letters only, in lower case: how ids and names are compared. */
const plain = (text: string): string =>
  text.toLowerCase().replaceAll(/[^a-z]/gu, "");

/** The brand for an app, by its catalog id or its name; none for the rest. */
export const brandOf = (id: string, name: string): Brand | undefined =>
  brandKeys.find((key) => plain(key) === plain(id)) ??
  // A catalog name that is a brand's own, such as "Microsoft 365" or
  // "Google Workspace": the brand whose name starts it.
  brandKeys.find((key) => plain(name).startsWith(plain(brands[key].name))) ??
  // One of Grasp's own connectors to a provider's other product, such as
  // `microsoft-directory`: the provider's brand.
  brandKeys.find((key) => plain(key) === plain(id.split("-")[0] ?? ""));

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
  md: { width: sizes.avatarDefault, height: sizes.avatarDefault },
  lg: { width: sizes.avatarLg, height: sizes.avatarLg },
  logo: { width: "60%", height: "60%", objectFit: "contain" },
});

const brandSize = { sm: "sm", md: "default", lg: "lg" } as const;

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
  size?: "sm" | "md" | "lg";
}) => {
  const { t } = useLingui();
  const [missing, setMissing] = useState<string>();
  const brand = brandOf(id, name);
  const image = logo === null || logo === missing ? undefined : logo;
  if (brand !== undefined || image === undefined) {
    return (
      <BrandIcon
        decorative
        logo={brand === undefined ? undefined : brands[brand].logo}
        name={name}
        size={brandSize[size]}
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
