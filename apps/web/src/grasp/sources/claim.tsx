// Claim: the words in an answer that one source backs (sources.tsx). When its marker or its row is
// lit, the words take a very soft mint, so the claim and its proof are visibly tied. Nothing else:
// it reads as plain text, to a screen reader too.
"use client";

import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { useSources } from "./context";
import { sourceStyles as styles } from "./styles";

/** Every prop a Claim takes. */
export interface ClaimProps {
  /** The number of the source that backs these words: its place in the Sources' `items`, from 1. */
  n: number;
  /** The words. */
  children: ReactNode;
}

/** Words backed by a source, lit with its marker and its row. */
export const Claim = ({ n, children }: ClaimProps) => {
  const shared = useSources();
  const lit = shared !== null && shared.active === n;
  return (
    <span
      data-slot="claim"
      data-source={n}
      data-lit={lit || undefined}
      {...stylex.props(styles.claim, lit && styles.claimWash)}
    >
      {children}
    </span>
  );
};
