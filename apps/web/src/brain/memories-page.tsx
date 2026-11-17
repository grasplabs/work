import type {
  BrainContestedFact,
  BrainEntityKind,
  BrainEntityListed,
  BrainEntityRef,
  BrainMemoryAttribute,
  BrainMemoryPageNext,
  BrainMemoryShown,
  BrainShareAudience,
  BrainShareAudiences,
  BrainSharedListed,
  BrainStoreCursor,
} from "@grasp-os/shared/brain-memories";
import {
  brainCorrectionMaxLength,
  brainEntityKinds,
} from "@grasp-os/shared/brain-memories";
import { shownVisibly } from "@grasp-os/shared/chat";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Card, CardContent } from "@grasp-os/ui/components/card";
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
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import { Item, ItemContent, ItemGroup } from "@grasp-os/ui/components/item";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import {
  PageHeader,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@grasp-os/ui/components/page-header";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { toast } from "@grasp-os/ui/components/toast";
import { Trans, useLingui } from "@lingui/react/macro";
import { createContext, use, useId, useRef, useState } from "react";
import type { ReactNode } from "react";

import { useHeldCoreRead } from "../apps/use-core-read.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useAsk, usePaged } from "./memories-asks.ts";

// The Brain's memories, from the new Brain (GRA-1746): the facts sources
// disagree on, each with its sides and a way to confirm one; the entities
// the person may see, by kind, a page at a time; and what the Brain
// remembers about one, history included, each memory with where it came
// from, and a way to say it is wrong. Core answers each from what they
// may read alone; what is theirs alone is marked so, as on the Sources
// page. Texts are shown as text, never markup. A fact or decision of
// their own about something named that isn't a person they can share
// with a team of theirs or everyone (GRA-1815): a copy, read as someone's
// own word, exactly as the dialog shows it, which they can take back from
// the list of what they shared, also once they can no longer read it;
// theirs stays theirs alone.

/** A team the person is in, whom they may share with. */
interface Team {
  id: string;
  name: string;
}

/**
 * The id of the entity that is the person themselves, in their own store
 * (`brainMemories.ownEntity`), for the names the page shows: null while
 * unknown.
 */
const OwnEntity = createContext<string | null>(null);

/** A memory's key, for React and for `usePaged`. */
const memoryKeyOf = ({ store, id }: BrainMemoryShown): string =>
  `${store}:${id}`;

/**
 * Says, where the person sees it whatever they scrolled to, that what
 * they acted on changed or is no longer theirs to read: the page reads
 * everything again beside it (`onChanged`).
 */
const sayChanged = (text: string): void => {
  toast.add({ type: "info", title: text });
};

/** An entity's key, for React. */
const keyOf = ({ store, id }: BrainEntityRef): string => `${store}:${id}`;

/** The same entity, by its store and id. */
const sameEntity = (one: BrainEntityRef, other: BrainEntityRef): boolean =>
  one.store === other.store && one.id === other.id;

/** A kind of entity, as the page names it. */
const useKindLabel = (): ((kind: BrainEntityKind) => string) => {
  const { t } = useLingui();
  const labels: Record<BrainEntityKind, string> = {
    person: t({
      message: "People",
      context: "a kind of thing the Brain remembers",
    }),
    team: t({
      message: "Teams",
      context: "a kind of thing the Brain remembers",
    }),
    customer: t({
      message: "Customers",
      context: "a kind of thing the Brain remembers",
    }),
    supplier: t({
      message: "Suppliers",
      context: "a kind of thing the Brain remembers",
    }),
    project: t({
      message: "Projects",
      context: "a kind of thing the Brain remembers",
    }),
    product: t({
      message: "Products",
      context: "a kind of thing the Brain remembers",
    }),
    tool: t({
      message: "Tools",
      context: "a kind of thing the Brain remembers",
    }),
    routine: t({
      message: "Routines",
      context: "a kind of thing the Brain remembers",
    }),
    app: t({ message: "Apps", context: "a kind of thing the Brain remembers" }),
    workflow: t({
      message: "Workflows",
      context: "a kind of thing the Brain remembers",
    }),
    connection: t({
      message: "Connections",
      context: "a kind of thing the Brain remembers",
    }),
    term: t({
      message: "Terms",
      context: "a kind of thing the Brain remembers",
    }),
  };
  return (kind) => labels[kind];
};

/** What a memory is filed under, as the page names it. */
const useAttributeLabel = (): ((attribute: BrainMemoryAttribute) => string) => {
  const { t } = useLingui();
  const labels: Record<BrainMemoryAttribute, string> = {
    account_owner: t({
      message: "Account owner",
      context: "what the Brain remembers about something",
    }),
    availability: t({
      message: "Availability",
      context: "what the Brain remembers about something",
    }),
    complaint: t({
      message: "Complaint",
      context: "what the Brain remembers about something",
    }),
    contact: t({
      message: "Contact",
      context: "what the Brain remembers about something",
    }),
    contract_end: t({
      message: "Contract end",
      context: "what the Brain remembers about something",
    }),
    contract_value: t({
      message: "Contract value",
      context: "what the Brain remembers about something",
    }),
    cost: t({
      message: "Cost",
      context: "what the Brain remembers about something",
    }),
    customer: t({
      message: "Customer",
      context: "what the Brain remembers about something",
    }),
    deadline: t({
      message: "Deadline",
      context: "what the Brain remembers about something",
    }),
    decision: t({
      message: "Decision",
      context: "what the Brain remembers about something",
    }),
    definition: t({
      message: "Definition",
      context: "what the Brain remembers about something",
    }),
    description: t({
      message: "Description",
      context: "what the Brain remembers about something",
    }),
    employer: t({
      message: "Employer",
      context: "what the Brain remembers about something",
    }),
    expertise: t({
      message: "Expertise",
      context: "what the Brain remembers about something",
    }),
    feature: t({
      message: "Feature",
      context: "what the Brain remembers about something",
    }),
    frequency: t({
      message: "Frequency",
      context: "what the Brain remembers about something",
    }),
    goal: t({
      message: "Goal",
      context: "what the Brain remembers about something",
    }),
    industry: t({
      message: "Industry",
      context: "what the Brain remembers about something",
    }),
    instruction: t({
      message: "Instruction",
      context: "what the Brain remembers about something",
    }),
    language: t({
      message: "Language",
      context: "what the Brain remembers about something",
    }),
    lead: t({
      message: "Lead",
      context: "what the Brain remembers about something",
    }),
    location: t({
      message: "Location",
      context: "what the Brain remembers about something",
    }),
    manager: t({
      message: "Manager",
      context: "what the Brain remembers about something",
    }),
    member: t({
      message: "Member",
      context: "what the Brain remembers about something",
    }),
    next_step: t({
      message: "Next step",
      context: "what the Brain remembers about something",
    }),
    owner: t({
      message: "Owner",
      context: "what the Brain remembers about something",
    }),
    owns: t({
      message: "Owns",
      context: "what the Brain remembers about something",
    }),
    preference: t({
      message: "Preference",
      context: "what the Brain remembers about something",
    }),
    price: t({
      message: "Price",
      context: "what the Brain remembers about something",
    }),
    promise: t({
      message: "Promise",
      context: "what the Brain remembers about something",
    }),
    purpose: t({
      message: "Purpose",
      context: "what the Brain remembers about something",
    }),
    renewal_date: t({
      message: "Renewal date",
      context: "what the Brain remembers about something",
    }),
    requirement: t({
      message: "Requirement",
      context: "what the Brain remembers about something",
    }),
    responsibility: t({
      message: "Responsibility",
      context: "what the Brain remembers about something",
    }),
    role: t({
      message: "Role",
      context: "what the Brain remembers about something",
    }),
    status: t({
      message: "Status",
      context: "what the Brain remembers about something",
    }),
    step: t({
      message: "Step",
      context: "what the Brain remembers about something",
    }),
    supplies: t({
      message: "Supplies",
      context: "what the Brain remembers about something",
    }),
    synonym: t({
      message: "Also called",
      context: "what the Brain remembers about something",
    }),
    team: t({
      message: "Team",
      context: "what the Brain remembers about something",
    }),
    terms: t({
      message: "Terms",
      context: "what the Brain remembers about something",
    }),
    trigger: t({
      message: "Trigger",
      context: "what the Brain remembers about something",
    }),
    used_by: t({
      message: "Used by",
      context: "what the Brain remembers about something",
    }),
    uses: t({
      message: "Uses",
      context: "what the Brain remembers about something",
    }),
  };
  return (attribute) => labels[attribute];
};

/** Where a memory came from: a source's version, or someone's own word. */
const MemoryOrigin = ({ memory }: { memory: BrainMemoryShown }) => {
  const { source } = memory;
  if (source === null) {
    return memory.yours ? (
      <Trans>Your own word</Trans>
    ) : (
      <Trans>Someone&apos;s own word</Trans>
    );
  }
  const { version } = source;
  const label = {
    upload: <Trans>From an upload, version {version}</Trans>,
    chat: <Trans>From a chat, version {version}</Trans>,
    run: <Trans>From a workflow run, version {version}</Trans>,
    capture: <Trans>Fetched from a connection, version {version}</Trans>,
    interview: <Trans>From your interview, version {version}</Trans>,
    claim: <Trans>From what your team said, version {version}</Trans>,
    drawing: <Trans>From how a team works, version {version}</Trans>,
    kickoff: <Trans>From the company&apos;s vision, version {version}</Trans>,
    roster: <Trans>From the company&apos;s teams, version {version}</Trans>,
    connected: <Trans>Read from a shared connection, version {version}</Trans>,
  }[source.source.producer];
  return label;
};

/**
 * Says `memory` is wrong, with what is right: the person's own word,
 * theirs alone, confirmed. One opening of it (`opening`, the page keys it
 * by that) is one correction, its id first the opening's, so a retry
 * saves it once, and the key its answer is tied to: a reply for an
 * earlier opening lands nowhere. The page holds it apart from the row
 * that opened it, so a row read away while it saves leaves it, and its
 * outcome, in place. While it saves, it can't be closed (its close
 * button, Escape, a click outside).
 */
const CorrectDialog = ({
  memory,
  opening,
  returnTo,
  onClose,
  onCorrected,
}: {
  memory: BrainMemoryShown;
  opening: string;
  /** What opened it, where focus goes back to while it is on the page. */
  returnTo: HTMLElement;
  onClose: () => void;
  onCorrected: () => void;
}) => {
  const { t } = useLingui();
  const ids = useId();
  const [right, setRight] = useState("");
  const [change, setChange] = useState(opening);
  // The text of a save that failed: new words after it are a new
  // correction, with a new id, while the same words retry the same one.
  const [tried, setTried] = useState<string>();
  const { busy, failure, ask } = useAsk(`correct#${change}`);
  const changedText = t`This memory has changed or is no longer yours to read. Look at it again first.`;
  const ready = right.trim() !== "";
  const correct = async (): Promise<void> => {
    const words = right.trim();
    setTried(right);
    await ask(
      async (memories) =>
        await memories.correct({
          wrong: {
            store: memory.store,
            entity: memory.about,
            memory: memory.id,
          },
          right: words,
          change,
        }),
      (saved) => {
        setTried(undefined);
        onClose();
        // Not theirs to correct now: say so, and read the page again so
        // it shows what stands (their own earlier save of this one too).
        if (saved === null) {
          sayChanged(changedText);
        }
        onCorrected();
      }
    );
  };
  return (
    <Dialog
      disablePointerDismissal={busy}
      onOpenChange={(open) => {
        if (!open && !busy) {
          onClose();
        }
      }}
      open
    >
      <DialogContent
        closeLabel={t`Close`}
        finalFocus={() => (returnTo.isConnected ? returnTo : null)}
        showCloseButton={!busy}
      >
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready && !busy) {
              void correct();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>
              <Trans>What is right?</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>
                Your correction is kept as your own word, for you alone, and
                shown beside what the Brain holds. What others read stays as it
                is.
              </Trans>
            </DialogDescription>
          </DialogHeader>
          <p className="text-muted-foreground text-sm whitespace-pre-wrap">
            {memory.statement}
          </p>
          <Field>
            <FieldLabel htmlFor={`${ids}-right`}>
              <Trans>What is right</Trans>
            </FieldLabel>
            <Textarea
              disabled={busy}
              id={`${ids}-right`}
              maxLength={brainCorrectionMaxLength}
              onChange={(event) => {
                const { value: typed } = event.target;
                if (tried !== undefined && typed !== tried) {
                  setChange(crypto.randomUUID());
                  setTried(undefined);
                }
                setRight(typed);
              }}
              rows={3}
              value={right}
            />
            <FieldDescription>
              <Trans>In your own words, as you would tell a colleague.</Trans>
            </FieldDescription>
          </Field>
          <ErrorText>{failure}</ErrorText>
          <DialogFooter>
            <DialogClose
              disabled={busy}
              render={<Button type="button" variant="outline" />}
            >
              <Trans>Cancel</Trans>
            </DialogClose>
            <Button disabled={!ready || busy} type="submit">
              <Trans>Save the correction</Trans>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/**
 * Whether `memory` is one the person may share: a current fact or decision
 * of their own store that names no second entity, never how Grasp acts
 * for them (core's `publishAs` takes no other).
 */
const isShareable = ({
  store,
  endedAt,
  object,
  type,
  attribute,
}: BrainMemoryShown): boolean =>
  store === "own" &&
  endedAt === null &&
  object === null &&
  (type === "fact" || type === "decision") &&
  attribute !== "instruction" &&
  attribute !== "preference";

/** The audience a choice of the dialog's names: `everyone`, or a team's id. */
const audienceOf = (choice: string): BrainShareAudience =>
  choice === "everyone" ? "company" : { team: choice };

/**
 * Which texts of a memory show, the one rule for its line on the page and
 * for the share dialog, so they never differ: its attribute's label with
 * the value it holds, the label alone, or the value alone (a memory may
 * hold one without an attribute); then its statement, unless it is that
 * value, shown right above. `held` and `statement` as the caller shows
 * them (the dialog escapes what nobody sees); `held` is the value, or the
 * entity a relation names.
 */
const MemoryTexts = ({
  label,
  held,
  statement,
}: {
  label: string | null;
  held: string | null;
  statement: string;
}) => {
  let valueLine: ReactNode = null;
  if (label !== null) {
    valueLine =
      held === null ? (
        <span className="font-medium">{label}</span>
      ) : (
        <Trans>
          <span className="font-medium">{label}</span>: {held}
        </Trans>
      );
  } else if (held !== null) {
    valueLine = <Trans>Value: {held}</Trans>;
  }
  return (
    <>
      {valueLine === null ? null : (
        <span className="text-sm break-words whitespace-pre-wrap">
          {valueLine}
        </span>
      )}
      {held !== null && statement === held ? null : (
        <span className="text-sm break-words whitespace-pre-wrap">
          {statement}
        </span>
      )}
    </>
  );
};

/**
 * Whom a share is for: the teams and everyone core lets the person share
 * with (`loaded`), `choice` picked; a hint when there is no one yet, and
 * why when that couldn't be read, offering no one then.
 */
const AudienceField = ({
  loaded,
  choice,
  busy,
  onPick,
}: {
  loaded: Loaded<BrainShareAudiences> | undefined;
  choice: string | undefined;
  busy: boolean;
  onPick: (picked: string) => void;
}) => {
  const { t } = useLingui();
  const fieldId = useId();
  const audiences = loaded?.state === "ready" ? loaded.data : undefined;
  return (
    <>
      <Field>
        <FieldLabel htmlFor={fieldId}>
          <Trans context="a memory shared with others">Who may read it</Trans>
        </FieldLabel>
        <NativeSelect
          disabled={busy}
          id={fieldId}
          onChange={(event) => {
            onPick(event.target.value);
          }}
          value={choice ?? ""}
        >
          {(audiences?.teams ?? []).map(({ id, name }) => (
            <NativeSelectOption key={id} value={id}>
              {t`Team ${name}`}
            </NativeSelectOption>
          ))}
          {audiences?.company === true ? (
            <NativeSelectOption value="everyone">
              {t`Everyone`}
            </NativeSelectOption>
          ) : null}
        </NativeSelect>
        {audiences !== undefined && choice === undefined ? (
          <FieldDescription>
            <Trans>
              You can share with a team of yours, or with everyone, once it has
              three people or more.
            </Trans>
          </FieldDescription>
        ) : null}
      </Field>
      {loaded === undefined || loaded.state === "ready" ? null : (
        <NotLoaded page={loaded} />
      )}
    </>
  );
};

/**
 * Shares `memory`, what `about` names, with a team of the person's or
 * everyone: core keeps a copy in their own word, exactly as shown here,
 * for those readers. One opening of it (`opening`) is one share, so a
 * retry shares it once; another audience after a try is another share.
 * While it shares, it can't be closed.
 */
const ShareDialog = ({
  memory,
  about,
  opening,
  returnTo,
  onClose,
  onShared,
}: {
  memory: BrainMemoryShown;
  /** The name the page showed for what it is about. */
  about: string;
  opening: string;
  returnTo: HTMLElement;
  onClose: () => void;
  onShared: () => void;
}) => {
  const { t } = useLingui();
  const attributeLabel = useAttributeLabel();
  // Whom core lets them share with: everyone and their teams, each of
  // three people or more (with fewer, the others would know who shared
  // it). Nothing is shared until that is read; a read that failed offers
  // no one, never "Everyone" alone.
  const { loaded } = useHeldCoreRead(
    `share-audiences#${opening}`,
    async (session) => await session.brainMemories.shareAudiences()
  );
  const audiences = loaded?.state === "ready" ? loaded.data : undefined;
  const [chosen, setChosen] = useState<string>();
  const offered = [
    ...(audiences?.teams ?? []).map(({ id }) => id),
    ...(audiences?.company === true ? ["everyone"] : []),
  ];
  const choice =
    chosen !== undefined && offered.includes(chosen) ? chosen : offered[0];
  const [change, setChange] = useState(opening);
  // The audience of a share that failed: another is a new share, with a
  // new id, while the same retries the same one.
  const [tried, setTried] = useState<string>();
  const { busy, failure, ask } = useAsk(`share#${change}`);
  const changedText = t`This memory has changed or is no longer yours to share. Look at it again first.`;
  const sharedText = t`Shared. It shows under the same name for those you shared it with.`;
  const { attribute, value, statement, validFrom, validUntil } = memory;
  const label = attribute === null ? null : attributeLabel(attribute);
  // What is shared, as shown: whole, never cut short, every character
  // nobody sees as an escape (`shownVisibly`), so a statement a model
  // was steered to hide something in shows what it holds. What is sent
  // is the text as stored, which core checks is exactly this.
  const aboutShown = shownVisibly(about);
  const held = value === null ? null : shownVisibly(value);
  const said = shownVisibly(statement);
  const from = validFrom === null ? null : formatDateTime(validFrom);
  const until = validUntil === null ? null : formatDateTime(validUntil);
  const share = async (to: string): Promise<void> => {
    setTried(to);
    await ask(
      async (memories) =>
        await memories.publish({
          memory: { entity: memory.about, memory: memory.id },
          shown: {
            about,
            attribute: memory.attribute,
            type: memory.type,
            value,
            statement,
            validFrom,
            validUntil,
          },
          audience: audienceOf(to),
          change,
        }),
      (shared) => {
        setTried(undefined);
        onClose();
        if (shared === null) {
          sayChanged(changedText);
        } else {
          toast.add({ type: "success", title: sharedText });
        }
        onShared();
      }
    );
  };
  return (
    <Dialog
      disablePointerDismissal={busy}
      onOpenChange={(open) => {
        if (!open && !busy) {
          onClose();
        }
      }}
      open
    >
      <DialogContent
        closeLabel={t`Close`}
        finalFocus={() => (returnTo.isConnected ? returnTo : null)}
        showCloseButton={!busy}
      >
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy && choice !== undefined) {
              void share(choice);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>
              <Trans>Share this memory?</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>
                They will read exactly what is below, as someone&apos;s own
                word, without your name. Your own memory stays yours alone, and
                you can take the copy back.
              </Trans>
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1 text-sm">
            <span className="font-medium">
              <Trans>About {aboutShown}</Trans>
            </span>
            {/* Every text a share copies shows, as the page's line shows it
                (`MemoryTexts`), escaped. */}
            <MemoryTexts held={held} label={label} statement={said} />
            {from === null ? null : (
              <span>
                <Trans>True from {from}</Trans>
              </span>
            )}
            {until === null ? null : (
              <span>
                <Trans>True until {until}</Trans>
              </span>
            )}
          </div>
          <AudienceField
            busy={busy}
            choice={choice}
            loaded={loaded}
            onPick={(picked) => {
              if (tried !== undefined && picked !== tried) {
                setChange(crypto.randomUUID());
                setTried(undefined);
              }
              setChosen(picked);
            }}
          />
          <ErrorText>{failure}</ErrorText>
          <DialogFooter>
            <DialogClose
              disabled={busy}
              render={<Button type="button" variant="outline" />}
            >
              <Trans>Cancel</Trans>
            </DialogClose>
            <Button disabled={busy || choice === undefined} type="submit">
              <Trans>Share</Trans>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/**
 * Takes back `memory`, one the person shared: it stops being current for
 * everyone, and stays as history for those it was shared with.
 */
const TakeBackButton = ({
  id,
  statement,
  read,
  onTakenBack,
}: {
  /** The shared memory's id. */
  id: string;
  /** What it says, or null when the person may no longer read it. */
  statement: string | null;
  /** The read of the page it is on: a failure shows until the next. */
  read: number;
  onTakenBack: () => void;
}) => {
  const { t } = useLingui();
  const { busy, failure, ask } = useAsk(`unpublish#${id}`, `${read}`);
  const changedText = t`This memory has changed or is no longer yours to read. Look at it again first.`;
  return (
    <>
      <Button
        aria-label={
          statement === null
            ? t`Take back what you shared`
            : t`Take back what you shared: ${statement}`
        }
        disabled={busy}
        onClick={() => {
          void ask(
            async (memories) => await memories.unpublish(id),
            (outcome) => {
              if (outcome === "nothing") {
                sayChanged(changedText);
              }
              onTakenBack();
            }
          );
        }}
        size="sm"
        type="button"
        variant="outline"
      >
        <Trans>Take back</Trans>
      </Button>
      <ErrorText>{failure}</ErrorText>
    </>
  );
};

/** Confirms `memory` over the sides that say otherwise. */
const ConfirmButton = ({
  memory,
  read,
  onConfirmed,
}: {
  memory: BrainMemoryShown;
  /** The read of the page it is on: a failure shows until the next. */
  read: number;
  onConfirmed: () => void;
}) => {
  const { t } = useLingui();
  const { busy, failure, ask } = useAsk(
    `confirm#${memoryKeyOf(memory)}`,
    `${read}`
  );
  const { statement } = memory;
  const changedText = t`This memory has changed or is no longer yours to read. Look at it again first.`;
  return (
    <>
      <Button
        aria-label={t`Say this one is right: ${statement}`}
        disabled={busy}
        onClick={() => {
          void ask(
            async (memories) =>
              await memories.confirm({
                store: memory.store,
                memory: memory.id,
              }),
            (outcome) => {
              if (outcome === "nothing") {
                sayChanged(changedText);
              }
              // Read again on either answer: what stands now shows.
              onConfirmed();
            }
          );
        }}
        size="sm"
        type="button"
        variant="outline"
      >
        <Trans>This one is right</Trans>
      </Button>
      <ErrorText>{failure}</ErrorText>
    </>
  );
};

/** A memory's marks: whose it is, disagreement, confirmation, origin and its dates. */
const MemoryMarks = ({ memory }: { memory: BrainMemoryShown }) => {
  const { endedAt, confirmed } = memory;
  const learned = formatDateTime(memory.learnedAt);
  const ended = endedAt === null ? null : formatDateTime(endedAt);
  const current = endedAt === null;
  return (
    <span className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
      {memory.store === "own" ? (
        <Badge variant="outline">
          <Trans context="a memory nobody else may read">Only you</Trans>
        </Badge>
      ) : null}
      {current && memory.contested ? (
        <Badge variant="attention">
          <Trans>Sources disagree</Trans>
        </Badge>
      ) : null}
      {confirmed === null ? null : (
        <Badge variant="passed">
          {confirmed.byYou ? (
            <Trans>Confirmed by you</Trans>
          ) : (
            <Trans>Confirmed</Trans>
          )}
        </Badge>
      )}
      <span>
        <MemoryOrigin memory={memory} />
      </span>
      <span>
        <Trans>Learned {learned}</Trans>
      </span>
      {ended === null ? null : (
        <span>
          <Trans>No longer held since {ended}</Trans>
        </span>
      )}
    </span>
  );
};

/**
 * What the person can do about sharing `memory`: share one of their own
 * that may be shared (`onShare`, where what it is about is named), or take
 * back one they shared.
 */
const ShareActions = ({
  memory,
  read,
  onShare,
  onTakenBack,
}: {
  memory: BrainMemoryShown;
  read: number;
  onShare?: (memory: BrainMemoryShown, opener: HTMLElement) => void;
  onTakenBack: () => void;
}) => {
  const { t } = useLingui();
  const { statement } = memory;
  return (
    <>
      {onShare !== undefined && isShareable(memory) ? (
        <Button
          aria-label={t`Share with others: ${statement}`}
          onClick={(event) => {
            onShare(memory, event.currentTarget);
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          <Trans>Share…</Trans>
        </Button>
      ) : null}
      {memory.store === "shared" && memory.yours ? (
        <TakeBackButton
          id={memory.id}
          onTakenBack={onTakenBack}
          read={read}
          statement={statement}
        />
      ) : null}
    </>
  );
};

/** One memory: what it says, where it came from, its marks, and what the person can do. */
const MemoryLine = ({
  memory,
  read,
  onChanged,
  onCorrect,
  onShare,
}: {
  memory: BrainMemoryShown;
  /** The read of the page it is on. */
  read: number;
  onChanged: () => void;
  /** Opens the correction of `memory`, which the page holds, from `opener`. */
  onCorrect: (memory: BrainMemoryShown, opener: HTMLElement) => void;
  /** Opens the share of `memory`, from `opener`: where what it is about is named. */
  onShare?: (memory: BrainMemoryShown, opener: HTMLElement) => void;
}) => {
  const { t } = useLingui();
  const { statement } = memory;
  const attributeLabel = useAttributeLabel();
  const { attribute, object, value, endedAt, confirmed } = memory;
  const label = attribute === null ? null : attributeLabel(attribute);
  const own = use(OwnEntity);
  // What it holds: its value, or the entity a relation names (the person
  // themselves, for their own entity in their own store).
  let held: string | null = value;
  if (object !== null) {
    held =
      memory.store === "own" && object.id === own
        ? t({
            context: "the person themselves, as the Brain names them",
            message: "You",
          })
        : (object.name ?? t`something without a name`);
  }
  const current = endedAt === null;
  // Offered on a side that disagrees with another until the person said
  // it is right, and on their own word not yet confirmed (a correction
  // whose confirmation never landed), so it can still come first.
  const confirmable =
    current &&
    confirmed?.byYou !== true &&
    (memory.contested || (memory.store === "own" && memory.yours));
  // Where focus goes once confirmed, as the button goes: the memory itself.
  const said = useRef<HTMLSpanElement>(null);
  return (
    <Item size="sm">
      <ItemContent>
        {/* What it says, focusable so focus can stay here once its
            button goes. A correction holds its words as value and
            statement alike: they show once. */}
        <span className="flex flex-col gap-1" ref={said} tabIndex={-1}>
          <MemoryTexts held={held} label={label} statement={memory.statement} />
        </span>
        <MemoryMarks memory={memory} />
        {current ? (
          <span className="flex flex-wrap items-center gap-2">
            {confirmable ? (
              <ConfirmButton
                memory={memory}
                read={read}
                onConfirmed={() => {
                  said.current?.focus();
                  onChanged();
                }}
              />
            ) : null}
            {/* A relation names another entity, which the person's own
                word can't: core would keep it under no attribute, beside
                the relation, so it isn't offered there. */}
            {object === null ? (
              <Button
                aria-label={t`Say this is wrong: ${statement}`}
                onClick={(event) => {
                  onCorrect(memory, event.currentTarget);
                }}
                size="sm"
                type="button"
                variant="outline"
              >
                <Trans>It&apos;s wrong</Trans>
              </Button>
            ) : null}
            <ShareActions
              memory={memory}
              onShare={onShare}
              onTakenBack={() => {
                said.current?.focus();
                onChanged();
              }}
              read={read}
            />
          </span>
        ) : null}
      </ItemContent>
    </Item>
  );
};

/**
 * An entity's name, or a word for one without: the person themselves,
 * one a correction of theirs stands for that they may no longer read, or
 * one with no name.
 */
const EntityName = ({ entity }: { entity: BrainEntityListed }) => {
  const own = use(OwnEntity);
  if (entity.entity.store === "own" && entity.entity.id === own) {
    return (
      <Trans context="the person themselves, as the Brain names them">
        You
      </Trans>
    );
  }
  if (entity.unreadable) {
    return (
      <span className="text-muted-foreground">
        <Trans>Something you corrected, which you can no longer read</Trans>
      </span>
    );
  }
  return (
    entity.name ?? (
      <span className="text-muted-foreground">
        <Trans>Without a name</Trans>
      </span>
    )
  );
};

/** "Show more" of a listing (`usePaged`), and why the last one failed. */
const ShowMore = ({
  listing,
}: {
  listing: {
    next: unknown;
    busy: boolean;
    failure: string | undefined;
    showMore: () => void;
  };
}) => (
  <>
    <ErrorText>{listing.failure}</ErrorText>
    {listing.next === null ? null : (
      <Button
        className="self-start"
        disabled={listing.busy}
        onClick={() => {
          listing.showMore();
        }}
        type="button"
        variant="outline"
      >
        <Trans>Show more</Trans>
      </Button>
    )}
  </>
);

/** A contested fact's key, for React and for `usePaged`. */
const keyOfFact = ({ about, attribute }: BrainContestedFact): string =>
  `${keyOf(about.entity)}#${attribute}`;

/** The facts sources disagree on that the person may read, a page at a time. */
const ContestedList = ({
  contested,
  read,
  onOpen,
  onChanged,
  onCorrect,
}: {
  contested: ReturnType<typeof useContested>;
  /** The read of the page it is on. */
  read: number;
  onOpen: (entity: BrainEntityListed) => void;
  onChanged: () => void;
  onCorrect: (memory: BrainMemoryShown, opener: HTMLElement) => void;
}) => {
  const attributeLabel = useAttributeLabel();
  const { first, items: facts, next } = contested;
  if (first === undefined) {
    return null;
  }
  if (first.state !== "ready") {
    return <NotLoaded page={first} />;
  }
  // A page can hold no fact and still have more after it.
  if (facts.length === 0 && next === null) {
    return (
      <p className="text-muted-foreground text-sm">
        <Trans>Nothing you may read is disputed.</Trans>
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-3">
        {facts.map((fact) => (
          <li key={keyOfFact(fact)}>
            <Card size="sm">
              <CardContent>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Button
                    onClick={() => {
                      onOpen(fact.about);
                    }}
                    size="sm"
                    type="button"
                    variant="link"
                  >
                    <EntityName entity={fact.about} />
                  </Button>
                  <span className="font-medium">
                    {attributeLabel(fact.attribute)}
                  </span>
                </div>
                <ItemGroup render={<ul />} spacing="tight">
                  {fact.sides.map((side) => (
                    <li key={memoryKeyOf(side)}>
                      <MemoryLine
                        memory={side}
                        onChanged={onChanged}
                        onCorrect={onCorrect}
                        read={read}
                      />
                    </li>
                  ))}
                </ItemGroup>
                {fact.more ? (
                  <p className="text-muted-foreground text-xs">
                    <Trans>
                      More sources say other things: open it to see them all.
                    </Trans>
                  </p>
                ) : null}
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
      <ShowMore listing={contested} />
    </div>
  );
};

/** The facts sources disagree on, as read at `changes`. */
const useContested = (changes: number) =>
  usePaged(
    `contested#${changes}`,
    "contested",
    async (memories, next?: BrainMemoryPageNext) => {
      const page = await memories.contested(next);
      return { items: page.facts, next: page.next };
    },
    keyOfFact
  );

/** The entities of `kind`, as read at `changes`. */
const useEntities = (kind: BrainEntityKind, changes: number) =>
  usePaged(
    `entities#${kind}#${changes}`,
    `entities#${kind}`,
    async (memories, next?: BrainMemoryPageNext) => {
      const page = await memories.entities(kind, next);
      return { items: page.entities, next: page.next };
    },
    ({ entity }: BrainEntityListed) => keyOf(entity)
  );

/** The entities of a kind the person may see, a page at a time: their own first. */
const EntityList = ({
  entities,
  picked,
  onPick,
}: {
  entities: ReturnType<typeof useEntities>;
  picked: BrainEntityRef | undefined;
  onPick: (entity: BrainEntityListed) => void;
}) => {
  const { first, items } = entities;
  if (first === undefined) {
    return null;
  }
  if (first.state !== "ready") {
    return <NotLoaded page={first} />;
  }
  if (items.length === 0 && entities.next === null) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>
            <Trans>Nothing of this kind you may read yet</Trans>
          </EmptyTitle>
          <EmptyDescription>
            <Trans>
              What the Brain learns from sources and from what you tell it shows
              here.
            </Trans>
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <ItemGroup render={<ul />} spacing="tight">
        {items.map((each) => (
          <li key={keyOf(each.entity)}>
            <Item
              onClick={() => {
                onPick(each);
              }}
              render={
                // oxlint-disable-next-line jsx-a11y/control-has-associated-label -- the entity's name and labels are its words, as the Item's children
                <button
                  aria-pressed={
                    picked !== undefined && sameEntity(picked, each.entity)
                  }
                  type="button"
                />
              }
              size="sm"
            >
              <ItemContent>
                <span className="text-sm">
                  <EntityName entity={each} />
                </span>
                {each.entity.store === "own" ? (
                  <span className="flex">
                    <Badge variant="outline">
                      <Trans context="a memory nobody else may read">
                        Only you
                      </Trans>
                    </Badge>
                  </span>
                ) : null}
              </ItemContent>
            </Item>
          </li>
        ))}
      </ItemGroup>
      <ShowMore listing={entities} />
    </div>
  );
};

/**
 * Opens a share of a memory about `entity` (`onShare`), named as the
 * panel names it: none for an entity it can't name as the person may
 * read it now, nor one about a person (core's `publishAs` takes neither).
 */
const shareFor = (
  entity: BrainEntityListed | null | undefined,
  onShare: (
    memory: BrainMemoryShown,
    about: string,
    opener: HTMLElement
  ) => void
): ((memory: BrainMemoryShown, opener: HTMLElement) => void) | undefined => {
  const name = entity?.name ?? null;
  // Named by a shared entity it stands for (a correction made it): a name
  // others said, never shared (core's `publishAs`).
  if (
    entity === undefined ||
    entity === null ||
    name === null ||
    entity.unreadable ||
    entity.borrowed ||
    entity.kind === "person"
  ) {
    return undefined;
  }
  return (memory, opener) => {
    onShare(memory, name, opener);
  };
};

/** What the Brain remembers about one entity that the person may read, history included. */
const EntityPanel = ({
  changes,
  entity: ref,
  onChanged,
  onCorrect,
  onShare,
}: {
  /** How many changes the person made: each reads the panel again. */
  changes: number;
  /** The open entity, by its store and id alone. */
  entity: BrainEntityRef;
  onChanged: () => void;
  onCorrect: (memory: BrainMemoryShown, opener: HTMLElement) => void;
  /** Opens the share of `memory`, about what the panel names `about`. */
  onShare: (
    memory: BrainMemoryShown,
    about: string,
    opener: HTMLElement
  ) => void;
}) => {
  const kindLabel = useKindLabel();
  const opened = keyOf(ref);
  const memories = usePaged(
    `memories#${opened}#${changes}`,
    `memories#${opened}`,
    async (read, next?: BrainStoreCursor) => {
      const page = await read.memories(ref, next);
      return { items: page.memories, next: page.next, head: page.entity };
    },
    memoryKeyOf
  );
  const heading = useId();
  const { first, head: entity, items } = memories;
  return (
    <Card render={<section aria-labelledby={heading} />} size="sm">
      <CardContent>
        {/* Named by its own read, as the person may read it now: one
            they may no longer read is named as one there isn't. One whose
            every memory they may read was forgotten names nothing, and
            its memories still come as history (brain-next's
            `retiredSql`): said so. */}
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium" id={heading}>
            {entity === null ? (
              <span className="text-muted-foreground">
                {items.length > 0 ? (
                  <Trans>Forgotten, kept as history</Trans>
                ) : (
                  <Trans>Nothing you can read</Trans>
                )}
              </span>
            ) : null}
            {entity === undefined || entity === null ? null : (
              <EntityName entity={entity} />
            )}
          </h3>
          {entity === undefined || entity === null ? null : (
            <Badge variant="secondary">{kindLabel(entity.kind)}</Badge>
          )}
          {ref.store === "own" ? (
            <Badge variant="outline">
              <Trans context="a memory nobody else may read">Only you</Trans>
            </Badge>
          ) : null}
        </div>
        {first !== undefined && first.state !== "ready" ? (
          <NotLoaded page={first} />
        ) : null}
        {first?.state === "ready" && items.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            <Trans>
              You can&apos;t read anything the Brain remembers about this.
            </Trans>
          </p>
        ) : null}
        {items.length > 0 ? (
          <ItemGroup render={<ul />} spacing="tight">
            {items.map((memory) => (
              <li key={memoryKeyOf(memory)}>
                <MemoryLine
                  memory={memory}
                  onChanged={onChanged}
                  onCorrect={onCorrect}
                  // Shared only as named here, by the panel's own read: one
                  // it can't name as the person may read it now, or one
                  // about a person, never (core's `publishAs`).
                  onShare={shareFor(entity, onShare)}
                  read={changes}
                />
              </li>
            ))}
          </ItemGroup>
        ) : null}
        <ShowMore listing={memories} />
      </CardContent>
    </Card>
  );
};

/** What the person shared and hasn't taken back, as read at `changes`. */
const useShared = (changes: number) =>
  usePaged(
    `shared#${changes}`,
    "shared",
    async (memories, next?: BrainStoreCursor) => {
      const page = await memories.shared(next);
      return { items: page.memories, next: page.next };
    },
    ({ id }: BrainSharedListed) => id
  );

/** Whom a shared memory is read by, in words: everyone, a team of theirs by name, or a team they've left. */
const AudienceLine = ({
  audience,
  teams,
}: {
  audience: BrainSharedListed["audience"];
  teams: Team[];
}) => {
  if (audience === "company") {
    return <Trans>Shared with everyone.</Trans>;
  }
  const team =
    audience === null
      ? undefined
      : teams.find(({ id }) => id === audience.team)?.name;
  return team === undefined ? (
    <Trans>Shared with a team you are no longer in.</Trans>
  ) : (
    <Trans>Shared with team {team}.</Trans>
  );
};

/** One memory the person shared: what it says while they may read it, whom with, when, and Take back. */
const SharedLine = ({
  id,
  audience,
  sharedAt,
  memory,
  teams,
  read,
  onChanged,
}: BrainSharedListed & {
  teams: Team[];
  read: number;
  onChanged: () => void;
}) => {
  const when = formatDateTime(sharedAt);
  return (
    <Item size="sm">
      <ItemContent>
        {memory === null ? (
          <span className="text-muted-foreground text-sm">
            <Trans>You can no longer read this memory.</Trans>
          </span>
        ) : (
          <span className="text-sm whitespace-pre-wrap">
            {memory.statement}
          </span>
        )}
        <span className="text-muted-foreground flex flex-wrap gap-2 text-xs">
          <span>
            <AudienceLine audience={audience} teams={teams} />
          </span>
          <span>
            <Trans>Shared {when}</Trans>
          </span>
        </span>
        <span className="flex">
          <TakeBackButton
            id={id}
            onTakenBack={onChanged}
            read={read}
            statement={memory?.statement ?? null}
          />
        </span>
      </ItemContent>
    </Item>
  );
};

/**
 * What the person shared and hasn't taken back, each with whom it is
 * shared with and Take back: what it says only while they may read it.
 */
const SharedList = ({
  shared,
  teams,
  read,
  onChanged,
}: {
  shared: ReturnType<typeof useShared>;
  teams: Team[];
  /** The read of the page it is on. */
  read: number;
  onChanged: () => void;
}) => {
  const { first, items, next } = shared;
  if (first === undefined) {
    return null;
  }
  if (first.state !== "ready") {
    return <NotLoaded page={first} />;
  }
  if (items.length === 0 && next === null) {
    return (
      <p className="text-muted-foreground text-sm">
        <Trans>You haven&apos;t shared any of your memories.</Trans>
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <ItemGroup render={<ul />} spacing="tight">
        {items.map(({ id, audience, sharedAt, memory }) => (
          <li key={id}>
            <SharedLine
              audience={audience}
              id={id}
              memory={memory}
              onChanged={onChanged}
              read={read}
              sharedAt={sharedAt}
              teams={teams}
            />
          </li>
        ))}
      </ItemGroup>
      <ShowMore listing={shared} />
    </div>
  );
};

/** The Brain's memories page: what sources disagree on, and what the Brain remembers, by kind. */
export const MemoriesPage = ({
  teams,
  open,
}: {
  teams: Team[];
  /** An entity to open first, of its kind (a link from another page). */
  open?: { entity: BrainEntityRef; kind: BrainEntityKind };
}) => {
  const kindLabel = useKindLabel();
  const [kind, setKind] = useState<BrainEntityKind>(open?.kind ?? "customer");
  // The open entity, by its store and id alone: its panel names it from
  // its own read, as the person may read it now.
  const [opened, setOpened] = useState<BrainEntityRef | undefined>(
    open?.entity
  );
  // The correction being made, apart from the row that opened it: each
  // opening is one correction (`CorrectDialog`).
  const [correcting, setCorrecting] = useState<{
    memory: BrainMemoryShown;
    opening: string;
    returnTo: HTMLElement;
  }>();
  const correct = (memory: BrainMemoryShown, opener: HTMLElement) => {
    setCorrecting({ memory, opening: crypto.randomUUID(), returnTo: opener });
  };
  // The share being made, apart from the row that opened it: each opening
  // is one share (`ShareDialog`).
  const [sharing, setSharing] = useState<{
    memory: BrainMemoryShown;
    about: string;
    opening: string;
    returnTo: HTMLElement;
  }>();
  // Each change the person makes reads everything again, in place, so
  // what they confirmed or corrected shows where it now stands, and an
  // action still running elsewhere on the page keeps its state. Counted
  // from the latest count: two changes at once are two reads.
  const [changes, setChanges] = useState(0);
  const changed = () => {
    setChanges((count) => count + 1);
  };
  const contested = useContested(changes);
  const entities = useEntities(kind, changes);
  const shared = useShared(changes);
  // Which entity is the person themselves: theirs to ask alone. Read again
  // with each change, as their first memory about themselves makes it.
  const { loaded: ownRead } = useHeldCoreRead(
    `own-entity#${changes}`,
    async (session) => await session.brainMemories.ownEntity(),
    "own-entity"
  );
  const own = ownRead?.state === "ready" ? ownRead.data : null;
  const contestedHeading = useId();
  const sharedHeading = useId();
  const entitiesHeading = useId();
  const kindId = useId();
  return (
    <OwnEntity value={own}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="pb-chat mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 pt-8 md:px-12">
          <PageHeader>
            <PageHeaderTitle>
              <Trans context="the Brain's memories page">Memories</Trans>
            </PageHeaderTitle>
            <PageHeaderDescription>
              <Trans>
                What the Brain remembers that you may read, where each memory
                came from, and where sources disagree.
              </Trans>
            </PageHeaderDescription>
          </PageHeader>
          <p className="text-muted-foreground text-sm">
            <Trans>
              Those marked Only you are yours alone: nobody else sees them,
              admins included.
            </Trans>
          </p>
          <section
            aria-labelledby={contestedHeading}
            className="flex flex-col gap-3"
          >
            <h2 className="text-sm font-medium" id={contestedHeading}>
              <Trans>Where sources disagree</Trans>
            </h2>
            <ContestedList
              contested={contested}
              onChanged={changed}
              onCorrect={correct}
              onOpen={(entity) => {
                setKind(entity.kind);
                setOpened(entity.entity);
              }}
              read={changes}
            />
          </section>
          <section
            aria-labelledby={entitiesHeading}
            className="flex flex-col gap-3"
          >
            <h2 className="text-sm font-medium" id={entitiesHeading}>
              <Trans>What the Brain remembers</Trans>
            </h2>
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor={kindId}>
                <Trans>Kind</Trans>
              </FieldLabel>
              <NativeSelect
                id={kindId}
                onChange={(event) => {
                  const picked = brainEntityKinds.find(
                    (each) => each === event.target.value
                  );
                  if (picked !== undefined) {
                    setKind(picked);
                    setOpened(undefined);
                  }
                }}
                value={kind}
              >
                {brainEntityKinds.map((each) => (
                  <NativeSelectOption key={each} value={each}>
                    {kindLabel(each)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="grid min-h-0 gap-6 lg:grid-cols-2">
              <EntityList
                entities={entities}
                onPick={(entity) => {
                  setOpened(entity.entity);
                }}
                picked={opened}
              />
              {opened === undefined ? null : (
                <EntityPanel
                  changes={changes}
                  entity={opened}
                  key={keyOf(opened)}
                  onChanged={changed}
                  onCorrect={correct}
                  onShare={(memory, about, opener) => {
                    setSharing({
                      memory,
                      about,
                      opening: crypto.randomUUID(),
                      returnTo: opener,
                    });
                  }}
                />
              )}
            </div>
          </section>
          <section
            aria-labelledby={sharedHeading}
            className="flex flex-col gap-3"
          >
            <h2 className="text-sm font-medium" id={sharedHeading}>
              <Trans>What you shared</Trans>
            </h2>
            <SharedList
              onChanged={changed}
              read={changes}
              shared={shared}
              teams={teams}
            />
          </section>
        </div>
        {correcting === undefined ? null : (
          <CorrectDialog
            key={correcting.opening}
            memory={correcting.memory}
            onClose={() => {
              setCorrecting(undefined);
            }}
            onCorrected={changed}
            opening={correcting.opening}
            returnTo={correcting.returnTo}
          />
        )}
        {sharing === undefined ? null : (
          <ShareDialog
            about={sharing.about}
            key={sharing.opening}
            memory={sharing.memory}
            onClose={() => {
              setSharing(undefined);
            }}
            onShared={changed}
            opening={sharing.opening}
            returnTo={sharing.returnTo}
          />
        )}
      </div>
    </OwnEntity>
  );
};
