import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import {
  chooseComposerLook,
  composerAccents,
  composerEdges,
  useComposerLook,
} from "../chat/composer-look.ts";
import { Composer } from "../grasp/composer/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { SettingRow, SettingsRows } from "../grasp/setting-row/index.ts";
import { Toggle, ToggleGroup } from "../grasp/toggle/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";

// Settings → Appearance: how the chat's box draws Grasp at work (the
// person's look, chat/composer-look.ts). One box, live and at work in the
// chosen look, then its colour and its edge, each a short segmented
// choice (arrow keys move along it). The box changes as soon as a choice
// is pressed, and each choice is kept as it is made.

const styles = stylex.create({
  // The box, then the rows the card's width, as every settings card's.
  body: {
    display: "grid",
    gap: grasp.space4,
  },
  // The box at work: only to look at, never to type in.
  preview: {
    maxWidth: grasp.formWidth,
    pointerEvents: "none",
  },
});

/** The person's chat box at work: one live box, then its colour and its edge. */
export const ComposerSettings = ({ userId }: { userId: string }) => {
  const { t } = useLingui();
  const look = useComposerLook(userId);
  const accents = { light: t`Light`, mint: t`Mint`, lavender: t`Lavender` };
  const edges = { smooth: t`Smooth`, dither: t`Dither` };
  return (
    <SectionCard title={t`Chat box`}>
      <div {...stylex.props(styles.body)}>
        <div aria-hidden inert {...stylex.props(styles.preview)}>
          <Composer
            accent={look.accent}
            activity="working"
            edge={look.edge}
            failedLabel={t`Not sent`}
            onSend={() => {
              // Only to look at.
            }}
            placeholder={t`Ask Grasp`}
          />
        </div>
        <SettingsRows>
          <SettingRow label={t`Colour`}>
            <ToggleGroup
              aria-label={t`Colour`}
              onValueChange={(value) => {
                const accent = composerAccents.find(
                  (each) => each === value[0]
                );
                if (accent !== undefined) {
                  chooseComposerLook(userId, { ...look, accent });
                }
              }}
              size="sm"
              value={[look.accent]}
            >
              {composerAccents.map((accent) => (
                <Toggle key={accent} value={accent}>
                  {accents[accent]}
                </Toggle>
              ))}
            </ToggleGroup>
          </SettingRow>
          <SettingRow label={t`Edge`}>
            <ToggleGroup
              aria-label={t`Edge`}
              onValueChange={(value) => {
                const edge = composerEdges.find((each) => each === value[0]);
                if (edge !== undefined) {
                  chooseComposerLook(userId, { ...look, edge });
                }
              }}
              size="sm"
              value={[look.edge]}
            >
              {composerEdges.map((edge) => (
                <Toggle key={edge} value={edge}>
                  {edges[edge]}
                </Toggle>
              ))}
            </ToggleGroup>
          </SettingRow>
        </SettingsRows>
      </div>
    </SectionCard>
  );
};
