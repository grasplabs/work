import type { ChainBreak, ChainVerification } from "@grasp-os/shared/audit-log";
import { Button } from "@grasp-os/ui/components/button";
import { Spinner } from "@grasp-os/ui/components/spinner";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";

import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";
import { SettingsRow, SettingsSection } from "./settings-parts.tsx";

// Settings › Audit trail › Chain check: verifies the whole hash chain of
// the audit log, archived stretches included, from its first entry to its
// head. Core checks a stretch per call (`audit.verify`), so the page asks
// for the next stretch from where the last one ended, and says how far it
// got, until core says it reached the head or names the first entry where
// the chain breaks. Core keeps a pass that runs from the first entry
// unbroken as the last full verification, which exports report, and
// records each pass that ends in the log itself. Admins only, as core
// checks on every call.

/** A pass that ended: how, and when the page saw it end. */
type Ended = { checkedAt: string } & (
  | { ok: true; through: number }
  | { ok: false; brokenAt: number; reason: ChainBreak }
);

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
): Promise<Ended> => {
  let after = 0;
  for (;;) {
    // Each stretch starts where the last one ended.
    // oxlint-disable-next-line no-await-in-loop -- one after the other, by design
    const step: ChainVerification = await session.audit.verify(after);
    const checkedAt = new Date().toISOString();
    if (!step.ok) {
      return {
        ok: false,
        brokenAt: step.brokenAt,
        reason: step.reason,
        checkedAt,
      };
    }
    progress(step.through);
    if (step.done) {
      return { ok: true, through: step.through, checkedAt };
    }
    if (step.through <= after) {
      throw new Error(`The chain check stopped at entry ${after}.`);
    }
    after = step.through;
  }
};

/** What the last pass found, or how far the running one got. */
const Outcome = ({
  running,
  through,
  ended,
}: {
  running: boolean;
  through: number;
  ended: Ended | null;
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
        <Trans>Not verified since this page opened.</Trans>
      </span>
    );
  }
  const time = formatDateTime(ended.checkedAt);
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
    return (
      <span>
        <Trans>
          The whole chain verified, through entry {entries}, at {time}.
        </Trans>
      </span>
    );
  }
  const entry = ended.brokenAt;
  return (
    <span className="text-destructive" role="alert">
      <Trans>
        The chain breaks at entry {entry}: nothing from there on is verified.
      </Trans>{" "}
      {i18n._(breakReasons[ended.reason])}
    </span>
  );
};

/** The chain check, for an admin. */
export const AuditChainCheck = () => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const [through, setThrough] = useState(0);
  const [ended, setEnded] = useState<Ended | null>(null);
  const verify = async (): Promise<void> => {
    setThrough(0);
    const result = await run(
      async (session) => await verifyChain(session, setThrough)
    );
    setEnded(result ?? null);
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
        <Outcome ended={ended} running={busy} through={through} />
        <ErrorText>{failure}</ErrorText>
      </div>
    </SettingsSection>
  );
};
