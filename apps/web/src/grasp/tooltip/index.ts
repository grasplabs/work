/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
export { Tooltip } from "./tooltip";
export type { TooltipProps } from "./tooltip";
export { TooltipTrigger } from "./trigger";
export type { TooltipTriggerProps } from "./trigger";
export { TooltipContent, TooltipPanel } from "./panel";
export type { TooltipContentProps, TooltipPanelProps } from "./panel";
export { TooltipShortcut } from "./shortcut";
export type { TooltipShortcutProps } from "./shortcut";
export { createTooltipController } from "@ui-sdk/react/tooltip";
export type { TooltipController } from "@ui-sdk/react/tooltip";
