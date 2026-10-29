/**
 * What staff do on a rollout's page under Platform, as the admin's
 * rollout page did it: approve, retry, pause, resume or cancel it; roll a
 * company or a whole ring back; and, for a secrets rollout, check whether
 * the old shared secrets can be revoked. Every change is the admin's
 * own (src/rollout/functions.ts), audited there; the page is read again
 * after each, whether it worked or not.
 */
import { Button } from "@grasp-os/ui/components/button";
import { Checkbox } from "@grasp-os/ui/components/checkbox";
import { Label } from "@grasp-os/ui/components/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { cn } from "@grasp-os/ui/lib/utils";
import { Link, useRouter } from "@tanstack/react-router";
import { useId, useState } from "react";

import { formatTime } from "../releases/format.ts";
import type { RingChecks } from "../rollout/control.ts";
import {
  approveRolloutFn,
  cancelRolloutFn,
  checkRevocationFn,
  pauseRolloutFn,
  resumeRolloutFn,
  retryRolloutFn,
  rollbackClientFn,
  rollbackRingFn,
} from "../rollout/functions.ts";
import type { RolloutChange } from "../rollout/functions.ts";
import type { RolloutView, TargetView } from "../rollout/queries.ts";
import type {
  RevocationCheck,
  RevocationRefusal,
} from "../rollout/shared-secrets.ts";
import { useRolloutAction } from "../rollout/use-action.ts";
import { thenRefresh } from "../use-action.ts";
import { Panel } from "./panel.tsx";
import { ringWords, targetWords } from "./platform-parts.tsx";
import { ringsOf } from "./platform.ts";

/**
 * A target's statuses once a step of the rollout started on it: what a
 * rollback can undo, if its traffic moved (src/rollout/rollback.ts).
 */
const reached: ReadonlySet<TargetView["status"]> = new Set([
  "deploying",
  "done",
  "failed",
  "stopped",
]);

/** A rollout's run statuses in which staff can pause it. */
const pausable: ReadonlySet<RolloutView["run"]> = new Set([
  "queued",
  "running",
  "waiting",
]);

/** How many of the rollout's clients failed. */
const failedCount = (rollout: RolloutView): number =>
  rollout.targets.filter(({ status }) => status === "failed").length;

/** What the rollout is doing, in words, from its status and its run's. */
export const rolloutStateWords = (rollout: RolloutView): string => {
  if (rollout.run === "paused") {
    return "Paused";
  }
  const failed = failedCount(rollout);
  if (rollout.status === "waiting" && failed > 0) {
    return `Reached every client, ${failed} failed: waiting for a retry of ${failed === 1 ? "it" : "them"}, or a cancel to end it there`;
  }
  if (rollout.status === "waiting") {
    return `${ringWords(rollout.ring)} passed: waiting for approval to roll out to every other client`;
  }
  if (rollout.status === "running") {
    return `Rolling out to ${ringWords(rollout.ring)}`;
  }
  const { status } = rollout;
  return `${status.charAt(0).toUpperCase()}${status.slice(1)}`;
};

/**
 * Runs a change and reads the page again, whether it worked or not: a
 * control's action.
 */
const useControl = () => {
  const router = useRouter();
  const { busy, failure, run } = useRolloutAction();
  const act = (change: () => Promise<RolloutChange<unknown>>) => {
    void run(
      async () =>
        await thenRefresh(change, async () => {
          await router.invalidate({ sync: true });
        })
    );
  };
  return { busy, failure, act };
};

/** A refusal or failure, said where it happened. */
const Alert = ({ children }: { children: string }) => (
  <p className="text-destructive" role="alert">
    {children}
  </p>
);

/** Nothing checked yet. */
export const uncheckedRing: RingChecks = { evalPassed: false, demoSent: false };

/**
 * What staff confirm of the ring a rollout passed before approving the
 * next (`RingChecks`): Stephen's eval on the release, and the five demo
 * messages sent in real Teams on that ring.
 */
export const RingChecklist = ({
  checks,
  onChange,
}: {
  checks: RingChecks;
  onChange: (checks: RingChecks) => void;
}) => {
  const id = useId();
  return (
    <fieldset className="flex flex-col gap-1 text-sm">
      <legend className="sr-only">Before the next ring</legend>
      <div className="flex items-center gap-2">
        <Checkbox
          checked={checks.evalPassed}
          id={`${id}-eval`}
          onCheckedChange={(checked) => {
            onChange({ ...checks, evalPassed: checked });
          }}
        />
        <Label htmlFor={`${id}-eval`}>
          Stephen&apos;s eval passed on this release
        </Label>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          checked={checks.demoSent}
          id={`${id}-demo`}
          onCheckedChange={(checked) => {
            onChange({ ...checks, demoSent: checked });
          }}
        />
        <Label htmlFor={`${id}-demo`}>
          The five demo messages, sent in real Teams on this ring, all answered
        </Label>
      </div>
    </fieldset>
  );
};

/** What staff can do to the rollout as a whole, as its status lets them. */
export const Controls = ({ rollout }: { rollout: RolloutView }) => {
  const { busy, failure, act } = useControl();
  const [checks, setChecks] = useState(uncheckedRing);
  const data = { rolloutId: rollout.id };
  const active = rollout.status === "running" || rollout.status === "waiting";
  const waiting = rollout.status === "waiting" && rollout.run !== "paused";
  const failed = failedCount(rollout);
  const buttons = [
    waiting && failed === 0 ? (
      <Button
        disabled={busy}
        key="approve"
        onClick={() => {
          act(
            async () => await approveRolloutFn({ data: { ...data, checks } })
          );
        }}
        size="sm"
      >
        Approve every other client
      </Button>
    ) : null,
    waiting && failed > 0 ? (
      <Button
        disabled={busy}
        key="retry"
        onClick={() => {
          act(async () => await retryRolloutFn({ data }));
        }}
        size="sm"
      >
        Retry failed clients
      </Button>
    ) : null,
    active && pausable.has(rollout.run) ? (
      <Button
        disabled={busy}
        key="pause"
        onClick={() => {
          act(async () => await pauseRolloutFn({ data }));
        }}
        size="sm"
        variant="outline"
      >
        Pause
      </Button>
    ) : null,
    rollout.run === "paused" ? (
      <Button
        disabled={busy}
        key="resume"
        onClick={() => {
          act(async () => await resumeRolloutFn({ data }));
        }}
        size="sm"
      >
        Resume
      </Button>
    ) : null,
    rollout.status === "waiting" ? (
      <Button
        disabled={busy}
        key="cancel"
        onClick={() => {
          act(async () => await cancelRolloutFn({ data }));
        }}
        size="sm"
        variant="outline"
      >
        Cancel
      </Button>
    ) : null,
  ].filter((button) => button !== null);
  if (buttons.length === 0 && failure === null) {
    return null;
  }
  return (
    <div className="flex flex-col gap-3 border-t px-5 py-4">
      {waiting && failed === 0 ? (
        <RingChecklist checks={checks} onChange={setChecks} />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {buttons}
        {failure === null ? null : <Alert>{failure}</Alert>}
      </div>
    </div>
  );
};

/** Why a rotated secret's old value must be kept, in words; null when it can go. */
const keepReason = (check: RevocationCheck, name: string): string | null => {
  if (check.storeChanged.includes(name)) {
    return `Keep the old ${name}: Secrets Store changed it again since this rollout started, so roll that out first.`;
  }
  const behind = check.behind[name] ?? [];
  if (behind.length > 0) {
    return `Keep the old ${name}: ${behind.join(", ")} ${behind.length === 1 ? "isn't" : "aren't"} known to run the new value yet. Active clients are read live, and one that doesn't answer, or is still being provisioned, counts.`;
  }
  return null;
};

/** What a revocation check says, secret by secret, then what else it found, in words. */
const checkLines = (check: RevocationCheck): string[] => [
  ...(check.rotated.length === 0
    ? [
        "Secrets Store held what the clients this rollout reached already ran: it hasn't changed, so deploy-ops may not have run, and there's nothing to revoke yet.",
      ]
    : []),
  ...(check.revocable.length === 0
    ? []
    : [
        `The old ${check.revocable.join(", ")} can be revoked at ${check.revocable.length === 1 ? "its provider" : "their providers"}: every active client runs the new value, read live, and none is still being provisioned.`,
      ]),
  ...check.rotated.flatMap((name) => {
    const reason = keepReason(check, name);
    return reason === null ? [] : [reason];
  }),
  ...check.storeChanged
    .filter((name) => !check.rotated.includes(name))
    .map(
      (name) =>
        `Secrets Store changed ${name} since this rollout started: roll it out first.`
    ),
  ...(check.unproven.length === 0
    ? []
    : [
        `What ${check.unproven.join(", ")} ran before isn't on record, so the rotation can't be told from them.`,
      ]),
  ...(check.skipped.length === 0
    ? []
    : [
        `This rollout skipped ${check.skipped.map(({ clientId, reason }) => `${clientId} (${reason})`).join(", ")}.`,
      ]),
  ...(check.outOfScope.length === 0
    ? []
    : [`Outside its scope: ${check.outOfScope.join(", ")}.`]),
];

/** Rollout `rolloutId`'s revocation check, or `failed` when it couldn't be read. Never throws. */
const readRevocation = async (
  rolloutId: string
): Promise<RevocationCheck | RevocationRefusal | "failed"> => {
  try {
    return await checkRevocationFn({ data: { rolloutId } });
  } catch {
    return "failed";
  }
};

/** A revocation check, or why none could be made, in words. */
const verdictOf = (
  result: RevocationCheck | RevocationRefusal | "failed"
): { safe: boolean; lines: string[] } => {
  if (result === "failed") {
    return { safe: false, lines: ["That did not work. Try again."] };
  }
  if (result === "store_unreadable") {
    return {
      safe: false,
      lines: [
        "Secrets Store is missing a shared secret, so nothing can be told.",
      ],
    };
  }
  if (result === "not_secrets_rollout") {
    return { safe: false, lines: ["This isn't a secrets rollout."] };
  }
  // Safe only when every secret it rotated can go: anything else is a
  // warning, whatever else can.
  return {
    safe:
      result.rotated.length > 0 &&
      result.revocable.length === result.rotated.length,
    lines: checkLines(result),
  };
};

/**
 * Whether a secrets rollout's old shared secrets can be revoked at their
 * providers, read live from every active client when staff ask
 * (src/rollout/shared-secrets.ts).
 */
export const Revocation = ({ rolloutId }: { rolloutId: string }) => {
  const [verdict, setVerdict] = useState<{
    safe: boolean;
    lines: string[];
  } | null>(null);
  const [reading, setReading] = useState(false);
  const check = async () => {
    setReading(true);
    const result = await readRevocation(rolloutId);
    setReading(false);
    setVerdict(verdictOf(result));
  };
  return (
    <Panel
      action={
        <Button
          className="flex-none"
          disabled={reading}
          onClick={() => {
            void check();
          }}
          size="sm"
          variant="outline"
        >
          Check whether the old secrets can be revoked
        </Button>
      }
      description="Read live from every active company when you ask: whether each runs the new values, so the old ones can go at their providers."
      title="The old secrets"
    >
      {verdict === null ? null : (
        <div
          className={cn(
            "flex flex-col gap-1 border-t px-5 py-3",
            !verdict.safe && "text-destructive"
          )}
          role={verdict.safe ? undefined : "alert"}
        >
          {verdict.lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
      )}
    </Panel>
  );
};

/** A rollback staff asked for: of one client, or of a ring. */
type PendingRollback =
  | { clientId: string; ring?: never }
  | { ring: number; clientId?: never };

/** One company in the rollout: where it stands, why, and its rollback. */
const TargetRow = ({
  target,
  name,
  busy,
  onRollBack,
}: {
  target: TargetView;
  name: string;
  busy: boolean;
  onRollBack: () => void;
}) => (
  <TableRow>
    <TableCell variant="card">
      <span className="flex min-w-0 flex-col gap-0.5">
        <Link
          className="truncate underline-offset-4 hover:underline"
          params={{ clientId: target.clientId }}
          to="/organizations/$clientId/setup"
        >
          {name}
        </Link>
        <span className="text-muted-foreground truncate font-mono text-xs">
          {target.clientId}
        </span>
      </span>
    </TableCell>
    <TableCell variant="card">
      <span
        className={cn(
          (target.status === "failed" || target.status === "rolled_back") &&
            "text-status-attention",
          target.status === "pending" && "text-muted-foreground"
        )}
      >
        {targetWords[target.status]}
      </span>
    </TableCell>
    <TableCell className="whitespace-normal" variant="card">
      <span className="font-mono text-xs break-all">{target.error ?? ""}</span>
    </TableCell>
    <TableCell className="hidden @2xl:table-cell" variant="card">
      <span className="text-muted-foreground tabular-nums">
        {formatTime(target.updatedAt)}
      </span>
    </TableCell>
    <TableCell className="text-right" variant="card">
      {reached.has(target.status) ? (
        <Button
          disabled={busy}
          onClick={onRollBack}
          size="sm"
          variant="outline"
        >
          Roll back
        </Button>
      ) : null}
    </TableCell>
  </TableRow>
);

/**
 * The rollout's companies, ring by ring, each rolled back on its own or
 * with its ring, named as the admin names them (`names`).
 */
export const Targets = ({
  rollout,
  names,
}: {
  rollout: RolloutView;
  names: ReadonlyMap<string, string>;
}) => {
  const { busy, failure, act } = useControl();
  // The clients a ring's rollback left, and why: the rest were rolled back.
  const [left, setLeft] = useState<string | null>(null);
  const rollBackRing = (ring: number) => {
    setLeft(null);
    act(async () => {
      const result = await rollbackRingFn({
        data: { rolloutId: rollout.id, ring },
      });
      const refused = (result.done ?? []).filter(
        ({ refused: code }) => code !== null
      );
      if (refused.length > 0) {
        setLeft(
          `Not rolled back: ${refused
            .map(({ clientId, refused: code }) => `${clientId} (${code ?? ""})`)
            .join(", ")}.`
        );
      }
      return result;
    });
  };
  const rollBackClient = (clientId: string) => {
    act(
      async () =>
        await rollbackClientFn({
          data: { rolloutId: rollout.id, clientId },
        })
    );
  };
  // A secrets rollout's rollback puts the old shared secrets back, which
  // may be revoked at their providers already: asked first.
  const [confirming, setConfirming] = useState<PendingRollback | null>(null);
  const runRollback = (pending: PendingRollback) => {
    setConfirming(null);
    if (pending.ring === undefined) {
      rollBackClient(pending.clientId);
    } else {
      rollBackRing(pending.ring);
    }
  };
  const rollBack = (pending: PendingRollback) => {
    if (rollout.kind === "secrets") {
      setConfirming(pending);
    } else {
      runRollback(pending);
    }
  };
  return (
    <>
      {confirming === null ? null : (
        <div
          className="border-destructive bg-card flex flex-col gap-3 rounded-xl border px-5 py-4"
          role="alert"
        >
          <p>
            {`Rolling ${confirming.ring === undefined ? (names.get(confirming.clientId) ?? confirming.clientId) : ringWords(confirming.ring)} back puts the shared secrets it ran before back. If you revoked them at their providers, its people can't sign in or reach their connections until the next secrets rollout.`}
          </p>
          <div className="flex gap-2">
            <Button
              disabled={busy}
              onClick={() => {
                runRollback(confirming);
              }}
              size="sm"
              variant="destructive"
            >
              Roll back anyway
            </Button>
            <Button
              onClick={() => {
                setConfirming(null);
              }}
              size="sm"
              variant="outline"
            >
              Keep the new secrets
            </Button>
          </div>
        </div>
      )}
      {failure === null ? null : <Alert>{failure}</Alert>}
      {left === null ? null : <Alert>{left}</Alert>}
      {ringsOf(rollout, rollout.targets).map(({ ring, targets, done }) => (
        <Panel
          action={
            targets.some(({ status }) => reached.has(status)) ? (
              <Button
                className="flex-none"
                disabled={busy}
                onClick={() => {
                  rollBack({ ring });
                }}
                size="sm"
                variant="outline"
              >
                {`Roll back ${ringWords(ring)}`}
              </Button>
            ) : undefined
          }
          description={`${done} of ${targets.length} on it.`}
          key={ring}
          title={ringWords(ring)}
        >
          <div className="@container border-t">
            <Table className="table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead variant="card">Company</TableHead>
                  <TableHead className="w-28" variant="card">
                    Status
                  </TableHead>
                  <TableHead variant="card">Why</TableHead>
                  <TableHead
                    className="hidden w-40 @2xl:table-cell"
                    variant="card"
                  >
                    Updated (UTC)
                  </TableHead>
                  <TableHead className="w-28" variant="card">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {targets.map((target) => (
                  <TargetRow
                    busy={busy}
                    key={target.clientId}
                    name={names.get(target.clientId) ?? target.clientId}
                    onRollBack={() => {
                      rollBack({ clientId: target.clientId });
                    }}
                    target={target}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        </Panel>
      ))}
    </>
  );
};
