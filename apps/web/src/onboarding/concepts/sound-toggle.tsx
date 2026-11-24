import { Toggle } from "@grasp-os/ui/components/toggle";
import { Icon, VolumeIcon, VolumeOffIcon } from "@grasp-os/ui/lib/icons";
import { useLingui } from "@lingui/react/macro";

import { allowSound, setVoiceOn, useVoice } from "../../voice/voice.ts";
import { useNarrow } from "../use-narrow.ts";

/**
 * Whether Stephen speaks: one toggle, its state in words beside the icon
 * (only the icon on a phone, its name then its tooltip). Turned on, the
 * browser is asked for sound at once, as the press allows it.
 */
export const SoundToggle = () => {
  const { t } = useLingui();
  const { on } = useVoice();
  const narrow = useNarrow();
  const label = on ? t`Sound on` : t`Sound off`;
  return (
    <Toggle
      aria-label={narrow ? label : undefined}
      onPressedChange={(pressed) => {
        setVoiceOn(pressed);
        if (pressed) {
          void allowSound();
        }
      }}
      pressed={on}
      size="sm"
    >
      <Icon icon={on ? VolumeIcon : VolumeOffIcon} />
      {narrow ? null : label}
    </Toggle>
  );
};
