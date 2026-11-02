/**
 * Short examples of composing the kit's components into common screens,
 * each loaded by name and only when asked for: nothing here imports an
 * example until its loader runs. The source is at
 * `catalog/examples/<name>.tsx`.
 */
import type { ComponentType } from "react";

export const loadExample = {
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
} satisfies Record<string, () => Promise<ComponentType>>;

/** An example, by name. */
export type ExampleName = keyof typeof loadExample;
