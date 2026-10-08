/**
 * One small demo per component in the kit, for the dev-only gallery
 * (apps/web, `/kit/components/<name>`) and the accessibility checks that
 * run over it (e2e/catalog.e2e.ts). The type holds it to the inventory: a
 * component added to the kit without a demo doesn't type-check.
 */
import type { ComponentType } from "react";

import { chatDemos } from "./demos/chat.tsx";
import { displayDemos } from "./demos/display.tsx";
import { formDemos } from "./demos/forms.tsx";
import { layoutDemos } from "./demos/layout.tsx";
import { navigationDemos } from "./demos/navigation.tsx";
import { overlayDemos } from "./demos/overlays.tsx";
import type { KitComponent } from "./inventory.ts";

export const demos: Record<KitComponent, ComponentType> = {
  ...chatDemos,
  ...displayDemos,
  ...formDemos,
  ...layoutDemos,
  ...navigationDemos,
  ...overlayDemos,
};
