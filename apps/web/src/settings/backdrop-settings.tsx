import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@grasp-os/ui/components/select";
import { useLingui } from "@lingui/react/macro";

import { BackdropPreview } from "../grasp/field/backdrop-preview.tsx";
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
import {
  SettingsBody,
  SettingsRow,
  SettingsSection,
} from "./settings-parts.tsx";

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
    { id: "scenes", label: t`Scenes`, kinds: sceneKinds },
    { id: "dithers", label: t`Dithers`, kinds: ditherKinds },
    { id: "sand", label: t`Sand`, kinds: sandKinds },
  ];
  const dithered = isDithered(look.backdrop);
  return (
    <SettingsSection
      description={t`What stands behind the page where you start a chat. Yours alone, kept in this browser.`}
      title={t`Chat backdrop`}
    >
      <SettingsBody>
        <BackdropPreview
          label={t`Preview of your chat backdrop`}
          look={look}
          title={t`What should we look at today?`}
        />
      </SettingsBody>
      <SettingsRow
        description={t`A scene, a dither, sand, or nothing.`}
        htmlFor="backdrop-kind"
        label={t`Backdrop`}
      >
        <Select
          items={backdrops.map((value) => ({ value, label: names[value] }))}
          onValueChange={(value: unknown) => {
            const backdrop = backdrops.find((each) => each === value);
            if (backdrop !== undefined) {
              chooseLook(userId, { ...look, backdrop });
            }
          }}
          value={look.backdrop}
        >
          <SelectTrigger className="w-full" id="backdrop-kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {groups.map((group) => (
              <SelectGroup key={group.id}>
                <SelectLabel>{group.label}</SelectLabel>
                {group.kinds.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {names[kind]}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
            <SelectItem value="none">{names.none}</SelectItem>
          </SelectContent>
        </Select>
      </SettingsRow>
      {dithered ? (
        <>
          <SettingsRow
            description={t`How the dither's cells are set.`}
            htmlFor="backdrop-pattern"
            label={t`Pattern`}
          >
            <Select
              items={ditherPatterns.map((value) => ({
                value,
                label: patternNames[value],
              }))}
              onValueChange={(value: unknown) => {
                const pattern = ditherPatterns.find((each) => each === value);
                if (pattern !== undefined) {
                  chooseLook(userId, { ...look, pattern });
                }
              }}
              value={look.pattern}
            >
              <SelectTrigger className="w-full" id="backdrop-pattern">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ditherPatterns.map((pattern) => (
                  <SelectItem key={pattern} value={pattern}>
                    {patternNames[pattern]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
          <SettingsRow
            description={t`One green, or a run of greens from the edge in.`}
            htmlFor="backdrop-tone"
            label={t`Colour`}
          >
            <Select
              items={ditherTones.map((value) => ({
                value,
                label: toneNames[value],
              }))}
              onValueChange={(value: unknown) => {
                const tone = ditherTones.find((each) => each === value);
                if (tone !== undefined) {
                  chooseLook(userId, { ...look, tone });
                }
              }}
              value={look.tone}
            >
              <SelectTrigger className="w-full" id="backdrop-tone">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ditherTones.map((tone) => (
                  <SelectItem key={tone} value={tone}>
                    {toneNames[tone]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
        </>
      ) : null}
    </SettingsSection>
  );
};
