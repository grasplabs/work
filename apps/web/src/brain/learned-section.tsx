import type {
  BrainEntityListed,
  BrainMemoryShown,
} from "@grasp-os/shared/brain-memories";
import type {
  BrainLearned,
  BrainLearnedMemory,
  BrainSourceRef,
} from "@grasp-os/shared/brain-sources";
import { failureText } from "@grasp-os/shared/errors";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Item, ItemContent, ItemGroup } from "@grasp-os/ui/components/item";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { Plural, Trans } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { ErrorText } from "../error-text.tsx";
import { useCore } from "../use-core.ts";

// What the Brain learned from one version of a source (GRA-1991), on the
// Sources page under the version's text: what it added, what it replaced
// (memories of earlier versions it ended) and what it added that another
// source disagrees with, with what that source says. Core reads it as the
// person may read it (`session.brainSources.learned`): what they may not
// read is none of it. Each memory names the entity it is about, which
// opens on the Memories page, marked New where this version is where the
// person first saw it.

/**
 * What reading it came to: loading, refused, its pages so far; none (core
 * answers none of the version: the section isn't shown); or gone (a later
 * page answered none: the source was erased, or the reader may no longer
 * read it, since the first page, which core can't tell apart and neither
 * does the page: what was loaded goes too).
 */
type Learned =
  | { state: "loading" }
  | { state: "refused"; message: string }
  | { state: "ready"; pages: BrainLearned[] }
  | { state: "none" }
  | { state: "gone" };

/** A page of it after `next`, or why not. Outside the component, as the React Compiler can't compile `try`. */
const pageOf = async (
  core: CoreConnection,
  source: BrainSourceRef,
  version: number,
  next?: BrainLearned["next"]
): Promise<{ page: BrainLearned | null } | { refused: string }> => {
  try {
    const page = await core.withSession(
      async (session) =>
        await session.brainSources.learned(source, version, next)
    );
    return { page };
  } catch (error) {
    return { refused: failureText(error) };
  }
};

/** An entity a memory names, as a link to its page, marked New when this version made it seen. */
const EntityLink = ({
  id,
  entities,
}: {
  id: string;
  entities: ReadonlyMap<string, BrainEntityListed & { firstSeen: boolean }>;
}) => {
  const about = entities.get(id);
  if (about === undefined || about.name === null) {
    return null;
  }
  return (
    <span className="flex items-center gap-1.5">
      <Button
        nativeButton={false}
        render={
          <Link
            search={{
              store: about.entity.store,
              entity: about.entity.id,
              kind: about.kind,
            }}
            to="/brain/memories"
          />
        }
        size="inline"
        variant="link"
      >
        {about.name}
      </Button>
      {about.firstSeen ? (
        <Badge variant="secondary">
          <Trans context="an entity the Brain first saw in this version">
            New
          </Trans>
        </Badge>
      ) : null}
    </span>
  );
};

/** The entities a memory names, about and related to, as links. */
const EntityLinks = ({
  memory,
  entities,
}: {
  memory: BrainMemoryShown;
  entities: ReadonlyMap<string, BrainEntityListed & { firstSeen: boolean }>;
}) => (
  <span className="flex flex-wrap items-center gap-3">
    <EntityLink entities={entities} id={memory.about} />
    {memory.object === null ? null : (
      <EntityLink entities={entities} id={memory.object.id} />
    )}
  </span>
);

/** One list of the change: memories with their entities, and for a contested one what another source says. */
const LearnedList = ({
  heading,
  memories,
  entities,
  withRivals = false,
}: {
  heading: ReactNode;
  memories: BrainLearnedMemory[];
  entities: ReadonlyMap<string, BrainEntityListed & { firstSeen: boolean }>;
  withRivals?: boolean;
}) => {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <h5 className="text-sm" id={id}>
        {heading}
      </h5>
      <ItemGroup aria-labelledby={id} render={<ul />} spacing="tight">
        {memories.map(({ memory, rivals, moreRivals }) => (
          <li key={`${memory.store}:${memory.id}`}>
            <Item size="xs" variant="outline">
              <ItemContent>
                <span className="text-sm">{memory.statement}</span>
                <EntityLinks entities={entities} memory={memory} />
                {withRivals
                  ? rivals.map((rival) => {
                      const said = rival.statement;
                      return (
                        <span className="flex flex-col gap-1" key={rival.id}>
                          <span className="text-muted-foreground text-xs">
                            <Trans>Another source says: {said}</Trans>
                          </span>
                          <EntityLinks entities={entities} memory={rival} />
                        </span>
                      );
                    })
                  : null}
                {withRivals && moreRivals ? (
                  <span className="text-muted-foreground text-xs">
                    <Trans>More sources say something else.</Trans>
                  </span>
                ) : null}
              </ItemContent>
            </Item>
          </li>
        ))}
      </ItemGroup>
    </div>
  );
};

/** What the Brain learned from `version` of `source`, as the person may read it. */
export const LearnedSection = ({
  source,
  version,
}: {
  source: BrainSourceRef;
  version: number;
}) => {
  const core = useCore();
  const heading = useId();
  const [learned, setLearned] = useState<Learned>({ state: "loading" });
  // A further page being read, or why it was refused.
  const [more, setMore] = useState<
    { state: "loading" } | { state: "refused"; message: string }
  >();
  useEffect(() => {
    let left = false;
    const read = async (): Promise<void> => {
      const answer = await pageOf(core, source, version);
      if (left) {
        return;
      }
      if ("refused" in answer) {
        setLearned({ state: "refused", message: answer.refused });
      } else if (answer.page === null) {
        setLearned({ state: "none" });
      } else {
        setLearned({ state: "ready", pages: [answer.page] });
      }
    };
    void read();
    return () => {
      left = true;
    };
  }, [core, source, version]);

  if (learned.state === "none") {
    return null;
  }
  const pages = learned.state === "ready" ? learned.pages : [];
  const memories = pages.flatMap((page) => page.memories);
  const entities = new Map(
    pages.flatMap((page) =>
      page.entities.map((entity) => [entity.entity.id, entity] as const)
    )
  );
  const added = memories.filter(({ part }) => part === "added");
  const ended = memories.filter(({ part }) => part === "ended");
  const contested = added.filter(({ memory }) => memory.contested);
  const next = pages.at(-1)?.next ?? null;
  const addedCount = added.length;
  const endedCount = ended.length;
  const contestedCount = contested.length;
  return (
    <section aria-labelledby={heading} className="flex flex-col gap-2">
      <h4 className="text-muted-foreground text-xs font-medium" id={heading}>
        <Trans>What the Brain learned from this version</Trans>
      </h4>
      {learned.state === "gone" ? (
        <p className="text-muted-foreground text-sm">
          <Trans>
            You can no longer read what the Brain learned from this version.
          </Trans>
        </p>
      ) : null}
      {learned.state === "loading" ? <Spinner /> : null}
      {learned.state === "refused" ? (
        <ErrorText>{learned.message}</ErrorText>
      ) : null}
      {learned.state === "ready" && memories.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          <Trans>
            The Brain hasn&apos;t learned anything from this version.
          </Trans>
        </p>
      ) : null}
      {addedCount > 0 ? (
        <LearnedList
          entities={entities}
          heading={
            <Plural
              one="This version added # memory."
              other="This version added # memories."
              value={addedCount}
            />
          }
          memories={added}
        />
      ) : null}
      {endedCount > 0 ? (
        <LearnedList
          entities={entities}
          heading={
            <Plural
              one="This version replaced # memory from an earlier version."
              other="This version replaced # memories from earlier versions."
              value={endedCount}
            />
          }
          memories={ended}
        />
      ) : null}
      {contestedCount > 0 ? (
        <LearnedList
          entities={entities}
          heading={
            <Plural
              one="Sources disagree on # memory this version added."
              other="Sources disagree on # memories this version added."
              value={contestedCount}
            />
          }
          memories={contested}
          withRivals
        />
      ) : null}
      {more?.state === "refused" ? <ErrorText>{more.message}</ErrorText> : null}
      {next === null ? null : (
        <Button
          className="self-start"
          disabled={more?.state === "loading"}
          onClick={() => {
            setMore({ state: "loading" });
            void (async () => {
              const answer = await pageOf(core, source, version, next);
              if ("refused" in answer) {
                setMore({ state: "refused", message: answer.refused });
                return;
              }
              setMore(undefined);
              const { page } = answer;
              // None now, after a page before: erased, or no longer theirs
              // to read, since. What was loaded goes with it, and so does
              // the cursor that would ask for it again.
              setLearned((before) => {
                if (page === null) {
                  return { state: "gone" };
                }
                return before.state === "ready"
                  ? { state: "ready", pages: [...before.pages, page] }
                  : before;
              });
            })();
          }}
          type="button"
          variant="outline"
        >
          <Trans>Show more</Trans>
        </Button>
      )}
    </section>
  );
};
