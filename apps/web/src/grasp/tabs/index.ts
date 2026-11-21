/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
export {
  Tabs,
  TabsList,
  TabsContent,
  TabsPanel,
  TabsTrigger,
  TabsTab,
} from "./tabs";
export type {
  TabsLayoutStyle,
  TabsListProps,
  TabsContentProps,
  TabsPanelProps,
  TabsProps,
  TabsTriggerProps,
  TabsTabProps,
} from "./tabs";
export { TabsLink, TabsNav } from "./nav";
export type { TabsLinkProps, TabsNavProps } from "./nav";
