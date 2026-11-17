/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
export { DropdownMenu, MenuWorkProvider, useMenuWork } from "./menu";
export type { DropdownMenuProps, MenuWork } from "./menu";
export { DropdownMenuTrigger } from "./trigger";
export type { DropdownMenuTriggerProps } from "./trigger";
export { DropdownMenuContent, DropdownMenuPanel } from "./panel";
export type { DropdownMenuContentProps, DropdownMenuPanelProps } from "./panel";
export { DropdownMenuItem } from "./item";
export type { DropdownMenuItemProps } from "./item";
export { DropdownMenuCheckboxItem } from "./checkbox-item";
export type { DropdownMenuCheckboxItemProps } from "./checkbox-item";
export { DropdownMenuRadioGroup } from "./radio-group";
export type { DropdownMenuRadioGroupProps } from "./radio-group";
export { DropdownMenuRadioItem } from "./radio-item";
export type { DropdownMenuRadioItemProps } from "./radio-item";
export { DropdownMenuGroup } from "./group";
export type { DropdownMenuGroupProps } from "./group";
export { DropdownMenuLabel } from "./label";
export type { DropdownMenuLabelProps } from "./label";
export { DropdownMenuSeparator } from "./separator";
export type { DropdownMenuSeparatorProps } from "./separator";
// The look, for the menus built from these parts (Context menu, Menubar).
export { menuStyles } from "./styles";
export { createMenuController } from "@ui-sdk/react/menu";
export type { MenuController } from "@ui-sdk/react/menu";
