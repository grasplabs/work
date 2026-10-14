import type { DependencyReview } from "@grasp-os/shared/dependencies";
import { Button } from "@grasp-os/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@grasp-os/ui/components/dialog";
import { Trans, useLingui } from "@lingui/react/macro";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { ArrowLeftIcon, ArrowUpRightIcon } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { grantReviewed, reviewedVersion } from "../activity/pending.tsx";
import { changeThenRefresh } from "../change-then-refresh.ts";
import {
  confirmHeld,
  declineHeld,
  HeldWriteDetails,
  useShown,
} from "../chat/held-writes.tsx";
import type { Session } from "../core.ts";
import { PackagesDetails } from "../dashboard/dependency-requests.tsx";
import { RequestDetails } from "../dashboard/pile-cards.tsx";
import { ErrorText } from "../error-text.tsx";
import { formatDate } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";
import { ItemMark, KindPill } from "./inbox-kind.tsx";
import type { InboxItem, InboxSource, Target } from "./items.ts";
import { TargetLink } from "./target-link.tsx";

// An item of the inbox, as the prototype's (`routes/inbox.tsx`): what
// happened and what to do, its context, and a bar with its actions at the
// bottom. Each action goes to core with the same calls the dashboard's
// pile makes, and the inbox is read again once it is through, so a
// settled item leaves the list. What the prototype's bar adds besides
// (dismiss with why, put away until a date, give to someone) core keeps
// nothing of, so the bar has the item's own actions only.

/** One of an item's actions: a press that goes to core, or the way to where it is done. */
interface Act {
  label: string;
  /** Its name: the word, with what it acts on. */
  name?: string;
  onPress?: () => Promise<void>;
  /** Done on its own page: the button leads there. */
  to?: Target;
  disabled?: boolean;
  /** The id of a line that says why it waits. */
  describedBy?: string;
  /** Asked once more before it is done, in a dialog: for a no that can't be taken back. */
  confirm?: { title: string; description: string };
}

/** The height of one line in the list. Every line in the item falls on this rhythm too, in pixels. */
const row = 56;

/**
 * A block whose height is a whole number of list lines, so its bottom line
 * meets a line of the list beside it. It grows by a whole line when its
 * content needs more room.
 */
const pxSuffix = /px$/u;

/** Makes `block` as high as the whole list lines its content takes. */
const fitRows = (block: HTMLElement, content: HTMLElement): void => {
  const style = getComputedStyle(block);
  const chrome = [
    style.paddingTop,
    style.paddingBottom,
    style.borderTopWidth,
    style.borderBottomWidth,
  ].reduce((sum, value) => sum + (Number(value.replace(pxSuffix, "")) || 0), 0);
  // A hair under a whole line still fits in it; rounding would otherwise add a line.
  const rows = Math.max(
    1,
    Math.ceil((content.offsetHeight + chrome - 0.5) / row)
  );
  // A custom property, not a style: the class reads it (`min-h-(--rows-height)`).
  block.style.setProperty("--rows-height", `${rows * row}px`);
};

const Rows = ({
  className,
  children,
}: {
  className: string;
  children: ReactNode;
}) => {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const block = outer.current;
    const content = inner.current;
    const observer = new ResizeObserver(() => {
      if (block !== null && content !== null) {
        fitRows(block, content);
      }
    });
    if (block !== null && content !== null) {
      fitRows(block, content);
      observer.observe(content);
    }
    return () => {
      observer.disconnect();
    };
  }, []);
  return (
    <div className={className} ref={outer}>
      <div ref={inner}>{children}</div>
    </div>
  );
};

/** A section of the item, with a grey band for its name, one line high. */
const Section = ({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) => (
  <section aria-label={title}>
    <h2 className="bg-row-group flex h-14 items-center border-b px-5 font-medium">
      {title}
    </h2>
    {children}
  </section>
);

/** One fact of the context: a cell one line high, or two when its value needs the room. */
const Fact = ({ label, value }: { label: string; value: string }) => (
  <Rows className="flex min-h-(--rows-height) flex-col justify-center border-r border-b px-5 py-2">
    <dl>
      <dt className="text-muted-foreground text-xs leading-4">{label}</dt>
      <dd className="mt-0.5 leading-5">{value}</dd>
    </dl>
  </Rows>
);

/** An action's button: a press, asked once more where it can't be taken back, or the way to its page. */
const ActButton = ({
  act,
  busy,
  variant,
}: {
  act: Act;
  busy: boolean;
  variant: "default" | "outline";
}) => {
  const [confirming, setConfirming] = useState(false);
  if (act.to !== undefined) {
    return (
      <Button
        aria-label={act.name}
        nativeButton={false}
        render={<TargetLink destination={act.to} />}
        size="sm"
        variant={variant}
      >
        {act.label}
        <ArrowUpRightIcon data-icon="inline-end" />
      </Button>
    );
  }
  const press = () => {
    void act.onPress?.();
  };
  const { confirm } = act;
  const disabled = busy || act.disabled === true;
  if (confirm === undefined) {
    return (
      <Button
        aria-describedby={act.describedBy}
        aria-label={act.name}
        disabled={disabled}
        onClick={press}
        size="sm"
        variant={variant}
      >
        {act.label}
      </Button>
    );
  }
  const button = (
    <Button
      aria-describedby={act.describedBy}
      aria-label={act.name}
      disabled={disabled}
      size="sm"
      variant={variant}
    />
  );
  return (
    <Dialog onOpenChange={setConfirming} open={confirming}>
      <DialogTrigger render={button}>{act.label}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{confirm.title}</DialogTitle>
          <DialogDescription>{confirm.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            onClick={() => {
              setConfirming(false);
            }}
            variant="outline"
          >
            <Trans>Cancel</Trans>
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              setConfirming(false);
              press();
            }}
            variant="destructive"
          >
            {act.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** The item as it is shown: what happened, its context, and its actions, the first its next step. */
const ItemFrame = ({
  frame,
  extra,
  acts,
  busy,
  failure,
}: {
  frame: Frame;
  /** What has to be read before deciding, under what happened. */
  extra?: ReactNode;
  acts: Act[];
  busy: boolean;
  failure: string | undefined;
}) => {
  const { t } = useLingui();
  const { item, onBack } = frame;
  const [first, ...others] = acts;
  let forWhom = t`For an admin`;
  if (item.forWhom !== undefined && "role" in item.forWhom) {
    const { role } = item.forWhom;
    forWhom = t`For the ${role}`;
  } else if (item.forWhom !== undefined) {
    const { person } = item.forWhom;
    forWhom = t`For ${person}`;
  }
  // With no action of its own, the item is dealt with where it lives.
  const openLink =
    item.about === undefined ? null : (
      <Button
        nativeButton={false}
        render={<TargetLink destination={item.about} />}
        size="sm"
      >
        <Trans>Open</Trans>
        <ArrowUpRightIcon data-icon="inline-end" />
      </Button>
    );
  return (
    <article aria-label={item.title} className="flex min-h-full flex-col">
      <header className="flex h-14 flex-none items-center gap-3 border-b px-5">
        <Button
          aria-label={t`Back to the list`}
          className="-ml-2 @4xl/inbox:hidden"
          onClick={onBack}
          size="icon-sm"
          variant="ghost"
        >
          <ArrowLeftIcon />
        </Button>
        <ItemMark item={item} />
        <span className="min-w-0 flex-1 truncate font-medium">
          {item.context}
        </span>
        <span className="hidden @md/item:inline-flex">
          <KindPill kind={item.kind} />
        </span>
        <span className="text-muted-foreground text-xs tabular-nums">
          {formatDate(item.date)}
        </span>
      </header>

      <Section
        title={t({ message: "What happened", context: "inbox item section" })}
      >
        <Rows className="min-h-(--rows-height) border-b px-5 py-4">
          <div className="flex flex-col gap-3 leading-6">
            <p className="font-medium">{item.title}</p>
            {item.body.map((paragraph) => (
              <p className="text-muted-foreground" key={paragraph}>
                {paragraph}
              </p>
            ))}
            {extra}
            {first === undefined ? null : (
              <div className="bg-card flex items-center justify-between gap-4 rounded-lg border px-4 py-3">
                <span className="text-muted-foreground">
                  <Trans context="inbox: the action that settles an item">
                    Next step
                  </Trans>
                </span>
                <ActButton act={first} busy={busy} variant="default" />
              </div>
            )}
            <ErrorText>{failure}</ErrorText>
          </div>
        </Rows>
      </Section>

      <Section title={t({ message: "Context", context: "inbox item section" })}>
        {/* Each cell draws its own right and bottom line; the column at the edge hides its right one. */}
        <div className="overflow-hidden">
          <div className="-mr-px grid grid-cols-1 @md/item:grid-cols-2 @2xl/item:grid-cols-3">
            <Fact label={t`Who`} value={forWhom} />
            {item.facts.map((fact) => (
              <Fact
                key={`${fact.label}-${fact.value}`}
                label={fact.label}
                value={fact.value}
              />
            ))}
          </div>
        </div>
        {item.about === undefined ? null : (
          <div className="flex h-14 items-center border-b px-5">
            <TargetLink
              className="inline-flex items-center gap-1 hover:underline"
              destination={item.about}
            >
              <Trans>Open where it lives</Trans>
              <ArrowUpRightIcon className="text-muted-foreground size-3.5" />
            </TargetLink>
          </div>
        )}
      </Section>

      {/* The actions float at the foot of the item: the quiet ones first, the item's own last. */}
      {first === undefined && item.about === undefined ? null : (
        <div className="sticky bottom-4 mt-auto flex justify-center px-5 pt-6">
          <div className="bg-background flex max-w-full flex-wrap items-center justify-center gap-1 rounded-xl border p-1.5">
            {others.map((act) => (
              <ActButton
                act={act}
                busy={busy}
                key={act.label}
                variant="outline"
              />
            ))}
            {first === undefined ? (
              openLink
            ) : (
              <ActButton act={first} busy={busy} variant="default" />
            )}
          </div>
        </div>
      )}
    </article>
  );
};

/** What the inbox gives an item: the way back to the list, and where to say what was done. */
interface Frame {
  item: InboxItem;
  onBack: () => void;
  /** Says what was done, for a screen reader: the list only loses the item. */
  onSaid: (said: string) => void;
}

/** Makes a change, says what was done, and reads the inbox again whatever came of it. */
const useDecide = (onSaid: (said: string) => void) => {
  const router = useRouter();
  const action = useCoreAction();
  const decide = async (
    change: (session: Session) => Promise<unknown>,
    said: string
  ): Promise<void> => {
    await action.run(async (session) => {
      await changeThenRefresh(
        async () => {
          await change(session);
          onSaid(said);
        },
        async () => {
          // `sync` waits for the read, so the buttons stay off until the item goes.
          await router.invalidate({ sync: true });
        }
      );
    });
  };
  return { ...action, decide };
};

/** A held write: approving it is for what the person was shown, all of it. */
const HeldItem = ({
  frame,
  source,
}: {
  frame: Frame;
  source: Extract<InboxSource, { type: "held" }>;
}) => {
  const { t } = useLingui();
  const { action } = source;
  const shown = useShown(action);
  const { busy, failure, decide } = useDecide(frame.onSaid);
  const who = frame.item.context;
  return (
    <ItemFrame
      acts={[
        {
          label: t`Approve`,
          name: t`Approve ${who}`,
          disabled: shown.unseen,
          describedBy: shown.unseen ? shown.unseenId : undefined,
          onPress: async () => {
            await decide(confirmHeld(action), t`Approved: ${who}.`);
          },
        },
        {
          label: t`Reject`,
          name: t`Reject ${who}`,
          onPress: async () => {
            await decide(declineHeld(action), t`Rejected: ${who}.`);
          },
        },
      ]}
      busy={busy}
      extra={<HeldWriteDetails action={action} shown={shown} />}
      failure={failure}
      frame={frame}
    />
  );
};

/** A permission request: approving grants it for the version of its App that was reviewed. */
const RequestItem = ({
  frame,
  source,
}: {
  frame: Frame;
  source: Extract<InboxSource, { type: "request" }>;
}) => {
  const { t } = useLingui();
  const { request, pending } = source;
  const { busy, failure, decide } = useDecide(frame.onSaid);
  const who = frame.item.context;
  return (
    <ItemFrame
      acts={[
        {
          label: t`Approve`,
          name: t`Approve ${who}`,
          onPress: async () => {
            await decide(
              async (session) =>
                await grantReviewed(
                  session.permissions,
                  request,
                  reviewedVersion(request, pending.directory)
                ),
              t`Approved: ${who}.`
            );
          },
        },
        {
          label: t`Reject`,
          name: t`Reject ${who}`,
          confirm: {
            title: t`Reject this request?`,
            description: t`${who} can't be granted later: it has to ask again.`,
          },
          onPress: async () => {
            await decide(
              async (session) => await session.permissions.revoke(request.id),
              t`Rejected: ${who}.`
            );
          },
        },
      ]}
      busy={busy}
      extra={<RequestDetails directory={pending.directory} request={request} />}
      failure={failure}
      frame={frame}
    />
  );
};

/** Packages for an engine: approving waits until the whole graph was shown, and names it. */
const PackagesItem = ({
  frame,
  source,
}: {
  frame: Frame;
  source: Extract<InboxSource, { type: "packages" }>;
}) => {
  const { t } = useLingui();
  const router = useRouter();
  const { request, policyGeneration } = source;
  const { busy, failure, run } = useCoreAction();
  const [review, setReview] = useState<DependencyReview>();
  const hintId = useId();
  const engine = request.app.name;
  const who = frame.item.context;
  // Read again once it is decided. A refused decision stays, with why:
  // reading again would take the item, and the reason, away.
  const decide = async (approved: boolean, said: string): Promise<void> => {
    await run(async (session) => {
      await session.dependencies.decide(request.id, {
        approved,
        // The graph the person was shown in full, once they were.
        reviewed: {
          graphHash: review?.graphHash ?? request.graphHash,
          policyGeneration,
        },
      });
      frame.onSaid(said);
      await router.invalidate({ sync: true });
    });
  };
  return (
    <ItemFrame
      acts={[
        {
          label: t`Approve`,
          name: t`Approve the packages for ${engine}`,
          disabled: review === undefined,
          describedBy: review === undefined ? hintId : undefined,
          onPress: async () => {
            await decide(true, t`Approved: ${who}.`);
          },
        },
        {
          label: t`Reject`,
          name: t`Reject the packages for ${engine}`,
          onPress: async () => {
            await decide(false, t`Rejected: ${who}.`);
          },
        },
      ]}
      busy={busy}
      extra={
        <PackagesDetails
          busy={busy}
          hintId={hintId}
          onShow={() => {
            void run(async (session) => {
              setReview(await session.dependencies.get(request.id));
            });
          }}
          request={request}
          review={review}
        />
      }
      failure={failure}
      frame={frame}
    />
  );
};

/** A failed workflow: its next step asks the agent to fix it, in a new chat with the run's report. */
const FailedItem = ({
  frame,
  source,
}: {
  frame: Frame;
  source: Extract<InboxSource, { type: "failed" }>;
}) => {
  const { t } = useLingui();
  const navigate = useNavigate();
  const { busy, failure, run } = useCoreAction();
  const [refused, setRefused] = useState<string>();
  const { model, notification } = source;
  const ask = async (asked: string): Promise<void> => {
    const started = await run(
      async (session) => await session.chats.fixRun(notification.run, asked)
    );
    if (started === undefined) {
      return;
    }
    if (started.sent) {
      await navigate({ to: "/", search: { chat: started.chat.id } });
      return;
    }
    const { reason } = started;
    setRefused(t`The agent wasn't asked: ${reason}`);
  };
  return (
    <ItemFrame
      acts={
        model === undefined
          ? []
          : [
              {
                label: t`Ask the agent to fix`,
                onPress: async () => {
                  await ask(model);
                },
              },
            ]
      }
      busy={busy}
      failure={failure ?? refused}
      frame={frame}
    />
  );
};

/** What is done on its own page: its next step leads there. */
const ElsewhereItem = ({ frame }: { frame: Frame }) => {
  const { t } = useLingui();
  const { item } = frame;
  const label = item.source.type === "reconnect" ? t`Sign in again` : t`Review`;
  return (
    <ItemFrame
      acts={item.about === undefined ? [] : [{ label, to: item.about }]}
      busy={false}
      failure={undefined}
      frame={frame}
    />
  );
};

/** The item, by what it was made from. */
export const ItemDetail = (frame: Frame) => {
  const { source } = frame.item;
  if (source.type === "held") {
    return <HeldItem frame={frame} source={source} />;
  }
  if (source.type === "request") {
    return <RequestItem frame={frame} source={source} />;
  }
  if (source.type === "packages") {
    return <PackagesItem frame={frame} source={source} />;
  }
  if (source.type === "failed") {
    return <FailedItem frame={frame} source={source} />;
  }
  return <ElsewhereItem frame={frame} />;
};
