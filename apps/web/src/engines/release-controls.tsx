import type { AppRelease } from "@grasp-os/shared/apps";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import { DropdownMenuItem } from "@grasp-os/ui/components/dropdown-menu";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { Trans, useLingui } from "@lingui/react/macro";
import { useId, useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { useCoreAction } from "../use-core-action.ts";

// What the organization's own admins do to a domain's sealed releases, on
// its Versions tab (`apps.versions.releases`, `revoke`, `placeHold`,
// `releaseHold`, which core refuses anyone else, Grasp staff included):
// revoke one, so it runs no more, calls already running included; or
// place a legal hold that keeps it, however old, until it is lifted. Each
// is for good or close to it and lands in the audit log with why, so each
// asks first and asks why. Core answers each with the release as it then
// is, which the tab shows without reading every version again.

/** What an admin asked to do to a release, before they confirm. */
export type ReleaseAction =
  | { kind: "revoke"; version: number }
  | { kind: "hold"; version: number }
  | { kind: "lift"; version: number; hold: string };

/** Whether a release was revoked, and its legal holds. */
export const ReleaseBadges = ({ release }: { release: AppRelease }) => (
  <>
    {release.revokedAt === null ? null : (
      <Badge>
        <Trans>Revoked</Trans>
      </Badge>
    )}
    {release.holds.map(({ hold }) => (
      <Badge key={hold} variant="attention">
        <Trans>Legal hold: {hold}</Trans>
      </Badge>
    ))}
  </>
);

/** A release's actions in its version's menu, for an admin. */
export const ReleaseMenuItems = ({
  release,
  onAsk,
}: {
  release: AppRelease;
  onAsk: (action: ReleaseAction) => void;
}) => {
  const { version } = release;
  return (
    <>
      {release.revokedAt === null ? (
        <DropdownMenuItem
          onClick={() => {
            onAsk({ kind: "revoke", version });
          }}
        >
          <Trans>Revoke this version</Trans>
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem
        onClick={() => {
          onAsk({ kind: "hold", version });
        }}
      >
        <Trans>Place a legal hold</Trans>
      </DropdownMenuItem>
      {release.holds.map(({ hold }) => (
        <DropdownMenuItem
          key={hold}
          onClick={() => {
            onAsk({ kind: "lift", version, hold });
          }}
        >
          <Trans>Lift the legal hold {hold}</Trans>
        </DropdownMenuItem>
      ))}
    </>
  );
};

/** What the dialog says of `action`: its title and what it does. */
const ActionText = ({ action }: { action: ReleaseAction }) => {
  const { version } = action;
  if (action.kind === "revoke") {
    return (
      <>
        <DialogTitle>
          <Trans>Revoke version {version}?</Trans>
        </DialogTitle>
        <DialogDescription>
          <Trans>
            It stops running at once, calls already running included, and can
            never run again. It is kept, and its revocation is recorded with
            your reason.
          </Trans>
        </DialogDescription>
      </>
    );
  }
  if (action.kind === "hold") {
    return (
      <>
        <DialogTitle>
          <Trans>Place a legal hold on version {version}?</Trans>
        </DialogTitle>
        <DialogDescription>
          <Trans>
            The version is kept, however old, until an admin lifts the hold. The
            hold is recorded with your reason.
          </Trans>
        </DialogDescription>
      </>
    );
  }
  const { hold } = action;
  return (
    <>
      <DialogTitle>
        <Trans>
          Lift the legal hold {hold} from version {version}?
        </Trans>
      </DialogTitle>
      <DialogDescription>
        <Trans>
          The version is kept only as long as the retention rules and its other
          holds keep it. Lifting the hold is recorded.
        </Trans>
      </DialogDescription>
    </>
  );
};

/** The confirm button of `action`. */
const ActionLabel = ({ action }: { action: ReleaseAction }) => {
  if (action.kind === "revoke") {
    return <Trans>Revoke</Trans>;
  }
  if (action.kind === "hold") {
    return <Trans>Place hold</Trans>;
  }
  return <Trans>Lift hold</Trans>;
};

/**
 * The confirmation of `action`: why, and for a hold its name, then core's
 * answer, the release as it now is, to `onChanged`.
 */
export const ReleaseDialog = ({
  app,
  action,
  onClose,
  onChanged,
}: {
  app: string;
  action: ReleaseAction;
  onClose: () => void;
  onChanged: (release: AppRelease) => void;
}) => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const [reason, setReason] = useState("");
  const [hold, setHold] = useState("");
  const reasonId = useId();
  const holdId = useId();
  const asksReason = action.kind !== "lift";
  const ready =
    action.kind === "lift" ||
    (reason.trim() !== "" && (action.kind === "revoke" || hold.trim() !== ""));
  const confirm = async (): Promise<void> => {
    const { version } = action;
    const changed = await run(async (session) => {
      if (action.kind === "revoke") {
        return await session.apps.versions.revoke(app, version, { reason });
      }
      if (action.kind === "hold") {
        return await session.apps.versions.placeHold(app, version, {
          hold: hold.trim(),
          reason,
        });
      }
      return await session.apps.versions.releaseHold(app, version, action.hold);
    });
    if (changed !== undefined) {
      onChanged(changed);
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
          <ActionText action={action} />
        </header>
        {action.kind === "hold" ? (
          <Field>
            <FieldLabel htmlFor={holdId}>
              <Trans>Name of the hold, such as a case reference</Trans>
            </FieldLabel>
            <Input
              id={holdId}
              maxLength={256}
              onChange={(event) => {
                setHold(event.target.value);
              }}
              required
              value={hold}
            />
          </Field>
        ) : null}
        {asksReason ? (
          <Field>
            <FieldLabel htmlFor={reasonId}>
              <Trans>Why</Trans>
            </FieldLabel>
            <Textarea
              id={reasonId}
              maxLength={500}
              onChange={(event) => {
                setReason(event.target.value);
              }}
              required
              value={reason}
            />
          </Field>
        ) : null}
        <ErrorText>{failure}</ErrorText>
        <DialogFooter>
          <Button disabled={busy} onClick={onClose} variant="outline">
            <Trans>Cancel</Trans>
          </Button>
          <Button
            disabled={busy || !ready}
            onClick={() => {
              void confirm();
            }}
            variant={action.kind === "revoke" ? "destructive" : "default"}
          >
            <ActionLabel action={action} />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
