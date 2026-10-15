import { useLingui } from "@lingui/react/macro";
import { useState } from "react";

// An app's tile, as the prototype draws it (`components/app-logo.tsx`): its
// own logo on a light tile, or its first letter when it has none.

/**
 * The tile around a logo, by size. `xs` and `inline` sit inside a line of
 * text; `lg` stands on its own, as on a block; `bare` is the logo alone,
 * with no tile behind it, cut round so a row of them has one shape.
 */
const tileClass = {
  bare: "inline-flex size-4 flex-none items-center justify-center overflow-hidden rounded-full",
  lg: "bg-tile flex size-14 flex-none items-center justify-center rounded-2xl border p-3 shadow-xs",
  default:
    "bg-tile flex size-9 flex-none items-center justify-center rounded-md border p-1.5",
  sm: "bg-tile flex size-7 flex-none items-center justify-center rounded-md border p-1",
  xs: "bg-tile inline-flex size-4 flex-none items-center justify-center overflow-hidden rounded-sm",
  inline:
    "bg-tile inline-flex size-5 flex-none items-center justify-center overflow-hidden rounded-md border p-0.5",
} as const;

type TileSize = keyof typeof tileClass;

const letterClassOf = (size: TileSize, inText: boolean): string => {
  if (inText) {
    return "text-tile-foreground text-xs leading-none font-medium";
  }
  return size === "lg"
    ? "text-tile-foreground text-2xl font-medium"
    : "text-tile-foreground text-xs font-medium";
};

/**
 * A brand's own logo on a light tile, or its first letter when it has no
 * logo. `logo` is where core serves it, on the deployment's own origin
 * (`CatalogEntry.logo`), never its provider's address. A logo that does
 * not load makes way for the letter, and one further down a long list is
 * fetched only as it comes near.
 */
export const AppLogo = ({
  name,
  logo,
  size = "default",
}: {
  name: string;
  logo?: string | null;
  /** `xs` sits inside a chip; `inline` inside a sentence. */
  size?: TileSize;
}) => {
  const { t } = useLingui();
  const [missing, setMissing] = useState<string>();
  const image = logo === null || logo === missing ? undefined : logo;
  const inText = size === "xs" || size === "inline" || size === "bare";
  const Tile = inText ? "span" : "div";
  return (
    <Tile className={tileClass[size]}>
      {image === undefined ? (
        <span aria-hidden="true" className={letterClassOf(size, inText)}>
          {name.charAt(0)}
        </span>
      ) : (
        <img
          alt={inText ? "" : t`${name} logo`}
          className="size-full object-contain"
          decoding="async"
          loading="lazy"
          onError={() => {
            setMissing(image);
          }}
          src={image}
        />
      )}
    </Tile>
  );
};
