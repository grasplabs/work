import type {
  ChainBreak,
  ChainVerification,
  FullVerification,
} from "@grasp-os/shared/audit-log";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";
import type { ReactNode } from "react";

import type { Session } from "../core.ts";
import { formatDateTime } from "../format.ts";
import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { FactRow, RowAlert, SettingsRows } from "../grasp/setting-row/index.ts";
import { Spinner } from "../grasp/spinner/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import type { Loaded } from "../load-from-core.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { SectionNotLoaded } from "./section.tsx";

const styles = stylex.create({
  running: { display: "flex", alignItems: "center", gap: grasp.space2 },
});

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

/** What the last full pass found, or how far the running one got, as rows of the card. */
const Outcome = ({
  running,
  through,
  ended,
}: {
  running: boolean;
  through: number;
  ended: FullVerification | null;
}) => {
  const { t, i18n } = useLingui();
  if (running) {
    return (
      <FactRow label={t`Checking`}>
        <span {...stylex.props(styles.running)}>
          <Spinner />
          <Text element="span" size="sm">
            {t`Through entry ${through}…`}
          </Text>
        </span>
      </FactRow>
    );
  }
  if (ended === null) {
    return <FactRow label={t`Last check`}>{t`Not checked yet`}</FactRow>;
  }
  const time = formatDateTime(ended.finishedAt);
  if (ended.ok && ended.through === 0) {
    return <FactRow label={t`Last check`}>{t`Nothing to check yet`}</FactRow>;
  }
  if (ended.ok) {
    const entries = ended.through;
    const purged = ended.purgedThrough;
    return (
      <FactRow
        help={
          purged === undefined
            ? time
            : t`${time}. Entries through ${purged} were removed when their retention ended; they still link up.`
        }
        label={t`Last check`}
      >
        <Badge tone="success">{t`Verified through ${entries}`}</Badge>
      </FactRow>
    );
  }
  const entry = ended.brokenAt;
  const reason = i18n._(breakReasons[ended.reason]);
  return (
    <RowAlert variant="danger">
      {t`On ${time}, the chain broke at entry ${entry}: nothing from there on is verified. ${reason}`}
    </RowAlert>
  );
};

/**
 * The chain check, for an admin: `last`, the last full pass core kept,
 * until the page runs one of its own. One card, its result as a row, and
 * Verify now in its head.
 */
export const AuditChainCheck = ({
  last,
  children,
}: {
  last: Loaded<FullVerification | null>;
  /** More about the log's integrity, as rows after the check's: how long it is kept. */
  children?: ReactNode;
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
    <SectionCard
      actions={
        <Button
          disabled={busy}
          onClick={() => {
            void verify();
          }}
          size="sm"
        >
          {t`Verify now`}
        </Button>
      }
      density="compact"
      description={t`Whether any event was removed or changed since it was written, and how long Grasp keeps them.`}
      flush
      title={t`Integrity`}
    >
      <div aria-live="polite">
        {own === null && !busy && last.state !== "ready" ? (
          <SectionNotLoaded page={last} />
        ) : (
          <SettingsRows>
            <Outcome
              ended={own ?? (last.state === "ready" ? last.data : null)}
              running={busy}
              through={through}
            />
            {failure === undefined ? null : (
              <RowAlert variant="danger">{failure}</RowAlert>
            )}
            {children}
          </SettingsRows>
        )}
      </div>
    </SectionCard>
  );
};
