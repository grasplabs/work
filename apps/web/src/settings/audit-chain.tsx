import type {
  ChainBreak,
  ChainVerification,
  FullVerification,
} from "@grasp-os/shared/audit-log";
import { Button } from "@grasp-os/ui/components/button";
import { Spinner } from "@grasp-os/ui/components/spinner";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";

import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { SettingsRow, SettingsSection } from "./settings-parts.tsx";

// Settings › Audit trail › Chain check: verifies the whole hash chain of
// the audit log, archived stretches included, from its first entry to its
// head. Core checks a stretch per call (`audit.verify`), so the page asks
// for the next stretch from where the last one ended, and says how far it
// got, until core says it reached the head or names the first entry where
// the chain breaks. Core keeps a pass that runs from the first entry
// unbroken as the last full verification (`audit.lastVerification`),
// which the page shows until it runs a pass of its own, and which exports
// report; it records each pass that ends in the log itself. Admins only,
// as core checks on every call.

/** Why the chain breaks, in the page's language. */
const breakReasons: Record<ChainBreak, MessageDescriptor> = {
  missing: msg`An entry is missing.`,
  unlinked: msg`An entry doesn't link to the one before it.`,
  altered: msg`An entry was changed after it was written.`,
};

/**
 * Verifies the chain from its first entry, a stretch at a time, telling
 * `progress` how far it got after each, until it reaches the head or a
 * break. A stretch that gets no further than the last is core's mistake,
 * not the chain's: it stops there rather than ask forever.
 */
const verifyChain = async (
  session: Session,
  progress: (through: number) => void
): Promise<FullVerification> => {
  const startedAt = new Date().toISOString();
  let after = 0;
  for (;;) {
    // Each stretch starts where the last one ended.
    // oxlint-disable-next-line no-await-in-loop -- one after the other, by design
    const step: ChainVerification = await session.audit.verify(after);
    const finishedAt = new Date().toISOString();
    if (!step.ok) {
      const { brokenAt, reason } = step;
      return { ok: false, brokenAt, reason, startedAt, finishedAt };
    }
    progress(step.through);
    if (step.done) {
      const { through, head } = step;
      return { ok: true, through, head, startedAt, finishedAt };
    }
    if (step.through <= after) {
      throw new Error(`The chain check stopped at entry ${after}.`);
    }
    after = step.through;
  }
};

/** What the last full pass found, or how far the running one got. */
const Outcome = ({
  running,
  through,
  ended,
}: {
  running: boolean;
  through: number;
  ended: FullVerification | null;
}) => {
  const { i18n } = useLingui();
  if (running) {
    return (
      <span className="text-muted-foreground flex items-center gap-2">
        <Spinner />
        <Trans>Checked through entry {through}…</Trans>
      </span>
    );
  }
  if (ended === null) {
    return (
      <span className="text-muted-foreground">
        <Trans>The whole chain has not been verified yet.</Trans>
      </span>
    );
  }
  const time = formatDateTime(ended.finishedAt);
  if (ended.ok && ended.through === 0) {
    return (
      <span>
        <Trans>
          The audit trail has no entries yet: there is nothing to verify.
        </Trans>
      </span>
    );
  }
  if (ended.ok) {
    const entries = ended.through;
    const purged = ended.purgedThrough;
    return (
      <span>
        <Trans>
          The whole chain verified, through entry {entries}, on {time}.
        </Trans>
        {purged === undefined ? null : (
          <>
            {" "}
            <Trans>
              Entries through {purged} were removed when their retention ended:
              they still link up, but could not be checked.
            </Trans>
          </>
        )}
      </span>
    );
  }
  const entry = ended.brokenAt;
  return (
    <span className="text-destructive" role="alert">
      <Trans>
        On {time}, the chain broke at entry {entry}: nothing from there on is
        verified.
      </Trans>{" "}
      {i18n._(breakReasons[ended.reason])}
    </span>
  );
};

/**
 * The chain check, for an admin: `last`, the last full pass core kept,
 * until the page runs one of its own.
 */
export const AuditChainCheck = ({
  last,
}: {
  last: Loaded<FullVerification | null>;
}) => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const [through, setThrough] = useState(0);
  const [own, setOwn] = useState<FullVerification | null>(null);
  const verify = async (): Promise<void> => {
    setThrough(0);
    const result = await run(
      async (session) => await verifyChain(session, setThrough)
    );
    if (result !== undefined) {
      setOwn(result);
    }
  };
  return (
    <SettingsSection
      description={t`Check that no entry of the audit trail was removed or changed since it was written, from the first to the latest.`}
      title={t`Chain check`}
    >
      <SettingsRow label={t`Verify the chain`}>
        <Button
          disabled={busy}
          onClick={() => {
            void verify();
          }}
          size="sm"
          variant="outline"
        >
          <Trans>Verify now</Trans>
        </Button>
      </SettingsRow>
      <div
        className="flex flex-col gap-1 border-t px-5 py-4"
        aria-live="polite"
      >
        {own === null && !busy && last.state !== "ready" ? (
          <NotLoaded page={last} />
        ) : (
          <Outcome
            ended={own ?? (last.state === "ready" ? last.data : null)}
            running={busy}
            through={through}
          />
        )}
        <ErrorText>{failure}</ErrorText>
      </div>
    </SettingsSection>
  );
};
