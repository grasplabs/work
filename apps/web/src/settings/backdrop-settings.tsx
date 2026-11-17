import { useLingui } from "@lingui/react/macro";

import { BackdropPreview } from "../grasp/field/backdrop-preview.tsx";
import { Field, FieldDescription, FieldLabel } from "../grasp/field/index.ts";
import {
  backdrops,
  chooseLook,
  ditherKinds,
  ditherPatterns,
  ditherTones,
  isDithered,
  sandKinds,
  sceneKinds,
  useLook,
} from "../grasp/field/look.ts";
import type {
  Backdrop,
  DitherPattern,
  DitherTone,
} from "../grasp/field/look.ts";
import { Radio, RadioGroup } from "../grasp/radio-group/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { Select } from "../grasp/select/index.ts";
import { SettingsStack } from "./section.tsx";

// Settings → Appearance: what stands behind Chat's own page (the person's
// look, grasp/field/look.ts). The look is shown live as the page shows it,
// above what it is made of: its backdrop and, for the backdrops drawn as a
// dither, its pattern and its colour. Each choice is kept as it is made.

/** The person's backdrop for Chat, with a preview of it. */
export const BackdropSettings = ({ userId }: { userId: string }) => {
  const { t } = useLingui();
  const look = useLook(userId);
  const names: Record<Backdrop, string> = {
    cliffs: t`Cliffs`,
    wave: t`Wave`,
    aurora: t`Aurora`,
    starry: t`Starry night`,
    fuji: t`Fuji`,
    wanderer: t`Wanderer`,
    dusk: t`Dusk`,
    dots: t`Dots`,
    door: t`Door`,
    sand: t`Sand`,
    dunes: t`Dunes`,
    rings: t`Rings`,
    pixels: t`Pixel sand`,
    none: t`None`,
  };
  const patternNames: Record<DitherPattern, string> = {
    bayer: t`Bayer`,
    grid: t`Grid`,
    mix: t`Bayer grid`,
  };
  const toneNames: Record<DitherTone, string> = {
    light: t`Light`,
    deep: t`Deep`,
    mint: t`Mint`,
    lime: t`Lime`,
    ink: t`Ink`,
    rim: t`Dark edge`,
    core: t`Light edge`,
    aurora: t`Aurora`,
  };
  const groups = [
    { label: t`Scenes`, kinds: sceneKinds },
    { label: t`Dithers`, kinds: ditherKinds },
    { label: t`Sand`, kinds: sandKinds },
  ];
  const dithered = isDithered(look.backdrop);
  return (
    <SectionCard
      description={t`What stands behind the page where you start a chat.`}
      title={t`Chat backdrop`}
    >
      <SettingsStack>
        <BackdropPreview
          label={t`Preview of your chat backdrop`}
          look={look}
          title={t`What should we look at today?`}
        />
        <Field>
          <FieldLabel>{t`Backdrop`}</FieldLabel>
          <Select
            items={[
              ...groups.map((group) => ({
                type: "group" as const,
                label: group.label,
                items: group.kinds.map((kind) => ({
                  value: kind,
                  label: names[kind],
                })),
              })),
              { type: "separator" as const },
              { value: "none", label: names.none },
            ]}
            onValueChange={(value) => {
              const backdrop = backdrops.find((each) => each === value);
              if (backdrop !== undefined) {
                chooseLook(userId, { ...look, backdrop });
              }
            }}
            value={look.backdrop}
          />
          <FieldDescription>{t`A scene, a dither, sand, or nothing.`}</FieldDescription>
        </Field>
        {dithered ? (
          <>
            <RadioGroup
              description={t`How the dither's cells are set.`}
              label={t`Pattern`}
              onValueChange={(value) => {
                const pattern = ditherPatterns.find((each) => each === value);
                if (pattern !== undefined) {
                  chooseLook(userId, { ...look, pattern });
                }
              }}
              value={look.pattern}
            >
              {ditherPatterns.map((pattern) => (
                <Radio
                  key={pattern}
                  label={patternNames[pattern]}
                  value={pattern}
                />
              ))}
            </RadioGroup>
            <Field>
              <FieldLabel>{t`Colour`}</FieldLabel>
              <Select
                items={ditherTones.map((value) => ({
                  value,
                  label: toneNames[value],
                }))}
                onValueChange={(value) => {
                  const tone = ditherTones.find((each) => each === value);
                  if (tone !== undefined) {
                    chooseLook(userId, { ...look, tone });
                  }
                }}
                value={look.tone}
              />
              <FieldDescription>
                {t`One green, or a run of greens from the edge in.`}
              </FieldDescription>
            </Field>
          </>
        ) : null}
      </SettingsStack>
    </SectionCard>
  );
};
