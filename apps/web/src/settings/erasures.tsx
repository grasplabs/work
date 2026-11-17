import { failureText } from "@grasp-os/shared/errors";
import type {
  Erasure,
  ErasureArea,
  ErasureCursor,
  ErasurePreview,
  RemovedPeoplePage,
  RemovedPerson,
} from "@grasp-os/shared/members";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";

import { formatDate } from "../format.ts";
import { Alert } from "../grasp/alert/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogContent,
  DialogTitle,
} from "../grasp/dialog/index.ts";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "../grasp/field/index.ts";
import { Form } from "../grasp/form/index.ts";
import { Heading } from "../grasp/heading/index.ts";
import { Input } from "../grasp/input/index.ts";
import {
  Item,
  ItemGroup,
  ItemContent,
  ItemTitle,
  ItemActions,
} from "../grasp/item/index.ts";
import { Progress } from "../grasp/progress/index.ts";
import { SectionCard } from "../grasp/section-card/index.ts";
import { Spinner } from "../grasp/spinner/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp } from "../grasp/tokens/tokens.stylex.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { TitleLine } from "./section.tsx";

// Erasing someone an admin removed (GRA-903, GRA-1195): their email,
// sign-ins and personal content go; their name and ID stay on the
// company's records. The dialog shows who it is as core has them now
// (`members.erasure`), and erases only once the admin types their name
// exactly as shown, which core checks again (`member.erase_name_mismatch`),
// so a mix-up of two people, or a stale list, erases nobody. It then
// follows each area until all are done; core finishes any that failed on
// its own.

/** How often an erasure under way is asked about again, in ms. */
const followEveryMs = 2000;

/** Each area of an erasure, in the page's language, as core names them. */
const areaLabels: Record<string, MessageDescriptor> = {
  identity: msg`Email and sign-ins`,
  channels: msg`Chat accounts, invitations and notifications`,
  connect: msg`Personal connections`,
  workspace: msg`Chats, drafts and dashboard`,
  apps: msg`What they sent through App forms, and usage signals of their collections`,
  brain: msg`Personal Knowledge and memories`,
  runs: msg`Unfinished runs (stopped) and decision confirmations`,
  interview: msg`Onboarding interview`,
  brain_sources: msg`What the Brain keeps that only they may read`,
};

/** How far an area got, in the page's language. */
const stateLabels: Record<string, MessageDescriptor> = {
  pending: msg`In progress`,
  complete: msg`Erased`,
  // Core skips an area it can't reach (the interview, once the address was
  // let in again or the key changed), so it may still hold data.
  skipped: msg`Skipped, may still hold data`,
};

/** How each state stands: erased is done, skipped wants a look. */
const stateTones: Record<string, "success" | "attention" | "neutral"> = {
  pending: "neutral",
  complete: "success",
  skipped: "attention",
};

/** How many of `areas` are done, one way or another. */
const doneOf = (areas: readonly ErasureArea[]): number =>
  areas.filter(({ state }) => state !== "pending").length;

const styles = stylex.create({
  stack: { display: "flex", flexDirection: "column", gap: grasp.space4 },
  areas: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space2,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  area: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: grasp.space2,
  },
  columns: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(12rem, 1fr))",
    gap: grasp.space4,
  },
  column: { display: "flex", flexDirection: "column", gap: grasp.space1 },
  bullets: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space1,
    margin: 0,
    paddingInlineStart: grasp.space5,
  },
  more: { display: "flex", justifyContent: "center", padding: grasp.space3 },
  empty: { padding: grasp.space5 },
});

/** An area's name, in the page's language; as core names it when it is new to the page. */
const useAreaName = () => {
  const { i18n } = useLingui();
  return (area: string): string => {
    const label = areaLabels[area];
    return label === undefined ? area : i18n._(label);
  };
};

/** Each area of an erasure, and how far it got. */
const ErasureAreas = ({ areas }: { areas: readonly ErasureArea[] }) => {
  const { t, i18n } = useLingui();
  const areaName = useAreaName();
  const done = doneOf(areas);
  const total = areas.length;
  return (
    <div {...stylex.props(styles.stack)}>
      <Progress
        label={t`Areas finished`}
        max={total}
        showLabel
        value={done}
        valueText={() => t`${done} of ${total}`}
      />
      <ul {...stylex.props(styles.areas)}>
        {areas.map(({ area, state }) => {
          const stateLabel = stateLabels[state];
          return (
            <li key={area} {...stylex.props(styles.area)}>
              <Text element="span">{areaName(area)}</Text>
              <Badge tone={stateTones[state] ?? "neutral"}>
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
  const { t } = useLingui();
  const areaName = useAreaName();
  const kept = [
    t`Their name, on what they did, so it stays traceable`,
    t`Runs they started, and their place in the roster`,
    t`The audit trail`,
  ];
  return (
    <div {...stylex.props(styles.columns)}>
      <div {...stylex.props(styles.column)}>
        <Heading level={3} size="ui">
          {t`Erased`}
        </Heading>
        <ul {...stylex.props(styles.bullets)}>
          {areas.map((area) => (
            <li key={area}>
              <Text element="span" size="sm" tone="muted">
                {areaName(area)}
              </Text>
            </li>
          ))}
        </ul>
      </div>
      <div {...stylex.props(styles.column)}>
        <Heading level={3} size="ui">
          {t`Kept`}
        </Heading>
        <ul {...stylex.props(styles.bullets)}>
          {kept.map((line) => (
            <li key={line}>
              <Text element="span" size="sm" tone="muted">
                {line}
              </Text>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};

/** A spinner while a preview loads, or why it didn't. */
const Loading = ({ lost }: { lost: string | undefined }) => {
  const { t } = useLingui();
  return lost === undefined ? (
    <Spinner aria-label={t`Loading…`} />
  ) : (
    <Alert tone="danger">{lost}</Alert>
  );
};

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
  const formId = useId();
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
      <DialogContent closeLabel={t`Close`}>
        <DialogTitle>{t`Erase ${name}?`}</DialogTitle>
        <DialogDescription>
          {erasure === null
            ? t`Their personal data goes for good. Their name stays on the company’s records, so what they did stays traceable.`
            : t`Each area is erased on its own. One that fails is tried again until it is done, even after you close this.`}
        </DialogDescription>
        <DialogBody>
          {erasure === null ? (
            <div {...stylex.props(styles.stack)}>
              {preview === undefined ? (
                <Loading lost={lost} />
              ) : (
                <>
                  <Text tone="ink" weight="medium">
                    {preview.email === null
                      ? preview.name
                      : `${preview.name} (${preview.email})`}
                  </Text>
                  <WhatErasingDoes areas={preview.areas} />
                  <Form
                    aria-label={t`Erase ${name}?`}
                    id={formId}
                    onSubmit={(event) => {
                      event.preventDefault();
                      void erase();
                    }}
                  >
                    <Field invalid={failure !== undefined}>
                      <FieldLabel>{t`Type ${name} to confirm`}</FieldLabel>
                      <Input
                        autoComplete="off"
                        onValueChange={setTyped}
                        value={typed}
                      />
                      <FieldDescription>
                        {t`Exactly as it’s written here.`}
                      </FieldDescription>
                      {failure === undefined ? null : (
                        <FieldError match>{failure}</FieldError>
                      )}
                    </Field>
                  </Form>
                </>
              )}
            </div>
          ) : (
            <div {...stylex.props(styles.stack)}>
              <ErasureAreas areas={erasure.areas} />
              <output aria-live="polite">
                <Text element="span" tone="muted">
                  {erasure.completedAt === null
                    ? t`Erasing…`
                    : t`${name} is erased.`}
                </Text>
              </output>
              {(lost ?? failure) === undefined ? null : (
                <Alert tone="attention">{lost ?? failure}</Alert>
              )}
            </div>
          )}
        </DialogBody>
        {erasure === null ? (
          <DialogFooter>
            <DialogAction>{t`Cancel`}</DialogAction>
            <Button
              disabled={busy || !confirmed}
              form={formId}
              type="submit"
              variant="danger"
            >
              {t`Erase`}
            </Button>
          </DialogFooter>
        ) : (
          <DialogFooter>
            <DialogAction>{t`Close`}</DialogAction>
          </DialogFooter>
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
  const { t } = useLingui();
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [email, setEmail] = useState("");
  const [answer, setAnswer] = useState<"released" | "not-theirs">();
  const formId = useId();
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
      <DialogContent closeLabel={t`Close`}>
        <DialogTitle>{t`Let ${name}’s old address in again?`}</DialogTitle>
        <DialogDescription>
          {t`For an address your company gave to someone else. Anyone signing in with it then gets in, ${name} too if your sign-in provider still has it for them.`}
        </DialogDescription>
        <DialogBody>
          <div {...stylex.props(styles.stack)}>
            <Form
              aria-label={t`Let ${name}’s old address in again?`}
              id={formId}
              onSubmit={(event) => {
                event.preventDefault();
                void release();
              }}
            >
              <Field invalid={failure !== undefined}>
                <FieldLabel>{t`The address`}</FieldLabel>
                <Input
                  autoComplete="off"
                  onValueChange={(value) => {
                    setEmail(value);
                    setAnswer(undefined);
                  }}
                  required
                  type="email"
                  value={email}
                />
                <FieldDescription>
                  {t`Grasp keeps no copy of it, so type it in full.`}
                </FieldDescription>
                <FieldError match="valueMissing">
                  {t`Enter the address to let in again.`}
                </FieldError>
                {failure === undefined ? null : (
                  <FieldError match>{failure}</FieldError>
                )}
              </Field>
            </Form>
            {answer === undefined ? null : (
              <output aria-live="polite">
                <Text element="span" tone="muted">
                  {answer === "released"
                    ? t`The address can sign in again.`
                    : t`That address wasn’t kept out.`}
                </Text>
              </output>
            )}
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogAction>
            {answer === "released" ? t`Close` : t`Cancel`}
          </DialogAction>
          <Button
            disabled={busy || answer === "released"}
            form={formId}
            type="submit"
            variant="ink"
          >
            {t`Let it in`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** Where `person` stands: removed, being erased, or erased. */
const Standing = ({ person }: { person: RemovedPerson }) => {
  const { t } = useLingui();
  const { erasure } = person;
  if (erasure === null) {
    return <Badge>{t`Removed`}</Badge>;
  }
  if (erasure.completedAt === null) {
    const done = doneOf(erasure.areas);
    const total = erasure.areas.length;
    return <Badge tone="info">{t`Erasing, ${done} of ${total}`}</Badge>;
  }
  return <Badge tone="success">{t`Erased`}</Badge>;
};

/** One person an admin removed, and what may be done about them now. */
const RemovedRow = ({ person }: { person: RemovedPerson }) => {
  const { t } = useLingui();
  const [open, setOpen] = useState<"erase" | "release">();
  const { name, erasure } = person;
  const date = formatDate(person.removedAt);
  const { email } = person;
  const who = email === null ? name : `${name} (${email})`;
  const close = (next: boolean): void => {
    if (!next) {
      setOpen(undefined);
    }
  };
  return (
    <>
      <Item size="sm">
        <ItemContent>
          <ItemTitle>
            <TitleLine
              detail={
                email === null
                  ? t`Removed on ${date} · email erased`
                  : t`${email} · removed on ${date}`
              }
            >
              {name}
            </TitleLine>
          </ItemTitle>
        </ItemContent>
        <ItemActions>
          <>
            <Standing person={person} />
            {erasure === null || erasure.completedAt === null ? (
              <Button
                aria-label={
                  erasure === null
                    ? t`Erase ${who}`
                    : t`Follow the erasure of ${who}`
                }
                onClick={() => {
                  setOpen("erase");
                }}
                size="sm"
                variant={erasure === null ? "quiet" : "ghost"}
              >
                {erasure === null ? t`Erase…` : t`Follow`}
              </Button>
            ) : null}
            {erasure?.completedAt !== null && person.addressKeptOut ? (
              <Button
                aria-label={t`Release address of ${who}, letting it sign in again`}
                onClick={() => {
                  setOpen("release");
                }}
                size="sm"
                variant="ghost"
              >
                {t`Release address…`}
              </Button>
            ) : null}
          </>
        </ItemActions>
      </Item>
      {open === "erase" ? (
        <EraseDialog onOpenChange={close} person={person} />
      ) : null}
      {open === "release" ? (
        <ReleaseAddressDialog onOpenChange={close} person={person} />
      ) : null}
    </>
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
  // Older pages count only on top of the first page they were read after:
  // fresh loader data (after an erasure, say) starts the list over from its
  // own first page, instead of keeping older rows as they were.
  const [paged, setPaged] = useState<{
    after: RemovedPeoplePage;
    more: boolean;
    older: RemovedPerson[];
  }>();
  const current = paged?.after === page ? paged : undefined;
  const people = [...page.people, ...(current?.older ?? [])];
  const more = current?.more ?? page.more;
  const showMore = async (): Promise<void> => {
    const next = await run(
      async (session) => await session.members.removed(cursorAfter(people))
    );
    if (next !== undefined) {
      setPaged({
        after: page,
        more: next.more,
        older: [...(current?.older ?? []), ...next.people],
      });
    }
  };
  return (
    <SectionCard
      description={t`They can’t sign in. Erasing takes their personal data for good.`}
      flush
      title={t`Removed people`}
    >
      {people.length === 0 ? (
        <div {...stylex.props(styles.empty)}>
          <Text tone="muted">{t`Nobody was removed.`}</Text>
        </div>
      ) : (
        <ItemGroup aria-label={t`Removed people`} separated>
          {people.map((person) => (
            <RemovedRow key={person.userId} person={person} />
          ))}
        </ItemGroup>
      )}
      {more ? (
        <div {...stylex.props(styles.more)}>
          <Button
            disabled={busy}
            onClick={() => {
              void showMore();
            }}
            size="sm"
            variant="ghost"
          >
            {t`Show older`}
          </Button>
          {failure === undefined ? null : (
            <Alert tone="danger">{failure}</Alert>
          )}
        </div>
      ) : null}
    </SectionCard>
  );
};
