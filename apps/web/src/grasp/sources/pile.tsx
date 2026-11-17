// SourcePile: the folded list under an answer (list.tsx). The first marks overlap in a row, as
// Perplexity's favicons do but ours, then the count, with the kinds in words under it ("4 files,
// 3 messages"). A pointer fans the marks apart (only where a pointer hovers). A source found while
// the answer streams arrives in the pile: its mark settles in and our light crosses it once.
"use client";

import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { focus } from "../focus/focus";
import type { SourcesValue } from "./context";
import { kindsInParts } from "./labels";
import { SourceTile } from "./mark";
import { pileMarker } from "./markers.stylex";
import { isRun, kindOf } from "./source";
import { fanStyles, sourceStyles as styles } from "./styles";

/** How many marks the pile shows. */
const SHOWN = 5;

/** The folded list: its marks, its count and its kinds; pressing it opens the list. */
export const SourcePile = ({
  shared,
  id,
  onOpen,
}: {
  shared: SourcesValue;
  id: string;
  onOpen: (marks: HTMLElement) => void;
}) => {
  const { sources, labels } = shared;
  // The sources there when the pile first drew; any after it were found while the answer streams.
  // A shorter list is a new answer: what it holds now is where it starts.
  const [first, setFirst] = useState(sources.length);
  if (sources.length < first) {
    setFirst(sources.length);
  }
  const shown = sources.slice(0, SHOWN);
  const parts = kindsInParts(sources.map(kindOf), labels);
  const kinds = parts.join(", ");
  const count = labels.count(sources.length);
  // The steps the last mark fans.
  const spread = Math.max(0, shown.length - 1);
  return (
    <div {...stylex.props(styles.section)}>
      <button
        type="button"
        id={id}
        aria-label={`${count}: ${kinds}. ${labels.open}`}
        data-slot="source-pile"
        onClick={(event) => {
          onOpen(event.currentTarget);
        }}
        {...stylex.props(
          pileMarker,
          styles.pile,
          fanStyles.spread(String(spread)),
          focus.ring
        )}
      >
        <span aria-hidden="true" {...stylex.props(styles.pileMarks)}>
          {shown.map((source, index) => {
            const fresh = index >= first;
            return (
              <span
                key={`${index + 1}-${source.title}`}
                data-pile-mark={index + 1}
                {...stylex.props(
                  styles.pileMark,
                  isRun(kindOf(source)) && styles.pileMarkRun,
                  fanStyles.at(String(index)),
                  fresh && styles.arrived
                )}
              >
                <SourceTile source={source} size="pile" />
                {fresh ? <span {...stylex.props(styles.light)} /> : null}
              </span>
            );
          })}
        </span>
        <span {...stylex.props(styles.pileCount)}>{count}</span>
      </button>
      <p aria-hidden="true" {...stylex.props(styles.pileKinds)}>
        {parts.map((part, index) => (
          <span key={part}>
            {index > 0 ? " " : null}
            <span {...stylex.props(styles.pileKind)}>
              {index < parts.length - 1 ? `${part},` : part}
            </span>
          </span>
        ))}
      </p>
    </div>
  );
};
