"use client";

/* oxlint-disable typescript/no-deprecated -- the breaking release's step 1: this file keeps an old name working beside its new one until step 9 removes it (handover/audit/RELEASE.md §7). */
import { ComposerAction } from "../composer";
import type { ComposerActionProps } from "../composer";

/**
 * Every prop an AskBarAction takes.
 * @deprecated Use `ComposerActionProps`.
 */
export type AskBarActionProps = Omit<ComposerActionProps, "pressedVariant">;

/**
 * A borderless icon button for the Ask bar's `actions`.
 * @deprecated Use `ComposerAction` with `pressedVariant="quiet"`: the same button, pressed with the quiet fill.
 */
export const AskBarAction = (props: AskBarActionProps) => (
  <ComposerAction {...props} pressedVariant="quiet" />
);
