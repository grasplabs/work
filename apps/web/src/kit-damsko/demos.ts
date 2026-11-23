import { controlDemos } from "./controls.tsx";
import type { Demos } from "./demo.ts";

/** Every demo, in the groups the gallery shows them in. */
export const demoGroups: Record<string, Demos> = {
  "Form and basic controls": controlDemos,
};
