import {
  composioReasonSchema,
  connectVersionSchema,
  releaseNameSchema,
} from "@grasp-os/shared/connect";
import type { ComposioReason } from "@grasp-os/shared/connect";
import { AlertDescription } from "@grasp-os/ui/components/alert";
import { useLingui } from "@lingui/react/macro";

// What core names for support beside a refused Composio connection: why
// (a word of a fixed set), the release core runs and which version of
// connect refused. A start's refusal carries them in its error's details,
// a finish's in the address core's callback sends the browser back to.
// Each is shown only in its fixed form: anyone can put anything in a link.

/** What a refusal names for support, each only in its fixed form. */
export interface Support {
  reason?: ComposioReason;
  release?: string;
  version?: string;
}

/** `values` (from an address or an error's details), only in their forms. */
export const supportOf = (values: {
  reason?: unknown;
  release?: unknown;
  version?: unknown;
}): Support => {
  const reason = composioReasonSchema.safeParse(values.reason);
  const release = releaseNameSchema.safeParse(values.release);
  const version = connectVersionSchema.safeParse(values.version);
  return {
    ...(reason.success ? { reason: reason.data } : {}),
    ...(release.success ? { release: release.data } : {}),
    ...(version.success ? { version: version.data } : {}),
  };
};

/** What the refusal `error` names for support in its details, if anything. */
export const supportOfError = (error: unknown): Support | undefined => {
  const details: unknown =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "details")
      : undefined;
  if (typeof details !== "object" || details === null) {
    return undefined;
  }
  const support = supportOf({
    reason: Reflect.get(details, "reason"),
    release: Reflect.get(details, "release"),
    version: Reflect.get(details, "version"),
  });
  return support.reason === undefined ? undefined : support;
};

/** The one line for support, each part a dash when it isn't named. */
export const useSupportLine = (): ((support: Support) => string) => {
  const { t } = useLingui();
  return ({ reason: given, release: named, version: running }) => {
    const reason = given ?? "–";
    const release = named ?? "–";
    const version = running ?? "–";
    return t`Details for support: ${reason} (release ${release}, connect ${version})`;
  };
};

/**
 * The line for support under a refusal's title, in an Alert: for an admin
 * to pass on. The values are its `data-` attributes too.
 */
export const SupportDetails = (support: Support) => {
  const line = useSupportLine();
  return (
    <AlertDescription>
      <span
        data-connect-version={support.version}
        data-reason={support.reason}
        data-release={support.release}
      >
        {line(support)}
      </span>
    </AlertDescription>
  );
};
