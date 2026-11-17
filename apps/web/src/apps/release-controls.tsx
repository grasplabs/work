import type { AppRelease } from "@grasp-os/shared/apps";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";

import { Alert } from "../grasp/alert/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../grasp/dialog/index.ts";
import { DropdownMenuItem } from "../grasp/dropdown-menu/index.ts";
import { Field, FieldLabel } from "../grasp/field/index.ts";
import { Input } from "../grasp/input/index.ts";
import { Textarea } from "../grasp/textarea/index.ts";
import { useCoreAction } from "../use-core-action.ts";

// What the organization's own admins do to an App's sealed releases, on
// its History (`apps.versions.releases`, `revoke`, `placeHold`,
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
export const ReleaseBadges = ({ release }: { release: AppRelease }) => {
  const { t } = useLingui();
  return (
    <>
      {release.revokedAt === null ? null : <Badge>{t`Revoked`}</Badge>}
      {release.holds.map(({ hold }) => (
        <Badge key={hold} tone="attention">
          {t`Legal hold: ${hold}`}
        </Badge>
      ))}
    </>
  );
};

/** A release's actions in its version's menu, for an admin. */
export const ReleaseMenuItems = ({
  release,
  onAsk,
}: {
  release: AppRelease;
  onAsk: (action: ReleaseAction) => void;
}) => {
  const { t } = useLingui();
  const { version } = release;
  return (
    <>
      {release.revokedAt === null ? (
        <DropdownMenuItem
          onClick={() => {
            onAsk({ kind: "revoke", version });
          }}
        >
          {t`Revoke this version`}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem
        onClick={() => {
          onAsk({ kind: "hold", version });
        }}
      >
        {t`Place a legal hold`}
      </DropdownMenuItem>
      {release.holds.map(({ hold }) => (
        <DropdownMenuItem
          key={hold}
          onClick={() => {
            onAsk({ kind: "lift", version, hold });
          }}
        >
          {t`Lift the legal hold ${hold}`}
        </DropdownMenuItem>
      ))}
    </>
  );
};

/**
 * What the dialog says of `action`: its title, naming the version by its
 * `label` (as "this version" while it has none), and what it does.
 */
const ActionText = ({
  action,
  label,
}: {
  action: ReleaseAction;
  label: string | null;
}) => {
  if (action.kind === "revoke") {
    return (
      <>
        <DialogTitle>
          {label === null ? (
            <Trans>Revoke this version?</Trans>
          ) : (
            <Trans>Revoke version {label}?</Trans>
          )}
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
          {label === null ? (
            <Trans>Place a legal hold on this version?</Trans>
          ) : (
            <Trans>Place a legal hold on version {label}?</Trans>
          )}
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
        {label === null ? (
          <Trans>Lift the legal hold {hold} from this version?</Trans>
        ) : (
          <Trans>
            Lift the legal hold {hold} from version {label}?
          </Trans>
        )}
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

/** The confirm button's words for `action`. */
const useActionLabel = () => {
  const { t } = useLingui();
  return (action: ReleaseAction): string => {
    if (action.kind === "revoke") {
      return t`Revoke`;
    }
    return action.kind === "hold" ? t`Place hold` : t`Lift hold`;
  };
};

/**
 * The confirmation of `action`: why, and for a hold its name, then core's
 * answer, the release as it now is, to `onChanged`.
 */
export const ReleaseDialog = ({
  app,
  action,
  label,
  onClose,
  onChanged,
}: {
  app: string;
  action: ReleaseAction;
  /** What people call the version (`AppVersion.label`), if it has a label. */
  label: string | null;
  onClose: () => void;
  onChanged: (release: AppRelease) => void;
}) => {
  const { t } = useLingui();
  const labelOf = useActionLabel();
  const { busy, failure, run } = useCoreAction();
  const [reason, setReason] = useState("");
  const [hold, setHold] = useState("");
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
    if (changed === undefined) {
      // The dialog stays, and says why below.
      throw new Error("The release did not change.");
    }
    onChanged(changed);
  };
  return (
    <Dialog
      onOpenChange={(open) => {
        // Not while core is answering: its answer closes this dialog, and
        // would close the next one opened meanwhile.
        if (!open && !busy) {
          onClose();
        }
      }}
      open
    >
      <DialogContent closeLabel={t`Close`}>
        <ActionText action={action} label={label} />
        {action.kind === "lift" ? null : (
          <DialogBody>
            {action.kind === "hold" ? (
              <Field>
                <FieldLabel>{t`Name of the hold, such as a case reference`}</FieldLabel>
                <Input
                  maxLength={256}
                  onValueChange={setHold}
                  required
                  value={hold}
                />
              </Field>
            ) : null}
            {asksReason ? (
              <Field>
                <FieldLabel>{t`Why`}</FieldLabel>
                <Textarea
                  maxLength={500}
                  onValueChange={setReason}
                  required
                  value={reason}
                />
              </Field>
            ) : null}
          </DialogBody>
        )}
        {failure === undefined ? null : (
          <Alert title={failure} variant="danger" />
        )}
        <DialogFooter>
          <DialogAction>{t`Cancel`}</DialogAction>
          <DialogAction
            action={confirm}
            disabled={!ready}
            failedLabel={t`Didn't work`}
            variant={action.kind === "revoke" ? "danger" : "ink"}
          >
            {labelOf(action)}
          </DialogAction>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
