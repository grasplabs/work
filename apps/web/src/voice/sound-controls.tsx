// The kit's Popover and Slider for how loud: Grasp UI has no popover that
// opens on hover and no slider for a free level yet (reported to the
// library). Everything else is Grasp UI's.
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@grasp-os/ui/components/popover";
import { Slider } from "@grasp-os/ui/components/slider";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { Button } from "../grasp/button/index.ts";
import { Muted, Pause, Play, Volume } from "../grasp/icons/index.ts";
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
// mid-sentence and go on from there; and the sound, on or off, with how
// loud on hover.

const styles = stylex.create({
  controls: { display: "flex", alignItems: "center", gap: grasp.space1 },
});

/** The sound's mark: off, or on. */
const loudIcon = (on: boolean, level: number) =>
  !on || level === 0 ? Muted : Volume;

/**
 * The sound on or off; hover it for how loud. When the browser held sound
 * back, it asks to turn it on, and the line being said starts again so it
 * is heard.
 */
const SoundButton = () => {
  const { t } = useLingui();
  const voice = useVoice();
  const [open, setOpen] = useState(false);
  const level = Math.round(voice.volume * 100);
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
    // Hovering shows how loud; a press only turns the sound on or off.
    <Popover
      onOpenChange={(next, details) => {
        if (details.reason !== "trigger-press") {
          setOpen(next);
        }
      }}
      open={open}
    >
      <PopoverTrigger
        closeDelay={250}
        delay={120}
        openOnHover
        render={
          <Button
            aria-label={voice.on ? t`Turn sound off` : t`Turn sound on`}
            aria-pressed={voice.on}
            icon={loudIcon(voice.on, level)}
            onClick={() => {
              setVoiceOn(!voice.on);
            }}
            size="sm"
            variant="ghost"
          />
        }
      />
      <PopoverContent align="end" className="w-44" side="top" variant="snug">
        <Slider
          aria-label={t`Volume`}
          max={100}
          min={0}
          onValueChange={(value) => {
            const next = typeof value === "number" ? value : (value[0] ?? 0);
            setVolume(next / 100);
            if (next > 0 && !voice.on) {
              setVoiceOn(true);
            }
          }}
          value={level}
        />
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
