// The provider as Add connection draws it, in a tile and at the head of the key step: its mark in
// the square, its name, and its host as the muted line.
"use client";

import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { BrandIcon } from "../brand-icon";
import { visuallyHidden } from "../hidden/hidden";
import { IconTile } from "../icon-tile";
import { ItemContent, ItemDescription, ItemMedia, ItemTitle } from "../item";
import { grasp } from "../tokens/tokens.stylex";
import type { AddConnectionProvider } from "./model";

const styles = stylex.create({
  // The name's line: the name on one line, and at its end what the tile adds ("Add another"), so
  // every tile is the same two lines tall.
  titleLine: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: grasp.space2,
    minWidth: 0,
  },
  name: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  // The host on one line, cut with an ellipsis before it wraps (`generativelanguage.googleapis.com`).
  host: {
    display: "block",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});

/** The provider's mark: its brand's, else its icon in the same square, else its first letter. */
export const ProviderMark = ({
  provider,
}: {
  provider: AddConnectionProvider;
}) => (
  <ItemMedia>
    {provider.brand === undefined && provider.icon !== undefined ? (
      <IconTile icon={provider.icon} variant="raised" size="md" />
    ) : (
      <BrandIcon
        brand={provider.brand}
        name={provider.brand === undefined ? provider.name : undefined}
        size="md"
        decorative
      />
    )}
  </ItemMedia>
);

/** The provider's name and host, one line each; `end` at the end of the name's line; `said` after the host for a screen reader only ("Connected"). */
export const ProviderWords = ({
  provider,
  said,
  end,
}: {
  provider: AddConnectionProvider;
  said?: string;
  end?: ReactNode;
}) => (
  <ItemContent>
    <ItemTitle>
      <span {...stylex.props(styles.titleLine)}>
        <span {...stylex.props(styles.name)}>{provider.name}</span>
        {end}
      </span>
    </ItemTitle>
    <ItemDescription>
      <span {...stylex.props(styles.host)}>{provider.host}</span>
      {said !== undefined && said !== "" && (
        <span {...stylex.props(visuallyHidden)}>
          {", "}
          {said}
        </span>
      )}
    </ItemDescription>
  </ItemContent>
);
