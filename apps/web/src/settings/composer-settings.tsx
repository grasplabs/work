import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useId } from "react";
import type { ReactNode } from "react";

import {
  chooseComposerLook,
  composerAccents,
  composerEdges,
  useComposerLook,
} from "../chat/composer-look.ts";
import type { ComposerLook } from "../chat/composer-look.ts";
import { Composer } from "../grasp/composer/index.ts";
import { focus } from "../grasp/focus/focus.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { SettingsStack } from "./section.tsx";

// Settings → Appearance: how the chat's box draws Grasp at work (the
// person's look, chat/composer-look.ts), chosen by sight. Each choice is a
// small box, live and at work in that look, so the light is seen as it
// will be: its colour, then its edge. Each row is a group of radios, one
// tab stop, arrows to move; each choice is kept as it is made.

const styles = stylex.create({
  group: {
    display: "grid",
    gap: grasp.space2,
    minWidth: 0,
    margin: 0,
    padding: 0,
    borderWidth: 0,
  },
  label: {
    padding: 0,
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
  },
  tiles: {
    display: "grid",
    gap: grasp.space3,
    gridTemplateColumns: "repeat(auto-fill, minmax(13rem, 1fr))",
  },
  tile: {
    position: "relative",
    display: "grid",
    gap: grasp.space2,
    padding: grasp.space2,
    borderRadius: grasp.corner,
    cornerShape: grasp.cornerShape,
    boxShadow: grasp.edge,
    cursor: "pointer",
  },
  chosen: {
    boxShadow: `0 0 0 2px ${grasp.ink}`,
  },
  native: {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    margin: 0,
    opacity: 0,
    cursor: "pointer",
  },
  // The box at work: only to look at, never to type in.
  preview: {
    pointerEvents: "none",
  },
  name: {
    fontSize: grasp.textXs,
    lineHeight: grasp.textXsLine,
    color: grasp.muted,
  },
  nameOn: {
    color: grasp.ink,
    fontWeight: grasp.weightMedium,
  },
});

/** One look as a tile: the box at work in it, its name, and the radio that chooses it. */
const Tile = ({
  group,
  look,
  name,
  chosen,
  onChoose,
}: {
  group: string;
  look: ComposerLook;
  name: string;
  chosen: boolean;
  onChoose: () => void;
}) => {
  const { t } = useLingui();
  return (
    <label
      {...stylex.props(styles.tile, chosen && styles.chosen, focus.within)}
    >
      <input
        checked={chosen}
        name={group}
        onChange={onChoose}
        type="radio"
        {...stylex.props(styles.native)}
      />
      <div aria-hidden inert {...stylex.props(styles.preview)}>
        <Composer
          accent={look.accent}
          activity="working"
          compact
          edge={look.edge}
          failedLabel={t`Could not send`}
          onSend={() => {
            // Only to look at.
          }}
          placeholder={t`Ask anything`}
        />
      </div>
      <span {...stylex.props(styles.name, chosen && styles.nameOn)}>
        {name}
      </span>
    </label>
  );
};

/** A labelled row of tiles. */
const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <fieldset {...stylex.props(styles.group)}>
    <legend {...stylex.props(styles.label)}>{label}</legend>
    <div {...stylex.props(styles.tiles)}>{children}</div>
  </fieldset>
);

/** The person's chat box at work, chosen by sight: its colour, then its edge. */
export const ComposerSettings = ({ userId }: { userId: string }) => {
  const { t } = useLingui();
  const look = useComposerLook(userId);
  const id = useId();
  const accents = { light: t`Light`, mint: t`Mint`, lavender: t`Lavender` };
  const edges = { smooth: t`Smooth`, dither: t`Dither` };
  return (
    <SectionCard title={t`Chat box`}>
      <SettingsStack>
        <Row label={t`Colour`}>
          {composerAccents.map((accent) => (
            <Tile
              chosen={look.accent === accent}
              group={`${id}-accent`}
              key={accent}
              look={{ ...look, accent }}
              name={accents[accent]}
              onChoose={() => {
                chooseComposerLook(userId, { ...look, accent });
              }}
            />
          ))}
        </Row>
        <Row label={t`Edge`}>
          {composerEdges.map((edge) => (
            <Tile
              chosen={look.edge === edge}
              group={`${id}-edge`}
              key={edge}
              look={{ ...look, edge }}
              name={edges[edge]}
              onChoose={() => {
                chooseComposerLook(userId, { ...look, edge });
              }}
            />
          ))}
        </Row>
      </SettingsStack>
    </SectionCard>
  );
};
