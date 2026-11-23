import { controlDemos } from "./controls.tsx";
import { dataDemos } from "./data.tsx";
import type { Demos } from "./demo.ts";
import { overlayDemos } from "./overlays.tsx";

/** Every demo, in the groups the gallery shows them in. */
export const demoGroups: Record<string, Demos> = {
  "Form and basic controls": controlDemos,
  "Overlays and navigation": overlayDemos,
  "Data and content": dataDemos,
};
