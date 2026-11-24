/**
 * Linted by scripts/lint/no-inline-styles.test.ts: a component of the
 * feature's own with members, one the kit's Button and one its own.
 */
import { Button as KitButton } from "@grasp-os/app-kit/components/button";

import { Panel } from "./own-panel.tsx";

export const Menu = () => null;
Menu.Item = KitButton;
Menu.Panel = Panel;
