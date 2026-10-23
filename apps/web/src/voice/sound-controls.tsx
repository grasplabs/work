import { Button } from "@grasp-os/ui/components/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@grasp-os/ui/components/popover";
import { Slider } from "@grasp-os/ui/components/slider";
import { useLingui } from "@lingui/react/macro";
import {
  PauseIcon,
  PlayIcon,
  Volume1Icon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react";
import { useState } from "react";

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

const loudIcon = (on: boolean, level: number) => {
  if (!on || level === 0) {
    return <VolumeXIcon />;
  }
  return level < 50 ? <Volume1Icon /> : <Volume2Icon />;
};

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
        onClick={() => {
          void allowSound();
        }}
        size="sm"
        variant="ghost"
      >
        <Volume2Icon data-icon="inline-start" />
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
            onClick={() => {
              setVoiceOn(!voice.on);
            }}
            size="icon-sm"
            variant="ghost"
          />
        }
      >
        {loudIcon(voice.on, level)}
      </PopoverTrigger>
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
    <div className="flex items-center gap-1">
      <Button
        aria-label={paused ? t`Play` : t`Pause`}
        onClick={paused ? resumeVoice : pauseVoice}
        size="icon-sm"
        variant="ghost"
      >
        {paused ? <PlayIcon /> : <PauseIcon />}
      </Button>
      <SoundButton />
    </div>
  );
};
