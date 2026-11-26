/**
 * Linted by scripts/lint/no-inline-styles.test.ts: a component of the
 * feature's own with members, one another package's (the router's Link)
 * and one its own.
 */
import { Link } from "@tanstack/react-router";

import { Panel } from "./own-panel.tsx";

export const Menu = () => null;
Menu.Item = Link;
Menu.Panel = Panel;
