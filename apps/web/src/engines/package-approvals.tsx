import type {
  DependencyApprovals,
  DependencyImpact,
  DependencyRequest,
} from "@grasp-os/shared/dependencies";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@grasp-os/ui/components/table";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { i18n } from "@lingui/core";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { useId, useState } from "react";

import { changeThenRefresh } from "../change-then-refresh.ts";
import { targetNames } from "../dashboard/dependency-requests.tsx";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime, formatList } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";

// The npm packages approved for an engine, and taking an approval back
// (spec 19.3.1): retiring it, so nothing new is built with the packages
// while what was built keeps working, or revoking it, so nothing of them
// runs any more. Core decides who may (those it lets approve packages,
// `decides`) and checks it again as the decision lands, on the impact
// this page showed: the dialog reads it first and names it, so a change
// since (another approval, the policy) is refused rather than decided
// unseen.

/** What a person ends: retiring keeps what was built; revoking stops it. */
type Ending = "retire" | "revoke";

/** An approval a person asked to end, and what ending it touches. */
interface Asked {
  request: DependencyRequest;
  ending: Ending;
  impact: DependencyImpact;
}

/** The direct packages a list shows of an approval, and how many more. */
const PackagesOf = ({ request }: { request: DependencyRequest }) => {
  const shown = formatList(request.summary.direct);
  const more = request.counts.direct - request.summary.direct.length;
  return more > 0 ? (
    <Plural
      one={`${shown} and # more`}
      other={`${shown} and # more`}
      value={more}
    />
  ) : (
    shown
  );
};

/**
 * Asks the person to confirm ending an approval, with what it touches as
 * core read it and why, which the audit trail and the engine's builders
 * are told. Ends it on exactly the impact shown.
 */
const EndDialog = ({
  request,
  ending,
  impact,
  onClose,
  refresh,
}: {
  request: DependencyRequest;
  ending: Ending;
  impact: DependencyImpact;
  onClose: () => void;
  /** Reads the approvals again, as they stand now. */
  refresh: () => Promise<void>;
}) => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const [reason, setReason] = useState("");
  const reasonId = useId();
  const engine = request.app.name;
  // What it ends, as core counted it: retiring, the approvals in force
  // still approved; revoking, retired ones too. Named in the decision by
  // their digest, so core ends exactly these or nothing.
  const ends = impact.endings[ending];
  const { approvals } = ends;
  const artifacts = impact.artifacts.length;
  const targets = formatList(
    [...new Set(impact.artifacts.map(({ target }) => target))].map((target) =>
      i18n._(targetNames[target])
    )
  );
  const end = async (): Promise<void> => {
    let done = false;
    // Read again whatever the outcome, keeping why it failed: a failed
    // call may still have landed, or someone may have ended it meanwhile,
    // and the list shows how things stand.
    await changeThenRefresh(async () => {
      done =
        (await run(async (session) => {
          const decision = {
            reviewed: {
              graphHash: impact.graphHash,
              policyGeneration: impact.policyGeneration,
              approvalsDigest: ends.digest,
            },
            reason,
          };
          await (ending === "retire"
            ? session.dependencies.retire(request.id, decision)
            : session.dependencies.revoke(request.id, decision));
          return true;
        })) === true;
    }, refresh);
    if (done) {
      onClose();
    }
  };
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open
    >
      <DialogContent closeLabel={t`Close`}>
        <header className="flex flex-col gap-1 pr-8">
          <DialogTitle>
            {ending === "retire"
              ? t`Retire the packages for ${engine}?`
              : t`Revoke the packages for ${engine}?`}
          </DialogTitle>
          <DialogDescription>
            <PackagesOf request={request} />
          </DialogDescription>
        </header>
        <div className="flex flex-col gap-2">
          <p>
            <Plural
              one="This ends # approval of these packages."
              other="This ends # approvals of these packages."
              value={approvals}
            />
          </p>
          {ending === "retire" ? (
            <p>
              <Plural
                one={`# build already made (${targets}) keeps working. Nothing new is built with these packages.`}
                other={`# builds already made (${targets}) keep working. Nothing new is built with these packages.`}
                value={artifacts}
                _0="Nothing was built with these packages yet, and nothing new will be."
              />
            </p>
          ) : (
            <p>
              <Plural
                one={`# build made with them (${targets}) stops at once, and nothing of these packages runs any more.`}
                other={`# builds made with them (${targets}) stop at once, and nothing of these packages runs any more.`}
                value={artifacts}
                _0="Nothing of these packages runs any more."
              />
            </p>
          )}
          <p className="text-muted-foreground">
            <Trans>
              To use them again, someone who approves packages reviews them
              again.
            </Trans>
          </p>
        </div>
        <Field>
          <FieldLabel htmlFor={reasonId}>
            <Trans>Why</Trans>
          </FieldLabel>
          <Textarea
            id={reasonId}
            onChange={(event) => {
              setReason(event.target.value);
            }}
            required
            value={reason}
          />
        </Field>
        <ErrorText>{failure}</ErrorText>
        <DialogFooter>
          <Button disabled={busy} onClick={onClose} variant="outline">
            <Trans>Cancel</Trans>
          </Button>
          <Button
            disabled={busy || reason.trim() === ""}
            onClick={() => {
              void end();
            }}
            variant={ending === "revoke" ? "destructive" : "default"}
          >
            {ending === "retire" ? t`Retire` : t`Revoke`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** One approval: what it is, who decided, and, for who may, ending it. */
const ApprovalRow = ({
  request,
  decides,
  onAsk,
}: {
  request: DependencyRequest;
  decides: boolean;
  /** Opens the dialog that ends it, with what that touches. */
  onAsk: (asked: Asked) => void;
}) => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const engine = request.app.name;
  const targets = formatList(
    request.targets.map((target) => i18n._(targetNames[target]))
  );
  const ask = async (ending: Ending): Promise<void> => {
    const impact = await run(
      async (session) => await session.dependencies.impact(request.id)
    );
    if (impact !== undefined) {
      onAsk({ request, ending, impact });
    }
  };
  const decidedBy = request.decided?.by.name ?? "";
  const decidedAt = formatDateTime(request.decided?.at ?? request.requestedAt);
  const { ended } = request;
  const endedBy = ended?.by.name ?? "";
  const endedAt = formatDateTime(ended?.at ?? request.requestedAt);
  const endedReason = ended?.reason ?? "";
  return (
    <TableRow>
      <TableCell className="whitespace-normal" variant="card">
        <PackagesOf request={request} />
      </TableCell>
      <TableCell className="whitespace-normal" variant="card">
        {targets}
      </TableCell>
      <TableCell className="whitespace-normal" variant="card">
        <div className="flex flex-col items-start gap-1">
          {request.status === "retired" ? (
            <Badge variant="outline">
              <Trans>Retired</Trans>
            </Badge>
          ) : (
            <Badge variant="secondary">
              <Trans>Approved</Trans>
            </Badge>
          )}
          <span className="text-muted-foreground">
            <Trans>
              Approved by {decidedBy}, {decidedAt}
            </Trans>
          </span>
          {ended === undefined ? null : (
            <span className="text-muted-foreground">
              <Trans>
                Retired by {endedBy}, {endedAt}: {endedReason}
              </Trans>
            </span>
          )}
        </div>
      </TableCell>
      {decides ? (
        <TableCell variant="card">
          <div className="flex flex-col items-end gap-1">
            <div className="flex gap-2">
              {request.status === "approved" ? (
                <Button
                  aria-label={t`Retire the packages for ${engine}`}
                  disabled={busy}
                  onClick={() => {
                    void ask("retire");
                  }}
                  size="xs"
                  variant="outline"
                >
                  <Trans>Retire</Trans>
                </Button>
              ) : null}
              <Button
                aria-label={t`Revoke the packages for ${engine}`}
                disabled={busy}
                onClick={() => {
                  void ask("revoke");
                }}
                size="xs"
                variant="destructive"
              >
                <Trans>Revoke</Trans>
              </Button>
            </div>
            <ErrorText>{failure}</ErrorText>
          </div>
        </TableCell>
      ) : null}
    </TableRow>
  );
};

/** The approvals as a table, each with ending it for who may. */
const ApprovalsTable = ({
  listed,
  onAsk,
}: {
  listed: DependencyApprovals;
  onAsk: (asked: Asked) => void;
}) => {
  const { t } = useLingui();
  return (
    <div className="bg-card overflow-hidden rounded-xl border">
      <Table aria-label={t`Approved packages`}>
        <TableHeader>
          <TableRow>
            <TableHead variant="card">
              <Trans>Packages</Trans>
            </TableHead>
            <TableHead variant="card">
              <Trans>Runs in</Trans>
            </TableHead>
            <TableHead variant="card">
              <Trans>Status</Trans>
            </TableHead>
            {listed.decides ? (
              <TableHead variant="card">
                <span className="sr-only">
                  <Trans>Actions</Trans>
                </span>
              </TableHead>
            ) : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {listed.approvals.map((request) => (
            <ApprovalRow
              decides={listed.decides}
              key={request.id}
              onAsk={onAsk}
              request={request}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
};

/**
 * An engine's approved packages, newest first, with ending each for who
 * may. Read again here once someone ends one, whatever the outcome, so an
 * open dialog keeps why it failed while the list shows how things stand.
 */
export const PackageApprovals = ({
  listed: loaded,
}: {
  listed: DependencyApprovals;
}) => {
  const { run } = useCoreAction();
  const [listed, setListed] = useState(loaded);
  const [asked, setAsked] = useState<Asked>();
  const refresh = async (): Promise<void> => {
    const now = await run(
      async (session) => await session.dependencies.approvals(loaded.app.id)
    );
    if (now !== undefined) {
      setListed(now);
    }
  };
  const dialog =
    asked === undefined ? null : (
      <EndDialog
        ending={asked.ending}
        impact={asked.impact}
        onClose={() => {
          setAsked(undefined);
        }}
        refresh={refresh}
        request={asked.request}
      />
    );
  // The dialog in one place whatever the list shows, so it stays open,
  // with why it failed, when the list empties.
  return (
    <>
      {listed.approvals.length === 0 ? (
        <p className="text-muted-foreground">
          <Trans>No packages are approved for this engine.</Trans>
        </p>
      ) : (
        <ApprovalsTable listed={listed} onAsk={setAsked} />
      )}
      {dialog}
    </>
  );
};
