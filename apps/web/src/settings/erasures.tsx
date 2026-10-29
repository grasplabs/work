import { failureText } from "@grasp-os/shared/errors";
import type {
  Erasure,
  ErasureArea,
  ErasureCursor,
  ErasurePreview,
  RemovedPeoplePage,
  RemovedPerson,
} from "@grasp-os/shared/members";
import { Avatar, AvatarFallback } from "@grasp-os/ui/components/avatar";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@grasp-os/ui/components/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import { Progress, ProgressLabel } from "@grasp-os/ui/components/progress";
import { Spinner } from "@grasp-os/ui/components/spinner";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { formatDate } from "../format.ts";
import { initials } from "../frame/person-menu.tsx";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { SettingsSection } from "./settings-parts.tsx";

// Erasing someone an admin removed (GRA-903, GRA-1195): their email,
// sign-ins and personal content go; their name and ID stay on the
// company's records. The dialog shows who it is as core has them now
// (`members.erasure`), and erases only once the admin types their name
// exactly as shown, which core checks again (`member.erase_name_mismatch`),
// so a mix-up of two people, or a stale list, erases nobody. It then
// follows each area until all are done; core finishes any that failed on
// its own. Grasp's staff see where erasures stand on a page of their own
// (`/settings/erasures`), and change nothing.

/** How often an erasure under way is asked about again, in ms. */
const followEveryMs = 2000;

/** Each area of an erasure, in the page's language, as core names them. */
const areaLabels: Record<string, MessageDescriptor> = {
  identity: msg`Email and sign-ins`,
  channels: msg`Chat accounts, invitations and notifications`,
  connect: msg`Personal connections`,
  workspace: msg`Chats, drafts and dashboard`,
  apps: msg`App preferences and form answers`,
  brain: msg`Personal Knowledge and memories`,
  runs: msg`Runs still going, and their spending limit`,
  interview: msg`Onboarding interview`,
};

/** How far an area got, in the page's language. */
const stateLabels: Record<string, MessageDescriptor> = {
  pending: msg`In progress`,
  complete: msg`Erased`,
  skipped: msg`Nothing to erase`,
};

/** How many of `areas` are done, one way or another. */
const doneOf = (areas: readonly ErasureArea[]): number =>
  areas.filter(({ state }) => state !== "pending").length;

/** Each area of an erasure, and how far it got. */
export const ErasureAreas = ({ areas }: { areas: readonly ErasureArea[] }) => {
  const { i18n } = useLingui();
  const done = doneOf(areas);
  return (
    <div className="flex flex-col gap-3">
      <Progress max={areas.length} value={done}>
        <ProgressLabel>
          <Trans>Areas erased</Trans>
        </ProgressLabel>
        <span className="text-muted-foreground ml-auto text-sm tabular-nums">
          <Trans>
            {done} of {areas.length}
          </Trans>
        </span>
      </Progress>
      <ul className="flex flex-col gap-1">
        {areas.map(({ area, state }) => {
          const label = areaLabels[area];
          const stateLabel = stateLabels[state];
          return (
            <li className="flex items-center justify-between gap-2" key={area}>
              <span>{label === undefined ? area : i18n._(label)}</span>
              <Badge variant={state === "pending" ? "outline" : "secondary"}>
                {state === "pending" ? <Spinner /> : null}
                {stateLabel === undefined ? state : i18n._(stateLabel)}
              </Badge>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

/**
 * What erasing someone takes, as core says its erasure runs (`areas`), so
 * the dialog promises nothing it won't do; and what it keeps.
 */
const WhatErasingDoes = ({ areas }: { areas: readonly string[] }) => {
  const { i18n } = useLingui();
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="flex flex-col gap-1">
        <h3 className="font-medium">
          <Trans>Erased</Trans>
        </h3>
        <ul className="text-muted-foreground flex list-disc flex-col gap-0.5 pl-5">
          {areas.map((area) => {
            const label = areaLabels[area];
            return (
              <li key={area}>{label === undefined ? area : i18n._(label)}</li>
            );
          })}
        </ul>
      </div>
      <div className="flex flex-col gap-1">
        <h3 className="font-medium">
          <Trans>Kept</Trans>
        </h3>
        <ul className="text-muted-foreground flex list-disc flex-col gap-0.5 pl-5">
          <li>
            <Trans>Their name, on what they did, so it stays traceable</Trans>
          </li>
          <li>
            <Trans>Runs they started, and their place in the roster</Trans>
          </li>
          <li>
            <Trans>The audit trail</Trans>
          </li>
        </ul>
      </div>
    </div>
  );
};

/** A spinner while a preview loads, or why it didn't. */
const Loading = ({ failure }: { failure: string | undefined }) =>
  failure === undefined ? <Spinner /> : <ErrorText>{failure}</ErrorText>;

/**
 * Erasing `person`: who they are now, and their name typed to confirm;
 * then each area as it goes, until all are done.
 */
const EraseDialog = ({
  person,
  onOpenChange,
}: {
  person: RemovedPerson;
  onOpenChange: (open: boolean) => void;
}) => {
  const core = useCore();
  const router = useRouter();
  const { t } = useLingui();
  const { busy, run } = useCoreAction();
  const [failure, setFailure] = useState<string>();
  const [preview, setPreview] = useState<ErasurePreview>();
  const [erasure, setErasure] = useState<Erasure | null>(person.erasure);
  const [typed, setTyped] = useState("");
  const [lost, setLost] = useState<string>();
  const nameId = useId();
  const { userId } = person;

  // Who they are as core has them now, not as the list showed them.
  useEffect(() => {
    let current = true;
    const load = async (): Promise<void> => {
      try {
        const fresh = await core.withSession(
          async (session) => await session.members.erasure(userId)
        );
        if (current) {
          setPreview(fresh);
          setErasure(fresh.erasure);
        }
      } catch (error) {
        if (current) {
          setLost(failureText(error));
        }
      }
    };
    void load();
    return () => {
      current = false;
    };
  }, [core, userId]);

  // While it runs, each area as it goes.
  const following = erasure !== null && erasure.completedAt === null;
  useEffect(() => {
    const follow = async (): Promise<void> => {
      try {
        const fresh = await core.withSession(
          async (session) => await session.members.erasure(userId)
        );
        setLost(undefined);
        setErasure(fresh.erasure);
      } catch {
        setLost(
          t`Grasp can’t say how far it got just now. It goes on all the same.`
        );
      }
    };
    const timer = following
      ? setInterval(() => {
          void follow();
        }, followEveryMs)
      : undefined;
    return () => {
      clearInterval(timer);
    };
  }, [core, following, t, userId]);

  const erase = async (): Promise<void> => {
    let refused: string | undefined;
    const started = await run(
      async (session) => await session.members.erase(userId, typed),
      (reason) => {
        refused = reason;
      }
    );
    if (started !== undefined) {
      setFailure(undefined);
      setErasure(started);
      return;
    }
    // The call failed, perhaps after core saved the request (the answer
    // lost, a later step failing): core goes on with a saved one, so it is
    // followed rather than shown as failed.
    try {
      const fresh = await core.withSession(
        async (session) => await session.members.erasure(userId)
      );
      if (fresh.erasure !== null) {
        setFailure(undefined);
        setErasure(fresh.erasure);
        return;
      }
    } catch {
      // Whether it started can't be told: the refusal says what is known.
    }
    setFailure(refused);
  };
  const name = preview?.name ?? person.name;
  const confirmed = preview !== undefined && typed === preview.name;
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          void router.invalidate();
        }
        onOpenChange(open);
      }}
      open
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            <Trans>Erase {name}?</Trans>
          </DialogTitle>
          <DialogDescription>
            {erasure === null ? (
              <Trans>
                Their personal data goes for good. Their name stays on the
                company’s records, so what they did stays traceable.
              </Trans>
            ) : (
              <Trans>
                Each area is erased on its own. One that fails is tried again
                until it is done, even after you close this.
              </Trans>
            )}
          </DialogDescription>
        </DialogHeader>
        {erasure === null ? (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void erase();
            }}
          >
            {preview === undefined ? (
              <Loading failure={lost} />
            ) : (
              <>
                <p>
                  <span className="font-medium">{preview.name}</span>
                  {preview.email === null ? null : (
                    <span className="text-muted-foreground">
                      {" "}
                      ({preview.email})
                    </span>
                  )}
                </p>
                <WhatErasingDoes areas={preview.areas} />
                <Field data-invalid={failure === undefined ? undefined : true}>
                  <FieldLabel htmlFor={nameId}>
                    <Trans>Type {name} to confirm</Trans>
                  </FieldLabel>
                  <Input
                    aria-invalid={failure === undefined ? undefined : true}
                    autoComplete="off"
                    id={nameId}
                    onChange={(event) => {
                      setTyped(event.target.value);
                    }}
                    value={typed}
                  />
                  <FieldDescription>
                    <Trans>Exactly as it’s written here.</Trans>
                  </FieldDescription>
                  {failure === undefined ? null : (
                    <FieldError>{failure}</FieldError>
                  )}
                </Field>
              </>
            )}
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" />}>
                <Trans>Cancel</Trans>
              </DialogClose>
              <Button
                disabled={busy || !confirmed}
                type="submit"
                variant="destructive"
              >
                <Trans>Erase</Trans>
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <>
            <ErasureAreas areas={erasure.areas} />
            <output aria-live="polite" className="text-muted-foreground">
              {erasure.completedAt === null ? (
                <Trans>Erasing…</Trans>
              ) : (
                <Trans>{name} is erased.</Trans>
              )}
            </output>
            <ErrorText>{lost ?? failure}</ErrorText>
            <DialogFooter showCloseButton />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};

/**
 * Letting the address that was an erased person's in again: the company
 * gave it to someone else. The admin types it, since Grasp keeps no copy.
 */
const ReleaseAddressDialog = ({
  person,
  onOpenChange,
}: {
  person: RemovedPerson;
  onOpenChange: (open: boolean) => void;
}) => {
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [email, setEmail] = useState("");
  const [answer, setAnswer] = useState<"released" | "not-theirs">();
  const emailId = useId();
  const { name } = person;
  const release = async (): Promise<void> => {
    const result = await run(
      async (session) => await session.members.releaseAddress(email)
    );
    if (result !== undefined) {
      setAnswer(result.released ? "released" : "not-theirs");
      await router.invalidate({ sync: true });
    }
  };
  return (
    <Dialog onOpenChange={onOpenChange} open>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void release();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              <Trans>Let {name}’s old address in again?</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>
                For an address your company gave to someone else. Anyone signing
                in with it then gets in, {name} too if your sign-in provider
                still has it for them.
              </Trans>
            </DialogDescription>
          </DialogHeader>
          <Field data-invalid={failure === undefined ? undefined : true}>
            <FieldLabel htmlFor={emailId}>
              <Trans>The address</Trans>
            </FieldLabel>
            <Input
              aria-invalid={failure === undefined ? undefined : true}
              autoComplete="off"
              id={emailId}
              onChange={(event) => {
                setEmail(event.target.value);
                setAnswer(undefined);
              }}
              type="email"
              value={email}
            />
            <FieldDescription>
              <Trans>Grasp keeps no copy of it, so type it in full.</Trans>
            </FieldDescription>
            {failure === undefined ? null : <FieldError>{failure}</FieldError>}
          </Field>
          {answer === undefined ? null : (
            <output aria-live="polite" className="text-muted-foreground">
              {answer === "released" ? (
                <Trans>The address can sign in again.</Trans>
              ) : (
                <Trans>That address wasn’t kept out.</Trans>
              )}
            </output>
          )}
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              {answer === "released" ? (
                <Trans>Close</Trans>
              ) : (
                <Trans>Cancel</Trans>
              )}
            </DialogClose>
            <Button
              disabled={busy || email.trim() === "" || answer === "released"}
              type="submit"
            >
              <Trans>Let it in</Trans>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/** Where `person` stands: removed, being erased, or erased. */
const Standing = ({ person }: { person: RemovedPerson }) => {
  const { erasure } = person;
  if (erasure === null) {
    return (
      <Badge variant="outline">
        <Trans>Removed</Trans>
      </Badge>
    );
  }
  if (erasure.completedAt === null) {
    const done = doneOf(erasure.areas);
    const total = erasure.areas.length;
    return (
      <Badge variant="outline">
        <Spinner />
        <Trans>
          Erasing, {done} of {total}
        </Trans>
      </Badge>
    );
  }
  return (
    <Badge variant="secondary">
      <Trans>Erased</Trans>
    </Badge>
  );
};

/** One person an admin removed, and what may be done about them now. */
const RemovedRow = ({ person }: { person: RemovedPerson }) => {
  const { t } = useLingui();
  const [open, setOpen] = useState<"erase" | "release">();
  const { name, erasure } = person;
  const date = formatDate(person.removedAt);
  const who =
    person.email === null ? person.name : `${person.name} (${person.email})`;
  return (
    <div className="flex items-center gap-3 border-t px-5 py-3">
      <Avatar className="size-8">
        <AvatarFallback>{initials(name)}</AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{name}</span>
        <span className="text-muted-foreground truncate">
          {person.email === null ? (
            <Trans>Removed on {date} · email erased</Trans>
          ) : (
            <Trans>
              {person.email} · removed on {date}
            </Trans>
          )}
        </span>
      </div>
      <Standing person={person} />
      {erasure === null || erasure.completedAt === null ? (
        <Button
          aria-label={
            erasure === null ? t`Erase ${who}` : t`Follow the erasure of ${who}`
          }
          onClick={() => {
            setOpen("erase");
          }}
          size="sm"
          variant={erasure === null ? "outline" : "ghost"}
        >
          {erasure === null ? <Trans>Erase…</Trans> : <Trans>Follow</Trans>}
        </Button>
      ) : null}
      {erasure?.completedAt !== null && person.addressKeptOut ? (
        <Button
          aria-label={t`Let the old address of ${who} in again`}
          onClick={() => {
            setOpen("release");
          }}
          size="sm"
          variant="ghost"
        >
          <Trans>Release address…</Trans>
        </Button>
      ) : null}
      {open === "erase" ? (
        <EraseDialog
          onOpenChange={(next) => {
            if (!next) {
              setOpen(undefined);
            }
          }}
          person={person}
        />
      ) : null}
      {open === "release" ? (
        <ReleaseAddressDialog
          onOpenChange={(next) => {
            if (!next) {
              setOpen(undefined);
            }
          }}
          person={person}
        />
      ) : null}
    </div>
  );
};

/** Where the page after `people` goes on from: its last person. */
const cursorAfter = (
  people: readonly RemovedPerson[]
): ErasureCursor | undefined => {
  const last = people.at(-1);
  return last === undefined
    ? undefined
    : { at: last.removedAt, userId: last.userId };
};

/**
 * The people admins removed: whom an admin may erase, and whom they did.
 * The latest page first; older ones on request.
 */
export const RemovedPeople = ({ page }: { page: RemovedPeoplePage }) => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const [older, setOlder] = useState<RemovedPerson[]>([]);
  const [more, setMore] = useState(page.more);
  const people = [...page.people, ...older];
  const showMore = async (): Promise<void> => {
    const next = await run(
      async (session) => await session.members.removed(cursorAfter(people))
    );
    if (next !== undefined) {
      setOlder([...older, ...next.people]);
      setMore(next.more);
    }
  };
  return (
    <SettingsSection
      description={t`People you removed can’t sign in. Erasing someone also takes their personal data, for good, keeping their name on what they did.`}
      title={t`Removed people`}
    >
      {people.length === 0 ? (
        <p className="text-muted-foreground border-t px-5 py-6 text-center">
          <Trans>Nobody was removed.</Trans>
        </p>
      ) : null}
      {people.map((person) => (
        <RemovedRow key={person.userId} person={person} />
      ))}
      {more ? (
        <div className="flex flex-col items-center gap-2 border-t px-5 py-3">
          <Button
            disabled={busy}
            onClick={() => {
              void showMore();
            }}
            size="sm"
            variant="ghost"
          >
            <Trans>Show older</Trans>
          </Button>
          <ErrorText>{failure}</ErrorText>
        </div>
      ) : null}
    </SettingsSection>
  );
};
