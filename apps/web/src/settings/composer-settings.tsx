import { FieldGroup } from "@grasp-os/ui/components/field";
import {
  PromptInput,
  PromptInputBody,
  PromptInputTextarea,
} from "@grasp-os/ui/components/prompt-input";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@grasp-os/ui/components/toggle-group";
import { size, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import {
  chooseComposerLook,
  composerAccents,
  composerEdges,
  useComposerLook,
} from "../chat/composer-look.ts";
import { SettingRow, SettingsGroup } from "./section.tsx";

// Settings › Appearance: how the chat box draws Grasp at work (the
// person's look, chat/composer-look.ts), as the reference's Chat box
// (#2503's settings/composer-settings.tsx). One box, at work in the chosen
// look, then its colour and its edge as the card's rows, each a short
// segmented choice. The box changes as a choice is pressed, and each
// choice is kept as it is made.

const styles = stylex.create({
  // The box at work, in the card's own room above its rows: only to look
  // at, never to type in.
  preview: {
    maxWidth: size.formWidth,
    padding: space["4"],
    pointerEvents: "none",
  },
});

/** The person's chat box at work: one live box, then its colour and its edge. */
export const ComposerSettings = ({ userId }: { userId: string }) => {
  const { t } = useLingui();
  const look = useComposerLook(userId);
  const accents = {
    default: t({ message: "Light", context: "Grasp's own working light" }),
    mint: t`Mint`,
    lavender: t`Lavender`,
  };
  const edges = {
    smooth: t({ message: "Smooth", context: "the chat box's edge" }),
    dither: t({ message: "Dither", context: "the chat box's edge" }),
  };
  return (
    <SettingsGroup flush title={t`Chat box`}>
      <div aria-hidden="true" inert {...stylex.props(styles.preview)}>
        <PromptInput
          accent={look.accent}
          aria-label={t`Chat box`}
          edge={look.edge}
          status="streaming"
        >
          <PromptInputBody>
            <PromptInputTextarea
              aria-label={t`Chat box`}
              placeholder={t`Ask Grasp`}
            />
          </PromptInputBody>
        </PromptInput>
      </div>
      <FieldGroup>
        <SettingRow
          help={t`The light around the box while Grasp works`}
          label={t`Colour`}
        >
          <ToggleGroup
            onValueChange={(value) => {
              const accent = composerAccents.find((each) => each === value[0]);
              if (accent !== undefined) {
                chooseComposerLook(userId, { ...look, accent });
              }
            }}
            value={[look.accent]}
          >
            {composerAccents.map((accent) => (
              <ToggleGroupItem key={accent} value={accent}>
                {accents[accent]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </SettingRow>
        <SettingRow help={t`How that light is drawn`} label={t`Edge`}>
          <ToggleGroup
            onValueChange={(value) => {
              const edge = composerEdges.find((each) => each === value[0]);
              if (edge !== undefined) {
                chooseComposerLook(userId, { ...look, edge });
              }
            }}
            value={[look.edge]}
          >
            {composerEdges.map((edge) => (
              <ToggleGroupItem key={edge} value={edge}>
                {edges[edge]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </SettingRow>
      </FieldGroup>
    </SettingsGroup>
  );
};
