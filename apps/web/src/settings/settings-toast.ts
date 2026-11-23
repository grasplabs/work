import { createToaster } from "@grasp-os/ui/components/toast";

// Settings' own queue of toasts, which the Settings layout shows
// (routes/_shell.settings.tsx): what a change made from a menu did, as it
// has no place of its own in the page. A queue of its own, not the page's
// `toast`, so it shows whether or not the app's frame places Damsko's
// Toaster too, and never twice.
export const settingsToast = createToaster();
