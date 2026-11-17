import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { BrandIcon, brands } from "../grasp/brand-icon/index.ts";
import type { Brand } from "../grasp/brand-icon/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";

// A provider's mark wherever an app is named on the Integrations pages:
// Grasp UI's Brand icon where the library has the brand, else the logo
// core serves for it (`CatalogEntry.logo`) on the same small tile, else
// its first letter. The library's tile sizes: `sm` 32px in a list, `md`
// 40px at the head of an app's page.

/** The library's brands, by their keys. */
const isBrand = (key: string): key is Brand => Object.hasOwn(brands, key);
const brandKeys = Object.keys(brands).filter((key) => isBrand(key));

/** Letters only, in lower case: how ids and names are compared. */
const plain = (text: string): string =>
  text.toLowerCase().replaceAll(/[^a-z]/gu, "");

/** The library's brand for an app, by its catalog id or its name; none for the rest. */
const brandOf = (id: string, name: string): Brand | undefined =>
  brandKeys.find((key) => plain(key) === plain(id)) ??
  // A catalog name that is a brand's own, such as "Microsoft 365" or
  // "Google Workspace": the brand whose name starts it.
  brandKeys.find((key) => plain(name).startsWith(plain(brands[key].name)));

const sizes = { sm: "2rem", md: "2.5rem" } as const;

const styles = stylex.create({
  tile: {
    display: "inline-grid",
    placeItems: "center",
    flexShrink: 0,
    overflow: "hidden",
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    boxShadow: grasp.edge,
    backgroundColor: grasp.raised,
    color: grasp.ink,
    fontSize: grasp.textXs,
    fontWeight: grasp.weightMedium,
  },
  sm: { width: sizes.sm, height: sizes.sm },
  md: { width: sizes.md, height: sizes.md },
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
  size?: "sm" | "md";
}) => {
  const { t } = useLingui();
  const [missing, setMissing] = useState<string>();
  const brand = brandOf(id, name);
  if (brand !== undefined) {
    return <BrandIcon brand={brand} decorative size={size} />;
  }
  const image = logo === null || logo === missing ? undefined : logo;
  return (
    <span aria-hidden="true" {...stylex.props(styles.tile, styles[size])}>
      {image === undefined ? (
        name.charAt(0)
      ) : (
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
      )}
    </span>
  );
};
