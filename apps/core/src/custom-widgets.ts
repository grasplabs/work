import { widgetSpecSchema } from "@grasp-os/shared/widgets";
import type { CustomWidgetId, WidgetSpec } from "@grasp-os/shared/widgets";

import type { customWidgets } from "./db/workspace/schema.ts";

// The widgets Grasp made for a person, as their Workspace object keeps
// them (workspace.ts) and dashboard-widgets.ts shows them.

/** A widget Grasp made for a person, as their Workspace keeps it. */
export interface KeptWidget {
  id: CustomWidgetId;
  spec: WidgetSpec;
  asked: string;
  madeAt: Date;
  changedAt: Date;
}

/** A stored widget, or `undefined` when its spec no longer reads as one. */
export const keptWidgetOf = (
  row: typeof customWidgets.$inferSelect
): KeptWidget | undefined => {
  let json: unknown;
  try {
    json = JSON.parse(row.spec);
  } catch {
    return undefined;
  }
  const spec = widgetSpecSchema.safeParse(json);
  return spec.success
    ? {
        id: row.id,
        spec: spec.data,
        asked: row.asked,
        madeAt: row.madeAt,
        changedAt: row.changedAt,
      }
    : undefined;
};
