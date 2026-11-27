/**
 * One small demo per component in the kit, for the accessibility checks
 * that run over each (test/kit.browser.test.tsx). test/catalog.test.ts
 * holds it to the components directory: a component added to the kit
 * without a demo fails.
 */
import type { ComponentType } from "react";

import { conversationDemos } from "./demos/conversation.tsx";
import { dataTableDemos } from "./demos/data-table.tsx";
import { directionDemos } from "./demos/direction.tsx";
import { displayDemos } from "./demos/display.tsx";
import { formDemos } from "./demos/forms.tsx";
import { navigationDemos } from "./demos/navigation.tsx";
import { overlayDemos } from "./demos/overlays.tsx";

export const demos: Record<string, ComponentType> = {
  ...conversationDemos,
  ...dataTableDemos,
  ...directionDemos,
  ...displayDemos,
  ...formDemos,
  ...navigationDemos,
  ...overlayDemos,
};
