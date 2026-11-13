import { failureText } from "@grasp-os/shared/errors";
import type {
  ListedSkill,
  SkillShare,
  SkillShareRequest,
  SkillsOverview,
} from "@grasp-os/shared/skills";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@grasp-os/ui/components/alert-dialog";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Card, CardContent } from "@grasp-os/ui/components/card";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
} from "@grasp-os/ui/components/item";
import {
  PageHeader,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@grasp-os/ui/components/page-header";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useId, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { useCore } from "../use-core.ts";

// Skills (GRA-1754): the person's own, which they write, edit and delete,
// for their own chats alone; asking to share one with the company, which
// waits for an admin; the company's skills; and, for the organization's
// admins, the shares waiting for them, each with the exact text an
// approval adds, and retiring a company skill. Core holds every rule
// (skill-shares.ts): the page only asks. Texts are shown as text, never
// markup.

type Skills = Session["skills"];

/** What a call to core came to. */
type Read<T> =
  | { state: "loading" }
  | { state: "refused"; message: string }
  | { state: "ready"; data: T };

/**
 * What `call` answers on the person's session, or why not. Outside the
 * components, as the React Compiler can't compile `try`.
 */
const callCore = async <T,>(
  core: CoreConnection,
  call: (skills: Skills) => Promise<T>
): Promise<Read<T>> => {
  try {
    const data = await core.withSession(
      async (session) => await call(session.skills)
    );
    return { state: "ready", data };
  } catch (error) {
    return { state: "refused", message: failureText(error) };
  }
};

/** A new skill's text, for the person to fill in. */
const newSkillText = `---
name: my-skill
description: When to use it, in one sentence.
---

The steps.
`;

/**
 * Where the person's share stands, as its row says: added, whenever an
 * add landed (one on its way when the share was closed included; a later
 * add may replace it since: the last to land is live); otherwise waiting;
 * approved but not added yet; closed before it was added (the person asked
 * again or deleted the skill); or declined.
 */
const ShareStatus = ({ share }: { share: SkillShare }) => {
  if (share.version !== null) {
    return (
      <Badge variant="passed">
        <Trans>Added to the company&apos;s skills.</Trans>
      </Badge>
    );
  }
  if (share.status === "pending") {
    return (
      <Badge variant="attention">
        <Trans>Waiting for an admin</Trans>
      </Badge>
    );
  }
  if (share.status === "declined") {
    return (
      <Badge variant="outline">
        <Trans>Declined</Trans>
      </Badge>
    );
  }
  return share.open ? (
    <Badge variant="attention">
      <Trans>Approved, but not added to the company&apos;s skills yet.</Trans>
    </Badge>
  ) : (
    <Badge variant="outline">
      <Trans>
        Closed before it was added: you asked again or deleted the skill.
      </Trans>
    </Badge>
  );
};

/** Asks before something that can't be undone. */
const Confirmed = ({
  label,
  title,
  description,
  confirm,
  disabled,
  onConfirm,
}: {
  label: string;
  title: string;
  description: string;
  confirm: string;
  disabled: boolean;
  onConfirm: () => void;
}) => (
  <AlertDialog>
    <AlertDialogTrigger
      render={
        <Button disabled={disabled} size="sm" type="button" variant="outline" />
      }
    >
      {label}
    </AlertDialogTrigger>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>
          <Trans>Cancel</Trans>
        </AlertDialogCancel>
        <AlertDialogAction onClick={onConfirm} variant="destructive">
          {confirm}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
);

/** One of the person's own skills, with what they can do with it. */
const OwnSkill = ({
  skill,
  waiting,
  busy,
  onEdit,
  onShare,
  onRemove,
}: {
  skill: ListedSkill;
  waiting: boolean;
  busy: boolean;
  onEdit: () => void;
  onShare: () => void;
  onRemove: () => void;
}) => {
  const { t } = useLingui();
  const { name, version } = skill;
  return (
    <Item size="sm" variant="outline">
      <ItemContent>
        <span className="text-sm font-medium">{name}</span>
        <span className="text-muted-foreground text-sm">
          {skill.description}
        </span>
        <span className="text-muted-foreground text-xs">
          <Trans>Version {version}</Trans>
        </span>
      </ItemContent>
      <ItemActions>
        <Button
          disabled={busy}
          onClick={onEdit}
          size="sm"
          type="button"
          variant="outline"
        >
          <Trans>Edit</Trans>
        </Button>
        <Button
          disabled={busy || waiting}
          onClick={onShare}
          size="sm"
          type="button"
          variant="outline"
        >
          {waiting ? (
            <Trans>Waiting for an admin</Trans>
          ) : (
            <Trans>Share with the company</Trans>
          )}
        </Button>
        <Confirmed
          confirm={t`Delete for good`}
          description={t`${name} and every version of it are deleted for good, with a share of it that waits. You can't use its name again.`}
          disabled={busy}
          label={t`Delete`}
          onConfirm={onRemove}
          title={t`Delete ${name}?`}
        />
      </ItemActions>
    </Item>
  );
};

/** A share waiting for an admin, with the exact text approving it adds. */
const ShareRequest = ({
  request,
  busy,
  onApprove,
  onDecline,
}: {
  request: SkillShareRequest;
  busy: boolean;
  onApprove: () => void;
  onDecline: () => void;
}) => {
  const asker = request.requestedBy.name ?? request.requestedBy.userId;
  const asked = formatDateTime(request.requestedAt);
  const { name } = request;
  return (
    <Card render={<li />} size="sm">
      <CardContent>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{name}</span>
          {request.status === "approved" ? (
            <Badge variant="attention">
              <Trans>Approved, not added yet: approve it again</Trans>
            </Badge>
          ) : null}
        </div>
        {request.replaces === "company" ? (
          <p className="text-sm">
            <Trans>
              Approving it replaces the company&apos;s own skill {name} for
              everyone.
            </Trans>
          </p>
        ) : null}
        {request.replaces === "grasp" ? (
          <p className="text-sm">
            <Trans>
              Approving it replaces Grasp&apos;s own skill {name} for everyone.
            </Trans>
          </p>
        ) : null}
        <p className="text-muted-foreground text-xs">
          <Trans>
            Asked by {asker} on {asked}
          </Trans>
        </p>
        <p className="text-sm whitespace-pre-wrap">{request.text}</p>
        <div className="flex gap-2">
          <Button disabled={busy} onClick={onApprove} size="sm" type="button">
            <Trans>Approve</Trans>
          </Button>
          {/* Every card is an open share: waiting, or approved and not
              added yet. Either is closed by declining it. */}
          <Button
            disabled={busy}
            onClick={onDecline}
            size="sm"
            type="button"
            variant="outline"
          >
            <Trans>Decline</Trans>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};

/** The skills page: the person's own, their shares, the company's, and for admins what waits. */
export const SkillsPage = () => {
  const { t } = useLingui();
  const core = useCore();
  const editorId = useId();
  const ownHeading = useId();
  const sharesHeading = useId();
  const companyHeading = useId();
  const requestsHeading = useId();
  const [overview, setOverview] = useState<Read<SkillsOverview>>({
    state: "loading",
  });
  const [text, setText] = useState(newSkillText);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();

  useEffect(() => {
    let left = false;
    const read = async (): Promise<void> => {
      const answer = await callCore(
        core,
        async (skills) => await skills.overview()
      );
      if (!left) {
        setOverview(answer);
      }
    };
    void read();
    return () => {
      left = true;
    };
  }, [core]);

  /** Runs `call`, then reads the page again; says why when core refuses. */
  const act = (
    call: (skills: Skills) => Promise<unknown>,
    after?: () => void
  ) => {
    setBusy(true);
    setFailed(undefined);
    void (async () => {
      const answer = await callCore(core, call);
      setBusy(false);
      if (answer.state === "refused") {
        setFailed(answer.message);
        return;
      }
      after?.();
      setOverview(
        await callCore(core, async (skills) => await skills.overview())
      );
    })();
  };

  const edit = (name: string) => {
    void (async () => {
      const answer = await callCore(
        core,
        async (skills) => await skills.read("own", name)
      );
      if (answer.state === "ready") {
        setText(answer.data.text);
      } else if (answer.state === "refused") {
        setFailed(answer.message);
      }
    })();
  };

  if (overview.state === "refused") {
    return <ErrorText>{overview.message}</ErrorText>;
  }
  const data = overview.state === "ready" ? overview.data : undefined;
  const waitingNames = new Set(
    (data?.shares ?? [])
      .filter(({ status }) => status === "pending")
      .map(({ name }) => name)
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="pb-chat mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 pt-8 md:px-12">
        <PageHeader>
          <PageHeaderTitle>
            <Trans context="the Brain's skills page">Skills</Trans>
          </PageHeaderTitle>
          <PageHeaderDescription>
            <Trans>
              How things are done here. Your own skills are used in your own
              chats alone. Sharing one with the company waits for an admin, and
              from then on everyone&apos;s agents use it. A skill is guidance:
              it never grants access.
            </Trans>
          </PageHeaderDescription>
        </PageHeader>
        {failed === undefined ? null : <ErrorText>{failed}</ErrorText>}

        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            act(
              async (skills) => await skills.save(text),
              () => {
                setText(newSkillText);
              }
            );
          }}
        >
          <Field>
            <FieldLabel htmlFor={editorId}>
              <Trans>Write a skill</Trans>
            </FieldLabel>
            <Textarea
              id={editorId}
              onChange={(event) => {
                setText(event.target.value);
              }}
              rows={12}
              value={text}
            />
            <FieldDescription>
              <Trans>
                A SKILL.md: a name of lowercase letters, digits and hyphens, and
                a description of when to use it, then the steps. Saving a skill
                of a name you have already makes its next version.
              </Trans>
            </FieldDescription>
          </Field>
          <Button
            className="self-start"
            disabled={busy || text.trim() === ""}
            type="submit"
            variant="highlight"
          >
            <Trans>Save</Trans>
          </Button>
        </form>

        <section aria-labelledby={ownHeading} className="flex flex-col gap-3">
          <h2 className="text-sm font-medium" id={ownHeading}>
            <Trans>Your skills</Trans>
          </h2>
          {data !== undefined && data.own.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              <Trans>You have no skills of your own yet.</Trans>
            </p>
          ) : null}
          <ItemGroup render={<ul />} spacing="tight">
            {data?.own.map((skill) => (
              <li key={skill.name}>
                <OwnSkill
                  busy={busy}
                  onEdit={() => {
                    edit(skill.name);
                  }}
                  onRemove={() => {
                    act(async (skills) => {
                      await skills.remove(skill.name);
                    });
                  }}
                  onShare={() => {
                    act(
                      async (skills) =>
                        await skills.share(skill.name, skill.version)
                    );
                  }}
                  skill={skill}
                  waiting={waitingNames.has(skill.name)}
                />
              </li>
            ))}
          </ItemGroup>
        </section>

        {data !== undefined && data.shares.length > 0 ? (
          <section
            aria-labelledby={sharesHeading}
            className="flex flex-col gap-3"
          >
            <h2 className="text-sm font-medium" id={sharesHeading}>
              <Trans>What you asked to share</Trans>
            </h2>
            <ItemGroup render={<ul />} spacing="tight">
              {data.shares.map((share) => (
                <li key={share.id}>
                  <Item size="sm">
                    <ItemContent>
                      <span className="text-sm">{share.name}</span>
                      <span className="text-muted-foreground text-xs">
                        {formatDateTime(share.requestedAt)}
                      </span>
                    </ItemContent>
                    <ItemActions>
                      <ShareStatus share={share} />
                    </ItemActions>
                  </Item>
                </li>
              ))}
            </ItemGroup>
          </section>
        ) : null}

        {data?.requests === null || data?.requests === undefined ? null : (
          <section
            aria-labelledby={requestsHeading}
            className="flex flex-col gap-3"
          >
            <h2 className="text-sm font-medium" id={requestsHeading}>
              <Trans>Shares waiting for you</Trans>
            </h2>
            {data.requests.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                <Trans>Nobody is waiting for you to decide a share.</Trans>
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
                {data.requests.map((request) => (
                  <ShareRequest
                    busy={busy}
                    key={request.id}
                    onApprove={() => {
                      act(async (skills) => await skills.approve(request.id));
                    }}
                    onDecline={() => {
                      act(async (skills) => await skills.decline(request.id));
                    }}
                    request={request}
                  />
                ))}
              </ul>
            )}
          </section>
        )}

        <section
          aria-labelledby={companyHeading}
          className="flex flex-col gap-3"
        >
          <h2 className="text-sm font-medium" id={companyHeading}>
            <Trans>The company&apos;s skills</Trans>
          </h2>
          {data !== undefined && data.company.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              <Trans>The company has no skills of its own yet.</Trans>
            </p>
          ) : null}
          <ItemGroup render={<ul />} spacing="tight">
            {data?.company.map((skill) => {
              const { name, version } = skill;
              return (
                <li key={name}>
                  <Item size="sm" variant="outline">
                    <ItemContent>
                      <span className="text-sm font-medium">{name}</span>
                      <span className="text-muted-foreground text-sm">
                        {skill.description}
                      </span>
                      <span className="text-muted-foreground text-xs">
                        <Trans>Version {version}</Trans>
                      </span>
                    </ItemContent>
                    {data.requests === null ? null : (
                      <ItemActions>
                        <Confirmed
                          confirm={t`Retire`}
                          description={t`Nobody's agents use ${name} from then on. Its versions stay as history, and a new approved share of its name brings it back.`}
                          disabled={busy}
                          label={t`Retire`}
                          onConfirm={() => {
                            act(async (skills) => {
                              await skills.retire(name);
                            });
                          }}
                          title={t`Retire ${name}?`}
                        />
                      </ItemActions>
                    )}
                  </Item>
                </li>
              );
            })}
          </ItemGroup>
        </section>
      </div>
    </div>
  );
};
