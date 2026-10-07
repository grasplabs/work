/**
 * The examples in the inventory (`examples` in inventory.ts), each loaded by
 * name and only when asked for: nothing here imports an example until its
 * loader runs. The source is at `catalog/examples/<name>.tsx`.
 */
import type { ComponentType } from "react";

import type { ExampleName } from "./inventory.ts";

export const loadExample: Record<ExampleName, () => Promise<ComponentType>> = {
  list: async () => {
    const { ListExample } = await import("./examples/list.tsx");
    return ListExample;
  },
  "detail-form": async () => {
    const { DetailFormExample } = await import("./examples/detail-form.tsx");
    return DetailFormExample;
  },
  dialog: async () => {
    const { DialogExample } = await import("./examples/dialog.tsx");
    return DialogExample;
  },
  table: async () => {
    const { TableExample } = await import("./examples/table.tsx");
    return TableExample;
  },
  "responsive-navigation": async () => {
    const { ResponsiveNavigationExample } =
      await import("./examples/responsive-navigation.tsx");
    return ResponsiveNavigationExample;
  },
  "specialised-panel": async () => {
    const { SpecialisedPanelExample } =
      await import("./examples/specialised-panel.tsx");
    return SpecialisedPanelExample;
  },
};
