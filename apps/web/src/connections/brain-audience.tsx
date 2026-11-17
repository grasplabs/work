import type {
  ConnectionBrainAudience,
  ListedConnection,
} from "@grasp-os/shared/connect";
import { failureText } from "@grasp-os/shared/errors";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import { Field, FieldLabel } from "@grasp-os/ui/components/field";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useId, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { useCore } from "../use-core.ts";
import { useChange } from "./use-change.ts";

// For an admin, on a shared connection's card: who may read in the Brain
// what agents read through it (GRA-1831), one team, everyone or nobody,
// and erasing what the Brain kept of it. Core decides who may change it
// and checks every choice (connection-audiences.ts, shared-reads.ts);
// the card only asks. Opening it or widening it is confirmed first, in a
// whole sentence that says what was kept before is shown too; back to
// nobody hides it and keeps it, so it needs none. Erasing is for good.

/** A team of the company, to choose. */
interface Team {
  id: string;
  name: string;
}

/**
 * What the card reads from core: the connection's audience now, whether
 * what the Brain kept of it is being erased, and the company's teams.
 */
interface Loaded {
  audience: ConnectionBrainAudience;
  erasing: boolean;
  teams: Team[];
}

/** What a read from core came to. */
type Read =
  | { state: "loading" }
  | { state: "refused"; message: string }
  | { state: "ready"; data: Loaded };

/**
 * The audience of `connectionId` and the company's teams, or why not.
 * Outside the components, as the React Compiler can't compile `try`.
 */
const readAudience = async (
  core: CoreConnection,
  connectionId: string
): Promise<Read> => {
  try {
    const data = await core.withSession(
      async (session: Session): Promise<Loaded> => {
        const [audiences, teams] = await Promise.all([
          session.connections.brainAudiences(),
          session.organization.teams(),
        ]);
        const chosen = audiences.find(
          (each) => each.connectionId === connectionId
        );
        return {
          audience: chosen?.audience ?? { kind: "nobody" },
          erasing: chosen?.erasing ?? false,
          teams,
        };
      }
    );
    return { state: "ready", data };
  } catch (error) {
    return { state: "refused", message: failureText(error) };
  }
};

/** An audience as the select names it: `nobody`, `everyone`, or a team's ID. */
const valueOf = (audience: ConnectionBrainAudience): string =>
  audience.kind === "team" ? audience.teamId : audience.kind;

/** The audience the select's `value` names. */
const audienceOf = (value: string): ConnectionBrainAudience => {
  if (value === "nobody" || value === "everyone") {
    return { kind: value };
  }
  return { kind: "team", teamId: value };
};

/** Whether `next` lets anyone read who `now` doesn't: confirmed first. */
const widens = (
  now: ConnectionBrainAudience,
  next: ConnectionBrainAudience
): boolean =>
  next.kind !== "nobody" &&
  valueOf(now) !== valueOf(next) &&
  now.kind !== "everyone";

/** Asks before `next` is chosen for `label`: what it shows, and to whom. */
const WidenDialog = ({
  label,
  next,
  teams,
  onConfirm,
  onCancel,
}: {
  label: string;
  next: ConnectionBrainAudience;
  teams: Team[];
  onConfirm: () => void;
  onCancel: () => void;
}) => {
  const { t } = useLingui();
  const team =
    next.kind === "team"
      ? (teams.find(({ id }) => id === next.teamId)?.name ?? "")
      : "";
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onCancel();
        }
      }}
      open
    >
      <DialogContent closeLabel={t`Close`}>
        <DialogHeader>
          <DialogTitle>
            <Trans>Keep what agents read through {label} in the Brain?</Trans>
          </DialogTitle>
          <DialogDescription>
            {next.kind === "everyone" ? (
              <Trans>
                Everyone in the company will be able to find what agents read
                through {label}, including what was kept before. Choose a team
                if not everyone should see it.
              </Trans>
            ) : (
              <Trans>
                Everyone in {team} will be able to find what agents read through{" "}
                {label}, including what was kept before.
              </Trans>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter closeLabel={t`Cancel`} showCloseButton>
          <Button onClick={onConfirm}>
            <Trans>Keep it for them</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** Erasing what the Brain kept of the connection, once confirmed: for good. */
const EraseKept = ({
  connection,
  label,
  onErased,
}: {
  connection: ListedConnection;
  label: string;
  /** The erase was asked for: what the card shows is read again. */
  onErased: () => void;
}) => {
  const { busy, failure, change } = useChange();
  const [confirming, setConfirming] = useState(false);
  const { t } = useLingui();
  return (
    <div className="flex flex-col gap-1">
      <Button
        className="self-start"
        disabled={busy}
        onClick={() => {
          setConfirming(true);
        }}
        size="sm"
        variant="outline"
      >
        <Trans>Erase what the Brain kept</Trans>
      </Button>
      <Dialog onOpenChange={setConfirming} open={confirming}>
        <DialogContent closeLabel={t`Close`}>
          <DialogHeader>
            <DialogTitle>
              <Trans>Erase what the Brain kept from {label}?</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>
                Everything the Brain kept of what agents read through it is
                erased for good, and nobody reads it from now on. This
                can&apos;t be undone. To keep what agents read through it again,
                choose who may read it once the erasure is done.
              </Trans>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter closeLabel={t`Cancel`} showCloseButton>
            <Button
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                void (async () => {
                  await change(async (session) => {
                    await session.connections.eraseBrainReads(connection.id);
                  });
                  onErased();
                })();
              }}
              variant="destructive"
            >
              <Trans>Erase for good</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ErrorText>{failure}</ErrorText>
    </div>
  );
};

/**
 * The audience as core holds it now, read as it opens, and its choices:
 * `onChanged` once a change or an erase was asked for, so it is read
 * again.
 */
const AudienceChoice = ({
  connection,
  label,
  onChanged,
}: {
  connection: ListedConnection;
  label: string;
  onChanged: () => void;
}) => {
  const core = useCore();
  const { t } = useLingui();
  const selectId = useId();
  const { busy, failure, change } = useChange();
  const [read, setRead] = useState<Read>({ state: "loading" });
  const [asked, setAsked] = useState<ConnectionBrainAudience>();
  useEffect(() => {
    let left = false;
    const load = async (): Promise<void> => {
      const answer = await readAudience(core, connection.id);
      if (!left) {
        setRead(answer);
      }
    };
    void load();
    return () => {
      left = true;
    };
  }, [core, connection.id]);
  if (read.state === "loading") {
    return null;
  }
  if (read.state === "refused") {
    return <ErrorText>{read.message}</ErrorText>;
  }
  const { audience, erasing, teams } = read.data;
  const choose = (next: ConnectionBrainAudience): void => {
    setAsked(undefined);
    void (async () => {
      await change(async (session) => {
        await session.connections.setBrainAudience(connection.id, next);
      });
      onChanged();
    })();
  };
  return (
    <div className="flex flex-col gap-2 text-sm">
      <h4 className="font-medium">
        <Trans>The Brain</Trans>
      </h4>
      <Field>
        <FieldLabel htmlFor={selectId}>
          <Trans>Keep what agents read through it for</Trans>
        </FieldLabel>
        <NativeSelect
          disabled={busy || erasing}
          id={selectId}
          onChange={(event) => {
            const next = audienceOf(event.target.value);
            if (widens(audience, next)) {
              setAsked(next);
              return;
            }
            choose(next);
          }}
          value={valueOf(audience)}
        >
          <NativeSelectOption value="nobody">{t`Nobody`}</NativeSelectOption>
          <NativeSelectOption value="everyone">
            {t`Everyone in the company`}
          </NativeSelectOption>
          {teams.map(({ id, name }) => (
            <NativeSelectOption key={id} value={id}>
              {t`Team ${name}`}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      <p className="text-muted-foreground">
        <Trans>
          Who may read it is decided inside Grasp, not by the permissions in{" "}
          {label}: choose a team if not everyone should see it.
        </Trans>
      </p>
      {erasing ? (
        <p className="text-muted-foreground">
          <Trans>
            What the Brain kept from {label} is being erased. You can choose who
            may read it again once that is done.
          </Trans>
        </p>
      ) : null}
      <ErrorText>{failure}</ErrorText>
      {asked === undefined ? null : (
        <WidenDialog
          label={label}
          next={asked}
          onCancel={() => {
            setAsked(undefined);
          }}
          onConfirm={() => {
            choose(asked);
          }}
          teams={teams}
        />
      )}
      {!erasing &&
      (audience.kind !== "nobody" || connection.keepsReads === true) ? (
        <EraseKept connection={connection} label={label} onErased={onChanged} />
      ) : null}
    </div>
  );
};

/** For an admin, on a shared connection's card: its Brain audience, and erasing what was kept. */
export const BrainAudience = ({
  connection,
  label,
}: {
  connection: ListedConnection;
  label: string;
}) => {
  // Each change or erase asked for counts: the choice opens again and
  // reads what core holds then, so it shows only what core says, never a
  // copy of its own (an erase takes the audience away, and an erasure
  // under way allows none).
  const [changes, setChanges] = useState(0);
  return (
    <AudienceChoice
      connection={connection}
      key={changes}
      label={label}
      onChanged={() => {
        setChanges((before) => before + 1);
      }}
    />
  );
};
