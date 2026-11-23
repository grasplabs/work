import type {
  BrainEntityListed,
  BrainMemoryShown,
} from "@grasp-os/shared/brain-memories";
import type {
  BrainLearned,
  BrainLearnedMemory,
  BrainSourceRef,
} from "@grasp-os/shared/brain-sources";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Heading } from "@grasp-os/ui/components/heading";
import { Item, ItemContent, ItemGroup } from "@grasp-os/ui/components/item";
import { Link } from "@grasp-os/ui/components/link";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { Text } from "@grasp-os/ui/components/text";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link as RouterLink } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { NotLoadedState } from "../frame/page-states.tsx";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";

// What the Brain learned from one version of a source (GRA-1991), on the
// Sources page under the version's text: what it added, what it replaced
// (memories of earlier versions a memory of it ended), for the current
// version what is no longer in the source's text (credited to no version),
// and what it added that another memory contradicts, with what that one
// says: another source's, or someone's own word, so the words name no
// source. Core reads it as the
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
  | { state: "failed"; page: NotReady }
  | { state: "ready"; pages: BrainLearned[] }
  | { state: "none" }
  | { state: "gone" };

/** A read that came back without its data. */
type NotReady = Exclude<Loaded<unknown>, { state: "ready" }>;

/** A page of it after `next`, or why not. */
const pageOf = async (
  core: CoreConnection,
  source: BrainSourceRef,
  version: number,
  next?: BrainLearned["next"],
  signal?: AbortSignal
): Promise<Loaded<BrainLearned | null>> =>
  await loadFromCore(
    core,
    async (session) =>
      await session.brainSources.learned(source, version, next),
    signal
  );

const styles = stylex.create({
  section: { display: "flex", flexDirection: "column", gap: space["2"] },
  list: { display: "flex", flexDirection: "column", gap: space["1"] },
  said: { display: "flex", flexDirection: "column", gap: space["1"] },
  row: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["3"],
  },
  entity: { display: "flex", alignItems: "center", gap: space["1"] },
  start: { alignSelf: "flex-start" },
});

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
    <span {...stylex.props(styles.entity)}>
      <Link asChild variant="plain">
        <RouterLink
          search={{
            store: about.entity.store,
            entity: about.entity.id,
            kind: about.kind,
          }}
          to="/brain/memories"
        >
          {about.name}
        </RouterLink>
      </Link>
      {about.firstSeen ? (
        <Badge size="sm">
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
  <Text as="span" size="sm">
    <span {...stylex.props(styles.row)}>
      <EntityLink entities={entities} id={memory.about} />
      {memory.object === null ? null : (
        <EntityLink entities={entities} id={memory.object.id} />
      )}
    </span>
  </Text>
);

/** One list of the change: memories with their entities, and for a contested one what another source says. */
const LearnedList = ({
  heading,
  memories,
  entities,
  withRivals = false,
}: {
  heading: string;
  memories: BrainLearnedMemory[];
  entities: ReadonlyMap<string, BrainEntityListed & { firstSeen: boolean }>;
  withRivals?: boolean;
}) => (
  <div {...stylex.props(styles.list)}>
    <Text size="sm" weight="medium">
      {heading}
    </Text>
    <ItemGroup aria-label={heading}>
      {memories.map(({ memory, rivals, moreRivals }) => (
        <Item key={`${memory.store}:${memory.id}`} size="sm" variant="outline">
          <ItemContent>
            <Text as="span" size="sm">
              {memory.statement}
            </Text>
            <EntityLinks entities={entities} memory={memory} />
            {withRivals
              ? rivals.map((rival) => {
                  const said = rival.statement;
                  return (
                    <span key={rival.id} {...stylex.props(styles.said)}>
                      <Text as="span" size="xs" color="muted">
                        <Trans>Contradicted by: {said}</Trans>
                      </Text>
                      <EntityLinks entities={entities} memory={rival} />
                    </span>
                  );
                })
              : null}
            {withRivals && moreRivals ? (
              <Text as="span" size="xs" color="muted">
                <Trans>More memories contradict it.</Trans>
              </Text>
            ) : null}
          </ItemContent>
        </Item>
      ))}
    </ItemGroup>
  </div>
);

/** The headings of the lists of the change, counting what is shown: "so far" while more pages follow. */
const useListHeadings = () => {
  const { t } = useLingui();
  return {
    added: (memories: number, partial: boolean): string =>
      partial
        ? t`${plural(memories, {
            one: "So far, this version added # memory.",
            other: "So far, this version added # memories.",
          })}`
        : t`${plural(memories, {
            one: "This version added # memory.",
            other: "This version added # memories.",
          })}`,
    ended: (memories: number, partial: boolean): string =>
      partial
        ? t`${plural(memories, {
            one: "So far, this version replaced # memory from an earlier version.",
            other:
              "So far, this version replaced # memories from earlier versions.",
          })}`
        : t`${plural(memories, {
            one: "This version replaced # memory from an earlier version.",
            other: "This version replaced # memories from earlier versions.",
          })}`,
    out: (memories: number, partial: boolean): string =>
      partial
        ? t`${plural(memories, {
            one: "So far, # memory from an earlier version is no longer in this source.",
            other:
              "So far, # memories from earlier versions are no longer in this source.",
          })}`
        : t`${plural(memories, {
            one: "# memory from an earlier version is no longer in this source.",
            other:
              "# memories from earlier versions are no longer in this source.",
          })}`,
    contested: (memories: number, partial: boolean): string =>
      partial
        ? t`${plural(memories, {
            one: "So far, # memory this version added is contradicted elsewhere.",
            other:
              "So far, # memories this version added are contradicted elsewhere.",
          })}`
        : t`${plural(memories, {
            one: "# memory this version added is contradicted elsewhere.",
            other: "# memories this version added are contradicted elsewhere.",
          })}`,
  };
};

/** What the Brain learned from `version` of `source`, as the person may read it. */
export const LearnedSection = ({
  source,
  version,
}: {
  source: BrainSourceRef;
  version: number;
}) => {
  const { t } = useLingui();
  const headings = useListHeadings();
  const core = useCore();
  const heading = useId();
  const [learned, setLearned] = useState<Learned>({ state: "loading" });
  // A further page being read, or why it was refused.
  const [more, setMore] = useState<
    { state: "loading" } | { state: "failed"; page: NotReady }
  >();
  // Counts the tries, so Try again reads the first page again.
  const [tried, setTried] = useState(0);
  useEffect(() => {
    const left = new AbortController();
    const read = async (): Promise<void> => {
      const answer = await pageOf(
        core,
        source,
        version,
        undefined,
        left.signal
      );
      if (left.signal.aborted) {
        return;
      }
      if (answer.state !== "ready") {
        setLearned({ state: "failed", page: answer });
      } else if (answer.data === null) {
        setLearned({ state: "none" });
      } else {
        setLearned({ state: "ready", pages: [answer.data] });
      }
    };
    void read();
    return () => {
      left.abort();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `tried` says when to read again
  }, [core, source, version, tried]);

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
  const out = memories.filter(({ part }) => part === "out");
  const contested = added.filter(({ memory }) => memory.contested);
  const next = pages.at(-1)?.next ?? null;
  // While more pages follow, each count is of what is shown so far, and
  // says so.
  const partial = next !== null;
  return (
    <section aria-labelledby={heading} {...stylex.props(styles.section)}>
      <Heading id={heading} level={4} size="2xs">
        <Trans>What the Brain learned from this version</Trans>
      </Heading>
      {learned.state === "gone" ? (
        <Text size="sm" color="muted">
          <Trans>
            You can no longer read what the Brain learned from this version.
          </Trans>
        </Text>
      ) : null}
      {learned.state === "loading" ? <Spinner aria-label={t`Loading`} /> : null}
      {learned.state === "failed" ? (
        <NotLoadedState
          again={() => {
            setTried(tried + 1);
          }}
          heading="h3"
          page={learned.page}
        />
      ) : null}
      {learned.state === "ready" && memories.length === 0 ? (
        <Text size="sm" color="muted">
          <Trans>
            The Brain hasn&apos;t learned anything from this version.
          </Trans>
        </Text>
      ) : null}
      {added.length > 0 ? (
        <LearnedList
          entities={entities}
          heading={headings.added(added.length, partial)}
          memories={added}
        />
      ) : null}
      {ended.length > 0 ? (
        <LearnedList
          entities={entities}
          heading={headings.ended(ended.length, partial)}
          memories={ended}
        />
      ) : null}
      {out.length > 0 ? (
        <LearnedList
          entities={entities}
          heading={headings.out(out.length, partial)}
          memories={out}
        />
      ) : null}
      {contested.length > 0 ? (
        <LearnedList
          entities={entities}
          heading={headings.contested(contested.length, partial)}
          memories={contested}
          withRivals
        />
      ) : null}
      {more?.state === "failed" ? <NotLoaded page={more.page} /> : null}
      {next === null ? null : (
        <div {...stylex.props(styles.start)}>
          <Button
            disabled={more?.state === "loading"}
            onClick={() => {
              setMore({ state: "loading" });
              void (async () => {
                const answer = await pageOf(core, source, version, next);
                if (answer.state !== "ready") {
                  setMore({ state: "failed", page: answer });
                  return;
                }
                setMore(undefined);
                const page = answer.data;
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
            size="sm"
            variant="ghost"
          >
            {t`Show more`}
          </Button>
        </div>
      )}
    </section>
  );
};
