import { Button } from "@grasp-os/ui/components/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@grasp-os/ui/components/popover";
import { Slider, SliderLabel } from "@grasp-os/ui/components/slider";
import {
  Icon,
  PauseIcon,
  PlayIcon,
  VolumeIcon,
  VolumeOffIcon,
} from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";

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
// loud, with a way to turn it off or on again, as #2503 draws it. Damsko's
// Popover opens on a press, never on hover, so how loud is a press away,
// for the keys too.

const styles = stylex.create({
  controls: { display: "flex", alignItems: "center", gap: space["1"] },
});

/**
 * How loud, from the sound's button: a slider from silent to full, said as
 * a share (at nothing it is silent, the voice still on, as a mute), and
 * the sound off or on again; its name says when the sound is off. When the browser held sound back,
 * it asks to turn it on, and the line being said starts again so it is
 * heard.
 */
const SoundButton = () => {
  const { t } = useLingui();
  const voice = useVoice();
  const silent = !voice.on || voice.volume === 0;
  if (voice.on && voice.blocked) {
    return (
      <Button
        onClick={() => {
          void allowSound();
        }}
        size="sm"
        variant="ghost"
      >
        <Icon icon={VolumeIcon} />
        {t`Turn sound on`}
      </Button>
    );
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          aria-label={voice.on ? t`Volume` : t`Volume (sound off)`}
          size="icon-sm"
          variant="ghost"
        >
          <Icon icon={silent ? VolumeOffIcon : VolumeIcon} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top">
        <Slider
          format={{ style: "percent" }}
          max={1}
          min={0}
          onValueChange={(value) => {
            const next = typeof value === "number" ? value : (value[0] ?? 0);
            setVolume(next);
            if (next > 0 && !voice.on) {
              setVoiceOn(true);
            }
          }}
          step={0.01}
          value={voice.volume}
        >
          <SliderLabel>{t`Volume`}</SliderLabel>
        </Slider>
        <Button
          onClick={() => {
            setVoiceOn(!voice.on);
          }}
          size="sm"
          variant="ghost"
        >
          <Icon icon={voice.on ? VolumeOffIcon : VolumeIcon} />
          {voice.on ? t`Turn sound off` : t`Turn sound on`}
        </Button>
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
        onClick={paused ? resumeVoice : pauseVoice}
        size="icon-sm"
        variant="ghost"
      >
        <Icon icon={paused ? PlayIcon : PauseIcon} />
      </Button>
      <SoundButton />
    </div>
  );
};
