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
import { Alert } from "../grasp/alert/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from "../grasp/dialog/index.ts";
import { Info } from "../grasp/icons/index.ts";
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

// Settings › Audit trail › Integrity and archive: verifies the whole hash
// chain of the audit log, archived stretches included, from its first
// entry to its head, in a Dialog from the events card's head, beside how
// long Grasp keeps events (audit-archive.tsx). A broken chain never hides
// in the dialog: the page says so above the events (`ChainBroken`). Core checks a stretch per call (`audit.verify`), so the page asks
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

/** What the last pass found, from the page's own check or core's last. */
export const endedOf = (
  own: FullVerification | null,
  last: Loaded<FullVerification | null>
): FullVerification | null =>
  own ?? (last.state === "ready" ? last.data : null);

/**
 * A broken chain, on the page itself above the events: where it broke and
 * why, never only in the dialog.
 */
export const ChainBroken = ({ ended }: { ended: FullVerification | null }) => {
  const { t, i18n } = useLingui();
  if (ended === null || ended.ok) {
    return null;
  }
  const time = formatDateTime(ended.finishedAt);
  const entry = ended.brokenAt;
  const reason = i18n._(breakReasons[ended.reason]);
  return (
    <Alert title={t`The audit trail's chain is broken`} tone="danger">
      {t`On ${time}, the check found a break at event ${entry}: nothing from there on is verified. ${reason}`}
    </Alert>
  );
};

/**
 * Integrity and archive, behind one quiet button in the events card's
 * head: what the chain is, when it was last checked and whether it holds,
 * Check now, and how long Grasp keeps events. `onChecked` hears a check
 * the page ran, so a break shows on the page too.
 */
export const IntegrityDialog = ({
  last,
  own,
  onChecked,
  children,
}: {
  last: Loaded<FullVerification | null>;
  /** The check the page ran, if it ran one. */
  own: FullVerification | null;
  onChecked: (ended: FullVerification) => void;
  /** How long Grasp keeps events, as rows after the check's. */
  children?: ReactNode;
}) => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const [through, setThrough] = useState(0);
  const verify = async (): Promise<void> => {
    setThrough(0);
    const result = await run(
      async (session) => await verifyChain(session, setThrough)
    );
    if (result !== undefined) {
      onChecked(result);
    }
  };
  return (
    <Dialog>
      <DialogTrigger
        aria-label={t`Integrity and archive`}
        icon={Info}
        size="sm"
        tooltip={t`Integrity and archive`}
        variant="ghost"
      />
      <DialogContent closeLabel={t`Close`}>
        <DialogTitle>{t`Integrity and archive`}</DialogTitle>
        <DialogDescription>
          {t`Every event is chained to the one before it, so an event removed or changed later shows as a break in the chain.`}
        </DialogDescription>
        <DialogBody>
          <div aria-live="polite">
            {own === null && !busy && last.state !== "ready" ? (
              <SectionNotLoaded page={last} />
            ) : (
              <SettingsRows>
                <Outcome
                  ended={endedOf(own, last)}
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
        </DialogBody>
        <DialogFooter>
          <Button
            disabled={busy}
            onClick={() => {
              void verify();
            }}
            size="sm"
          >
            {t`Check now`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
