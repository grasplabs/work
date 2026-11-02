/**
 * One small demo per component in the kit, for the dev-only gallery
 * (apps/web, `/kit/components/<name>`) and the accessibility checks that
 * run over it (e2e/catalog.e2e.ts). test/catalog.test.ts holds it to the
 * components directory: a component added to the kit without a demo fails.
 */
import type { ComponentType } from "react";

import { chatDemos } from "./demos/chat.tsx";
import { displayDemos } from "./demos/display.tsx";
import { formDemos } from "./demos/forms.tsx";
import { layoutDemos } from "./demos/layout.tsx";
import { navigationDemos } from "./demos/navigation.tsx";
import { overlayDemos } from "./demos/overlays.tsx";

export const demos: Record<string, ComponentType> = {
  ...chatDemos,
  ...displayDemos,
  ...formDemos,
  ...layoutDemos,
  ...navigationDemos,
  ...overlayDemos,
};
