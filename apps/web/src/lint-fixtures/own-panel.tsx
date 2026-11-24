/**
 * Linted by scripts/lint/no-inline-styles.test.ts: a component of the
 * feature's own, which the fixtures beside it place and pass on.
 */
import { Card } from "@grasp-os/ui/components/card";
import type { LayoutStyle } from "@grasp-os/ui/lib/utils";
import type { ReactNode } from "react";

export const Panel = ({
  style,
  children,
}: {
  style?: LayoutStyle;
  children?: ReactNode;
}) => <Card style={style}>{children}</Card>;
