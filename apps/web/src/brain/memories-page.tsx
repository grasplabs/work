import type {
  BrainContestedFact,
  BrainEntityKind,
  BrainEntityListed,
  BrainEntityRef,
  BrainMemoryAttribute,
  BrainMemoryPageNext,
  BrainMemoryShown,
  BrainStoreCursor,
} from "@grasp-os/shared/brain-memories";
import {
  brainCorrectionMaxLength,
  brainEntityKinds,
} from "@grasp-os/shared/brain-memories";
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
import { useId, useRef, useState } from "react";

import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { NotLoaded } from "../load-from-core.tsx";
import { useAsk, usePaged } from "./memories-asks.ts";

// The Brain's memories, from the new Brain (GRA-1746): the facts sources
// disagree on, each with its sides and a way to confirm one; the entities
// the person may see, by kind, a page at a time; and what the Brain
// remembers about one, history included, each memory with where it came
// from, and a way to say it is wrong. Core answers each from what they
// may read alone; what is theirs alone is marked so, as on the Sources
// page. Texts are shown as text, never markup.

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

/** One memory: what it says, where it came from, its marks, and what the person can do. */
const MemoryLine = ({
  memory,
  read,
  onChanged,
  onCorrect,
}: {
  memory: BrainMemoryShown;
  /** The read of the page it is on. */
  read: number;
  onChanged: () => void;
  /** Opens the correction of `memory`, which the page holds, from `opener`. */
  onCorrect: (memory: BrainMemoryShown, opener: HTMLElement) => void;
}) => {
  const { t } = useLingui();
  const { statement } = memory;
  const attributeLabel = useAttributeLabel();
  const { attribute, object, value, endedAt, confirmed } = memory;
  const label = attribute === null ? null : attributeLabel(attribute);
  // What it holds: its value, or the entity a relation names.
  let held: string | null = value;
  if (object !== null) {
    held = object.name ?? t`something without a name`;
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
          {label === null ? null : (
            <span className="text-sm">
              {held === null ? (
                <span className="font-medium">{label}</span>
              ) : (
                <Trans>
                  <span className="font-medium">{label}</span>: {held}
                </Trans>
              )}
            </span>
          )}
          {memory.statement === held ? null : (
            <span className="text-sm whitespace-pre-wrap">
              {memory.statement}
            </span>
          )}
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
          </span>
        ) : null}
      </ItemContent>
    </Item>
  );
};

/**
 * An entity's name, or a word for one without: one a correction of theirs
 * stands for that they may no longer read, or one with no name.
 */
const EntityName = ({ entity }: { entity: BrainEntityListed }) => {
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

/** What the Brain remembers about one entity that the person may read, history included. */
const EntityPanel = ({
  changes,
  entity: ref,
  onChanged,
  onCorrect,
}: {
  /** How many changes the person made: each reads the panel again. */
  changes: number;
  /** The open entity, by its store and id alone. */
  entity: BrainEntityRef;
  onChanged: () => void;
  onCorrect: (memory: BrainMemoryShown, opener: HTMLElement) => void;
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
            they may no longer read is named as one there isn't. */}
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium" id={heading}>
            {entity === null ? (
              <span className="text-muted-foreground">
                <Trans>Nothing you can read</Trans>
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

/** The Brain's memories page: what sources disagree on, and what the Brain remembers, by kind. */
export const MemoriesPage = () => {
  const kindLabel = useKindLabel();
  const [kind, setKind] = useState<BrainEntityKind>("customer");
  // The open entity, by its store and id alone: its panel names it from
  // its own read, as the person may read it now.
  const [opened, setOpened] = useState<BrainEntityRef>();
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
  const contestedHeading = useId();
  const entitiesHeading = useId();
  const kindId = useId();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="pb-chat mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 pt-8 md:px-12">
        <PageHeader>
          <PageHeaderTitle>
            <Trans context="the Brain's memories page">Memories</Trans>
          </PageHeaderTitle>
          <PageHeaderDescription>
            <Trans>
              What the Brain remembers that you may read, where each memory came
              from, and where sources disagree.
            </Trans>
          </PageHeaderDescription>
        </PageHeader>
        <p className="text-muted-foreground text-sm">
          <Trans>
            Those marked Only you are yours alone: nobody else sees them, admins
            included.
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
              />
            )}
          </div>
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
    </div>
  );
};
