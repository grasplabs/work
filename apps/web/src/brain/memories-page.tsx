import type {
  BrainContestedFact,
  BrainContestedPage,
  BrainEntityKind,
  BrainEntityListed,
  BrainEntityPage,
  BrainEntityRef,
  BrainMemoryAttribute,
  BrainMemoryPage,
  BrainMemoryShown,
} from "@grasp-os/shared/brain-memories";
import {
  brainCorrectionMaxLength,
  brainEntityKinds,
} from "@grasp-os/shared/brain-memories";
import { failureText } from "@grasp-os/shared/errors";
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
  DialogTrigger,
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
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useId, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";

// The Brain's memories, from the new Brain (GRA-1746): the facts sources
// disagree on, each with its sides and a way to confirm one; the entities
// the person may see, by kind, a page at a time; and what the Brain
// remembers about one, history included, each memory with where it came
// from, and a way to say it is wrong. Core answers each from what they
// may read alone; what is theirs alone is marked so, as on the Sources
// page. Texts are shown as text, never markup.

type Memories = Session["brainMemories"];

/** What a read from core came to. */
type Read<T> =
  | { state: "loading" }
  | { state: "refused"; message: string }
  | { state: "ready"; data: T };

/**
 * What `read` answers on the person's session, or why not. Outside the
 * components, as the React Compiler can't compile `try`.
 */
const readFrom = async <T,>(
  core: CoreConnection,
  read: (memories: Memories) => Promise<T>
): Promise<Read<T>> => {
  try {
    const data = await core.withSession(
      async (session) => await read(session.brainMemories)
    );
    return { state: "ready", data };
  } catch (error) {
    return { state: "refused", message: failureText(error) };
  }
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
const AttributeLabel = ({ attribute }: { attribute: BrainMemoryAttribute }) => {
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
  return <span className="font-medium">{labels[attribute]}</span>;
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
  }[source.source.producer];
  return label;
};

/**
 * Says `memory` is wrong, with what is right: the person's own word,
 * theirs alone, confirmed. The correction's id is minted once, when the
 * dialog opens, so a retry saves it once.
 */
const CorrectDialog = ({
  memory,
  onCorrected,
}: {
  memory: BrainMemoryShown;
  onCorrected: () => void;
}) => {
  const { t } = useLingui();
  const ids = useId();
  const { busy, failure, run } = useCoreAction();
  const [open, setOpen] = useState(false);
  const [right, setRight] = useState("");
  const [change, setChange] = useState("");
  const [gone, setGone] = useState(false);
  const ready = right.trim() !== "";
  const correct = async (): Promise<void> => {
    const saved = await run(
      async (session) =>
        await session.brainMemories.correct({
          wrong: {
            store: memory.store,
            entity: memory.about,
            memory: memory.id,
          },
          right: right.trim(),
          change,
        })
    );
    if (saved === null) {
      setGone(true);
      return;
    }
    if (saved !== undefined) {
      setOpen(false);
      onCorrected();
    }
  };
  return (
    <Dialog
      onOpenChange={(opening) => {
        if (opening) {
          setRight("");
          setGone(false);
          setChange(crypto.randomUUID());
        }
        setOpen(opening);
      }}
      open={open}
    >
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        <Trans>It&apos;s wrong</Trans>
      </DialogTrigger>
      <DialogContent closeLabel={t`Close`}>
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
                comes first for you. What others read stays as it is.
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
                setRight(event.target.value);
              }}
              rows={3}
              value={right}
            />
            <FieldDescription>
              <Trans>In your own words, as you would tell a colleague.</Trans>
            </FieldDescription>
          </Field>
          {gone ? (
            <ErrorText>{t`This memory has changed or is no longer yours to read. Look at it again first.`}</ErrorText>
          ) : null}
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
  onConfirmed,
}: {
  memory: BrainMemoryShown;
  onConfirmed: () => void;
}) => {
  const { t } = useLingui();
  const { busy, failure, run } = useCoreAction();
  const [gone, setGone] = useState(false);
  return (
    <>
      <Button
        disabled={busy}
        onClick={() => {
          void (async () => {
            const outcome = await run(
              async (session) =>
                await session.brainMemories.confirm({
                  store: memory.store,
                  entity: memory.about,
                  memory: memory.id,
                })
            );
            if (outcome === "nothing") {
              setGone(true);
            } else if (outcome === "done") {
              onConfirmed();
            }
          })();
        }}
        size="sm"
        type="button"
        variant="outline"
      >
        <Trans>This one is right</Trans>
      </Button>
      {gone ? (
        <ErrorText>{t`This memory has changed or is no longer yours to read. Look at it again first.`}</ErrorText>
      ) : null}
      <ErrorText>{failure}</ErrorText>
    </>
  );
};

/** One memory: what it says, where it came from, its marks, and what the person can do. */
const MemoryLine = ({
  memory,
  onChanged,
}: {
  memory: BrainMemoryShown;
  onChanged: () => void;
}) => {
  const { attribute, object, value, endedAt, confirmed } = memory;
  const learned = formatDateTime(memory.learnedAt);
  const ended = endedAt === null ? null : formatDateTime(endedAt);
  const current = endedAt === null;
  return (
    <Item size="sm">
      <ItemContent>
        {attribute === null ? null : (
          <span className="text-sm">
            <AttributeLabel attribute={attribute} />
            {value === null ? null : <>: {value}</>}
            {object === null ? null : (
              <>: {object.name ?? <Trans>something without a name</Trans>}</>
            )}
          </span>
        )}
        <span className="text-sm whitespace-pre-wrap">{memory.statement}</span>
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
        {current ? (
          <span className="flex flex-wrap items-center gap-2">
            {/* Offered until the person has said this side is right. */}
            {memory.contested && confirmed?.byYou !== true ? (
              <ConfirmButton memory={memory} onConfirmed={onChanged} />
            ) : null}
            <CorrectDialog memory={memory} onCorrected={onChanged} />
          </span>
        ) : null}
      </ItemContent>
    </Item>
  );
};

/** The person's choice of `name`, or a word for an entity without one. */
const EntityName = ({ name }: { name: string | null }) =>
  name ?? (
    <span className="text-muted-foreground">
      <Trans>Without a name</Trans>
    </span>
  );

/** The facts sources disagree on that the person may read, a page at a time. */
const ContestedList = ({
  onOpen,
  onChanged,
}: {
  onOpen: (entity: BrainEntityListed) => void;
  onChanged: () => void;
}) => {
  const core = useCore();
  const [listed, setListed] = useState<Read<BrainContestedPage>>({
    state: "loading",
  });
  const [more, setMore] = useState<Read<BrainContestedPage>>();
  useEffect(() => {
    let left = false;
    const read = async (): Promise<void> => {
      const answer = await readFrom(
        core,
        async (memories) => await memories.contested()
      );
      if (!left) {
        setListed(answer);
      }
    };
    void read();
    return () => {
      left = true;
    };
  }, [core]);
  if (listed.state === "refused") {
    return <ErrorText>{listed.message}</ErrorText>;
  }
  if (listed.state === "loading") {
    return null;
  }
  const { facts, next } = listed.data;
  if (facts.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        <Trans>Nothing you may read is disputed.</Trans>
      </p>
    );
  }
  const keyOfFact = ({ about, attribute }: BrainContestedFact) =>
    `${keyOf(about.entity)}#${attribute}`;
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
                    <EntityName name={fact.about.name} />
                  </Button>
                  <AttributeLabel attribute={fact.attribute} />
                </div>
                <ItemGroup render={<ul />} spacing="tight">
                  {fact.sides.map((side) => (
                    <li key={`${side.store}:${side.id}`}>
                      <MemoryLine memory={side} onChanged={onChanged} />
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
      {more?.state === "refused" ? <ErrorText>{more.message}</ErrorText> : null}
      {next === null ? null : (
        <Button
          className="self-start"
          disabled={more?.state === "loading"}
          onClick={() => {
            setMore({ state: "loading" });
            void (async () => {
              const answer = await readFrom(
                core,
                async (memories) => await memories.contested(next)
              );
              setMore(answer.state === "refused" ? answer : undefined);
              if (answer.state === "ready") {
                setListed({
                  state: "ready",
                  data: {
                    facts: [...facts, ...answer.data.facts],
                    next: answer.data.next,
                  },
                });
              }
            })();
          }}
          type="button"
          variant="outline"
        >
          <Trans>Show more</Trans>
        </Button>
      )}
    </div>
  );
};

/** The entities of `kind` the person may see, a page at a time: their own first. */
const EntityList = ({
  kind,
  picked,
  onPick,
}: {
  kind: BrainEntityKind;
  picked: BrainEntityRef | undefined;
  onPick: (entity: BrainEntityListed) => void;
}) => {
  const core = useCore();
  const [listed, setListed] = useState<Read<BrainEntityPage>>({
    state: "loading",
  });
  const [more, setMore] = useState<Read<BrainEntityPage>>();
  useEffect(() => {
    let left = false;
    const read = async (): Promise<void> => {
      const answer = await readFrom(
        core,
        async (memories) => await memories.entities(kind)
      );
      if (!left) {
        setListed(answer);
      }
    };
    void read();
    return () => {
      left = true;
    };
  }, [core, kind]);
  if (listed.state === "refused") {
    return <ErrorText>{listed.message}</ErrorText>;
  }
  if (listed.state === "loading") {
    return null;
  }
  const { entities, next } = listed.data;
  if (entities.length === 0) {
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
        {entities.map((each) => (
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
                  <EntityName name={each.name} />
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
      {more?.state === "refused" ? <ErrorText>{more.message}</ErrorText> : null}
      {next === null ? null : (
        <Button
          className="self-start"
          disabled={more?.state === "loading"}
          onClick={() => {
            setMore({ state: "loading" });
            void (async () => {
              const answer = await readFrom(
                core,
                async (memories) => await memories.entities(kind, next)
              );
              setMore(answer.state === "refused" ? answer : undefined);
              if (answer.state === "ready") {
                setListed({
                  state: "ready",
                  data: {
                    entities: [...entities, ...answer.data.entities],
                    next: answer.data.next,
                  },
                });
              }
            })();
          }}
          type="button"
          variant="outline"
        >
          <Trans>Show more</Trans>
        </Button>
      )}
    </div>
  );
};

/** What the Brain remembers about one entity that the person may read, history included. */
const EntityPanel = ({
  entity,
  onChanged,
}: {
  entity: BrainEntityListed;
  onChanged: () => void;
}) => {
  const core = useCore();
  const kindLabel = useKindLabel();
  const [page, setPage] = useState<Read<BrainMemoryPage>>({
    state: "loading",
  });
  const [more, setMore] = useState<Read<BrainMemoryPage>>();
  const ref = entity.entity;
  useEffect(() => {
    let left = false;
    const read = async (): Promise<void> => {
      const answer = await readFrom(
        core,
        async (memories) => await memories.memories(ref)
      );
      if (!left) {
        setPage(answer);
      }
    };
    void read();
    return () => {
      left = true;
    };
  }, [core, ref]);
  const heading = useId();
  const kind = kindLabel(entity.kind);
  return (
    <Card render={<section aria-labelledby={heading} />} size="sm">
      <CardContent>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium" id={heading}>
            <EntityName name={entity.name} />
          </h3>
          <Badge variant="secondary">{kind}</Badge>
          {ref.store === "own" ? (
            <Badge variant="outline">
              <Trans context="a memory nobody else may read">Only you</Trans>
            </Badge>
          ) : null}
        </div>
        {page.state === "refused" ? (
          <ErrorText>{page.message}</ErrorText>
        ) : null}
        {page.state === "ready" && page.data.memories.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            <Trans>
              You can&apos;t read anything the Brain remembers about this.
            </Trans>
          </p>
        ) : null}
        {page.state === "ready" && page.data.memories.length > 0 ? (
          <ItemGroup render={<ul />} spacing="tight">
            {page.data.memories.map((memory) => (
              <li key={`${memory.store}:${memory.id}`}>
                <MemoryLine memory={memory} onChanged={onChanged} />
              </li>
            ))}
          </ItemGroup>
        ) : null}
        {more?.state === "refused" ? (
          <ErrorText>{more.message}</ErrorText>
        ) : null}
        {page.state === "ready" && page.data.next !== null ? (
          <Button
            className="self-start"
            disabled={more?.state === "loading"}
            onClick={() => {
              const { memories, next } = page.data;
              setMore({ state: "loading" });
              void (async () => {
                const answer = await readFrom(
                  core,
                  async (read) => await read.memories(ref, next)
                );
                setMore(answer.state === "refused" ? answer : undefined);
                if (answer.state === "ready") {
                  setPage({
                    state: "ready",
                    data: {
                      memories: [...memories, ...answer.data.memories],
                      next: answer.data.next,
                    },
                  });
                }
              })();
            }}
            type="button"
            variant="outline"
          >
            <Trans>Show more</Trans>
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
};

/** The Brain's memories page: what sources disagree on, and what the Brain remembers, by kind. */
export const MemoriesPage = () => {
  const kindLabel = useKindLabel();
  const [kind, setKind] = useState<BrainEntityKind>("customer");
  const [opened, setOpened] = useState<BrainEntityListed>();
  // Each change the person makes reads everything again, so what they
  // confirmed or corrected shows where it now stands.
  const [changes, setChanges] = useState(0);
  const changed = () => {
    setChanges(changes + 1);
  };
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
            key={changes}
            onChanged={changed}
            onOpen={(entity) => {
              setKind(entity.kind);
              setOpened(entity);
            }}
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
            <label className="text-sm" htmlFor={kindId}>
              <Trans>Kind</Trans>
            </label>
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
              key={`${kind}#${changes}`}
              kind={kind}
              onPick={setOpened}
              picked={opened?.entity}
            />
            {opened === undefined ? null : (
              <EntityPanel
                entity={opened}
                key={`${keyOf(opened.entity)}#${changes}`}
                onChanged={changed}
              />
            )}
          </div>
        </section>
      </div>
    </div>
  );
};
