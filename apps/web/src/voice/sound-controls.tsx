import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

import { Button } from "../grasp/button/index.ts";
import { Muted, Pause, Play, Volume } from "../grasp/icons/index.ts";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../grasp/popover/index.ts";
import { Slider } from "../grasp/slider/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import {
  allowSound,
  pauseVoice,
  resumeVoice,
  setVoiceOn,
  setVolume,
  useVoice,
} from "./voice.ts";

// Stephen's voice, bottom right on every step (prototype
// `components/onboarding/onboarding-sound.tsx`): pause, to hold him
// mid-sentence and go on from there; and the sound: its button opens how
// loud, with a way to turn it off or on again.

const styles = stylex.create({
  controls: { display: "flex", alignItems: "center", gap: grasp.space1 },
  volume: { display: "grid", gap: grasp.space2 },
});

/** Where the sound comes back when turned on from silent. */
const halfVolume = 0.5;

/** The sound's mark: off, or on. */
const loudIcon = (on: boolean, level: number) =>
  !on || level === 0 ? Muted : Volume;

/**
 * How loud, from the sound's button: a slider from silent to full, said as
 * a share, and the sound off or on again. When the browser held sound back,
 * it asks to turn it on, and the line being said starts again so it is
 * heard.
 */
const SoundButton = () => {
  const { t } = useLingui();
  const voice = useVoice();
  const shown = voice.on ? voice.volume : 0;
  if (voice.on && voice.blocked) {
    return (
      <Button
        icon={Volume}
        onClick={() => {
          void allowSound();
        }}
        size="sm"
        variant="ghost"
      >
        {t`Turn sound on`}
      </Button>
    );
  }
  return (
    <Popover>
      <PopoverTrigger
        aria-label={t`Volume`}
        icon={loudIcon(voice.on, Math.round(voice.volume * 100))}
        size="sm"
        variant="ghost"
      />
      <PopoverContent align="end" aria-label={t`Volume`} side="top">
        <div {...stylex.props(styles.volume)}>
          <Slider
            format={{ style: "percent" }}
            label={t`Volume`}
            max={1}
            min={0}
            onValueChange={(value) => {
              const next = typeof value === "number" ? value : (value[0] ?? 0);
              setVolume(next);
              setVoiceOn(next > 0);
            }}
            step={0.05}
            value={shown}
          />
          <Button
            icon={voice.on ? Muted : Volume}
            onClick={() => {
              // Turned on from silent, it comes back at half, so it is heard.
              if (!voice.on && voice.volume === 0) {
                setVolume(halfVolume);
              }
              setVoiceOn(!voice.on);
            }}
            size="sm"
            variant="quiet"
          >
            {voice.on ? t`Turn sound off` : t`Turn sound on`}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
};

export const SoundControls = () => {
  const { t } = useLingui();
  const { paused } = useVoice();
  return (
    <div {...stylex.props(styles.controls)}>
      <Button
        aria-label={paused ? t`Play` : t`Pause`}
        icon={paused ? Play : Pause}
        onClick={paused ? resumeVoice : pauseVoice}
        size="sm"
        variant="ghost"
      />
      <SoundButton />
    </div>
  );
};
