import { devResetPath } from "@grasp-os/shared/dev-reset";
import { Button } from "@grasp-os/ui/components/button";
import { Icon, RefreshCwIcon } from "@grasp-os/ui/lib/icons";

// On a local stack only (`vp run dev`): the onboarding started over, so
// whoever works on it can walk the setup and an interview again from the
// first screen as often as they like, without stopping the stack. Core
// wipes what the onboarding kept (core's onboarding/dev-reset.ts); this
// forgets what this browser kept of the setup and opens its first screen,
// loaded anew. A build for anywhere else has no such button: Vite leaves
// it out, and core has no such route there. Its words are a developer's,
// in English, and not in the catalogs.

/** What this browser keeps of the setup, per admin (routes/setup.tsx `keptKey`). */
const keptPrefix = "grasp.setup.";

const forgetKept = (): void => {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(keptPrefix)) {
        localStorage.removeItem(key);
      }
    }
  } catch {
    // Nothing kept here to forget.
  }
};

const startOver = async (): Promise<void> => {
  const response = await fetch(devResetPath, { method: "POST" });
  if (!response.ok) {
    console.warn(`Starting the onboarding over failed: ${response.status}`);
    return;
  }
  forgetKept();
  window.location.assign("/setup?step=welcome");
};

const label = "Start the onboarding over (local only)";

/** A small button in the bar that starts the onboarding over: on a local stack only. */
export const StartOver = ({ size }: { size: "icon-sm" | "icon" }) =>
  import.meta.env.DEV ? (
    <Button
      aria-label={label}
      onClick={() => {
        void startOver();
      }}
      size={size}
      tooltip={label}
      variant="ghost"
    >
      <Icon icon={RefreshCwIcon} />
    </Button>
  ) : null;
