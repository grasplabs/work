import { failureText, isExpectedError } from "@grasp-os/shared/errors";
import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";

import { readWithin } from "./core-connection.ts";
import type { CoreConnection } from "./core-connection.ts";
import { CoreTimeoutError, deadline } from "./core.ts";
import type { Session } from "./core.ts";
import { ErrorText } from "./error-text.tsx";

/** What a page read from core: its data, or why there is none. */
export type Loaded<T> =
  | { state: "offline" }
  | { state: "missing" }
  | { state: "refused"; message: string }
  | { state: "ready"; data: T };

/**
 * What a page can name that core may not have (any more): an App, a
 * workflow, a collection or document, a decision, a screen. Not
 * `request.not_found`, an endpoint this core doesn't know (an older one),
 * nor what a page reads along the way, such as a member: those stay
 * refusals, with their reference.
 */
const notFoundCodes = new Set([
  "app.not_found",
  "workflow.not_found",
  "knowledge.not_found",
  "decision.not_found",
  "screen.not_found",
]);

const isNotFound = (error: unknown): boolean =>
  isExpectedError(error) && notFoundCodes.has(error.code);

/**
 * Reads a page's data with `read`, on the signed-in person's session over
 * the tab's connection, within a few seconds (`readWithin`): a read that
 * hangs, or waits that long for a connection, counts as core being out of
 * reach, a read of something core doesn't have (renamed or removed) as
 * missing, and any other refusal carries core's reason. Given `left`, the
 * page's signal that it was left, a read still waiting for a connection
 * then is never sent.
 */
export const loadFromCore = async <T,>(
  core: CoreConnection,
  read: (session: Session) => Promise<T>,
  left?: AbortSignal
): Promise<Loaded<T>> => {
  const signal =
    left === undefined ? deadline() : AbortSignal.any([deadline(), left]);
  try {
    const data = await readWithin(core, read, signal);
    return { state: "ready", data };
  } catch (error) {
    if (error instanceof CoreTimeoutError) {
      return { state: "offline" };
    }
    if (isNotFound(error)) {
      return { state: "missing" };
    }
    return { state: "refused", message: failureText(error) };
  }
};

const unreachable = msg`Grasp can't be reached right now. Try again in a moment.`;
const missing = msg`Not found. It may have been renamed or removed.`;

/** Why a read from core has no data, in words; nothing once it has. */
export const notLoadedText = (
  page: Loaded<unknown>,
  i18n: I18n
): string | undefined => {
  if (page.state === "offline") {
    return i18n._(unreachable);
  }
  if (page.state === "missing") {
    return i18n._(missing);
  }
  return page.state === "refused" ? page.message : undefined;
};

/** Why a page has no data to show; nothing once it has. */
export const NotLoaded = ({ page }: { page: Loaded<unknown> }) => {
  const { i18n } = useLingui();
  return <ErrorText>{notLoadedText(page, i18n)}</ErrorText>;
};
