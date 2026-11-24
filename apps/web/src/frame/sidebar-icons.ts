import type { IconData } from "@grasp-os/ui/lib/icons";
import {
  AppWindowIcon as HugeAppWindowIcon,
  ArrowLeftRightIcon as HugeArrowLeftRightIcon,
  CableIcon as HugeCableIcon,
  ContrastIcon as HugeContrastIcon,
  HelpCircleIcon,
  Invoice01Icon,
  LaptopIcon as HugeLaptopIcon,
  SmartPhone01Icon,
  Tablet01Icon,
  ZapIcon as HugeZapIcon,
} from "@hugeicons/core-free-icons";

// The reference's sidebar icons Damsko's set (lib/icons) doesn't have yet,
// from the same Hugeicons drawings it takes its own from, under the names
// Damsko gives them (registry gap of 24 Nov 2026). Each moves to
// lib/icons once Damsko adds it, and this file goes.

export const AppWindowIcon: IconData = HugeAppWindowIcon;
export const ArrowLeftRightIcon: IconData = HugeArrowLeftRightIcon;
export const CableIcon: IconData = HugeCableIcon;
export const ContrastIcon: IconData = HugeContrastIcon;
export const CircleHelpIcon: IconData = HelpCircleIcon;
export const InvoiceIcon: IconData = Invoice01Icon;
export const LaptopIcon: IconData = HugeLaptopIcon;
export const SmartphoneIcon: IconData = SmartPhone01Icon;
export const TabletIcon: IconData = Tablet01Icon;
export const ZapIcon: IconData = HugeZapIcon;
