import type {
  ConnectionBrainAudience,
  ConnectionBrainAudienceSetting,
  ListedConnection,
} from "@grasp-os/shared/connect";
import { connectionErrors } from "@grasp-os/shared/connect";
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
import { useEffect, useEffectEvent, useId, useState } from "react";

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

/** What the cards read from core once for all of them: every shared connection's audience, and the company's teams. */
interface Audiences {
  settings: ConnectionBrainAudienceSetting[];
  teams: Team[];
}

/** What reading the audiences from core came to. */
export type AudiencesRead =
  | { state: "loading" }
  | { state: "refused"; message: string }
  | {
      state: "ready";
      data: Audiences;
      /** A re-read was refused: the data read before stays, with why. */
      refused?: string;
    };

/**
 * Every shared connection's audience, or why not: one read of core's
 * list. Outside the components, as the React Compiler can't compile
 * `try`.
 */
const readSettings = async (
  core: CoreConnection
): Promise<ConnectionBrainAudienceSetting[] | { refused: string }> => {
  try {
    return await core.withSession(
      async (session: Session) => await session.connections.brainAudiences()
    );
  } catch (error) {
    return { refused: failureText(error) };
  }
};

/** Every shared connection's audience and the company's teams, or why not. */
const readAudiences = async (core: CoreConnection): Promise<AudiencesRead> => {
  try {
    const data = await core.withSession(
      async (session: Session): Promise<Audiences> => {
        const [settings, teams] = await Promise.all([
          session.connections.brainAudiences(),
          session.organization.teams(),
        ]);
        return { settings, teams };
      }
    );
    return { state: "ready", data };
  } catch (error) {
    return { state: "refused", message: failureText(error) };
  }
};

/**
 * The shared connections' audiences and the company's teams, read once
 * for every card of a page when `wanted` (an admin who chooses on at
 * least one), and `onChanged`, which reads the audiences again, once,
 * after a change or an erase was asked for: the cards show only what core
 * says, never a copy of their own. Read again too when the window comes
 * back to the page, as other lists are (chat/build-progress.tsx): so an
 * erasure that ended, or another admin's choice, shows without a reload.
 * A refused re-read keeps what was read before and says why beside it;
 * after any refusal the next read is a whole one, teams too.
 */
export const useBrainAudiences = (
  wanted: boolean
): { read: AudiencesRead; onChanged: () => void } => {
  const core = useCore();
  const [read, setRead] = useState<AudiencesRead>({ state: "loading" });
  useEffect(() => {
    let left = false;
    const load = async (): Promise<void> => {
      const answer = await readAudiences(core);
      if (!left) {
        setRead(answer);
      }
    };
    if (wanted) {
      void load();
    }
    return () => {
      left = true;
    };
  }, [core, wanted]);
  const whole = read.state !== "ready" || read.refused !== undefined;
  const onChanged = (): void => {
    void (async () => {
      if (whole) {
        const answer = await readAudiences(core);
        setRead((before) =>
          answer.state === "refused" && before.state === "ready"
            ? { ...before, refused: answer.message }
            : answer
        );
        return;
      }
      const settings = await readSettings(core);
      setRead((before) => {
        if (before.state !== "ready") {
          return before;
        }
        if ("refused" in settings) {
          return { ...before, refused: settings.refused };
        }
        return { state: "ready", data: { ...before.data, settings } };
      });
    })();
  };
  const back = useEffectEvent(onChanged);
  useEffect(() => {
    const returned = (): void => {
      if (wanted) {
        back();
      }
    };
    window.addEventListener("focus", returned);
    return () => {
      window.removeEventListener("focus", returned);
    };
  }, [wanted]);
  return { read, onChanged };
};

/**
 * Chooses `next` for `connectionId` from `from`, the audience the admin
 * was looking at: `changed` when core refused it as another was held
 * meanwhile (nothing changed). Any other refusal is thrown. Outside the
 * components, as the React Compiler can't compile `try`.
 */
const chosenFrom = async (
  session: Session,
  connectionId: string,
  next: ConnectionBrainAudience,
  from: ConnectionBrainAudience
): Promise<"chosen" | "changed"> => {
  try {
    await session.connections.setBrainAudience(connectionId, next, from);
    return "chosen";
  } catch (error) {
    if (
      connectionErrors.codeOf(error) === "connection.brain_audience_changed"
    ) {
      return "changed";
    }
    throw error;
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
 * For an admin, on a shared connection's card: its Brain audience as
 * core holds it (`audiences`, read once for every card), and erasing what
 * was kept. `onChanged` once a change or an erase was asked for, whether
 * it went through or was refused, so the audiences are read again; its
 * own error stays on the card meanwhile.
 */
export const BrainAudience = ({
  connection,
  label,
  audiences,
  onChanged,
}: {
  connection: ListedConnection;
  label: string;
  audiences: AudiencesRead;
  onChanged: () => void;
}) => {
  const { t } = useLingui();
  const selectId = useId();
  const { busy, failure, change } = useChange();
  // The widening asked about, and the audience it was asked from: what
  // core is told the choice was made from, so another admin's change
  // meanwhile is refused, not overwritten.
  const [asked, setAsked] = useState<{
    next: ConnectionBrainAudience;
    from: ConnectionBrainAudience;
  }>();
  // Refused as the audience changed meanwhile: said until the next choice.
  const [changedMeanwhile, setChangedMeanwhile] = useState(false);
  if (audiences.state === "loading") {
    return null;
  }
  if (audiences.state === "refused") {
    return <ErrorText>{audiences.message}</ErrorText>;
  }
  const { settings, teams } = audiences.data;
  const setting = settings.find(
    ({ connectionId }) => connectionId === connection.id
  );
  const audience: ConnectionBrainAudience = setting?.audience ?? {
    kind: "nobody",
  };
  const erasing = setting?.erasing ?? false;
  const choose = (
    next: ConnectionBrainAudience,
    from: ConnectionBrainAudience
  ): void => {
    setAsked(undefined);
    setChangedMeanwhile(false);
    void (async () => {
      await change(async (session) => {
        const outcome = await chosenFrom(session, connection.id, next, from);
        setChangedMeanwhile(outcome === "changed");
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
              setAsked({ next, from: audience });
              return;
            }
            choose(next, audience);
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
      {changedMeanwhile ? (
        <p className="text-muted-foreground">
          <Trans>
            Who may read what agents read through {label} was changed in the
            meantime. This is who may read it now: choose again if you still
            want to change it.
          </Trans>
        </p>
      ) : null}
      <ErrorText>{failure}</ErrorText>
      <ErrorText>{audiences.refused}</ErrorText>
      {asked === undefined ? null : (
        <WidenDialog
          label={label}
          next={asked.next}
          onCancel={() => {
            setAsked(undefined);
          }}
          onConfirm={() => {
            choose(asked.next, asked.from);
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
