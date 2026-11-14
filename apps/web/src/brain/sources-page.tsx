import type { Connection } from "@grasp-os/shared/brain";
import type {
  BrainFoundBy,
  BrainMemoryFoundBy,
  BrainSearchMemory,
  BrainSearchPack,
  BrainSourceListed,
  BrainSourcePage,
  BrainSourceProducer,
  BrainSourceRef,
  BrainSourceText,
  BrainSourceVersionPage,
} from "@grasp-os/shared/brain-sources";
import {
  brainQuestionMaxLength,
  firstLineOf,
} from "@grasp-os/shared/brain-sources";
import { failureText } from "@grasp-os/shared/errors";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import { Card, CardContent } from "@grasp-os/ui/components/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@grasp-os/ui/components/collapsible";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { Input } from "@grasp-os/ui/components/input";
import { Item, ItemContent, ItemGroup } from "@grasp-os/ui/components/item";
import {
  PageHeader,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@grasp-os/ui/components/page-header";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useId, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime, formatList } from "../format.ts";
import { useCore } from "../use-core.ts";
import { OwnExportSection } from "./own-export.tsx";

// The Brain's sources, from the new Brain (GRA-1734): what the person may
// read, a page at a time, newest first; one source's versions and text;
// search, which is recall as that person, shown as recall packs it (no
// ranking of the page's own), its memories each with where it came from,
// and everything the pack holds shown, as its budget was spent on it; and
// how each of their connections feeds the Brain today. Core answers each
// from what they may read alone. Texts are shown as text, never markup.
// At its foot, the person's own export of what only they may read
// (own-export.tsx).

type Sources = Session["brainSources"];

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
  read: (sources: Sources) => Promise<T>
): Promise<Read<T>> => {
  try {
    const data = await core.withSession(
      async (session) => await read(session.brainSources)
    );
    return { state: "ready", data };
  } catch (error) {
    return { state: "refused", message: failureText(error) };
  }
};

/** The same source, by its producer and id. */
const sameSource = (one: BrainSourceRef, other: BrainSourceRef): boolean =>
  one.producer === other.producer && one.id === other.id;

/** A source's key, for React. */
const keyOf = ({ producer, id }: BrainSourceRef): string => `${producer}:${id}`;

const ProducerBadge = ({ producer }: { producer: BrainSourceProducer }) => {
  const { t } = useLingui();
  const label = {
    upload: t({ message: "Upload", context: "a source of the Brain" }),
    chat: t({ message: "Chat", context: "a source of the Brain" }),
    run: t({ message: "Workflow run", context: "a source of the Brain" }),
    capture: t({
      message: "Fetched from a connection",
      context: "a source of the Brain",
    }),
  }[producer];
  return <Badge variant="outline">{label}</Badge>;
};

const FoundBadge = ({ found }: { found: BrainFoundBy }) => {
  const { t } = useLingui();
  const label = {
    exact: t({ message: "Exact match", context: "how search found a passage" }),
    words: t({
      message: "By its words",
      context: "how search found a passage",
    }),
    "stop words": t({
      message: "By common words only",
      context: "how search found a passage",
    }),
    meaning: t({
      message: "By meaning",
      context: "how search found a passage",
    }),
  }[found];
  return <Badge variant="secondary">{label}</Badge>;
};

const MemoryFoundBadge = ({ found }: { found: BrainMemoryFoundBy }) => {
  const { t } = useLingui();
  const label = {
    words: t({
      message: "By its words",
      context: "how search found a memory",
    }),
    entities: t({
      message: "Through what you asked about",
      context: "how search found a memory",
    }),
    contested: t({
      message: "Another side of a disputed fact",
      context: "how search found a memory",
    }),
  }[found];
  return <Badge variant="secondary">{label}</Badge>;
};

/** Whose word a memory is, as its producer said it. */
const SaidBadge = ({ said }: { said: BrainSearchMemory["said"] }) => {
  const { t } = useLingui();
  const label = {
    you: t`Your own word`,
    person: t`Someone's word`,
    outside: t`An outside party's word`,
    agent: t`An agent's word`,
    system: t`A system's word`,
  }[said];
  return <Badge variant="outline">{label}</Badge>;
};

/**
 * A memory of the pack: what it says, the words of its source it rests on
 * and the passage around them when the pack holds them, and where it came
 * from: a source's version, which opens it, or someone's word.
 */
const MemoryResult = ({
  memory,
  onOpen,
}: {
  memory: BrainSearchMemory;
  onOpen: (source: BrainSourceRef, version: number) => void;
}) => {
  const { source, context } = memory;
  const version = source?.version;
  return (
    <Item size="sm" variant="outline">
      <ItemContent>
        <span className="text-sm">{memory.statement}</span>
        {memory.quote === null ? null : (
          <blockquote className="text-muted-foreground border-l-2 pl-3 text-sm whitespace-pre-wrap">
            {memory.quote}
          </blockquote>
        )}
        {context === null ? null : (
          <Collapsible>
            <CollapsibleTrigger render={<Button size="xs" variant="ghost" />}>
              <Trans>The passage around it</Trans>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <p className="text-muted-foreground text-sm whitespace-pre-wrap">
                {context.text}
              </p>
            </CollapsibleContent>
          </Collapsible>
        )}
        <span className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
          <SaidBadge said={memory.said} />
          {source === null ? null : (
            <>
              <ProducerBadge producer={source.source.producer} />
              <Button
                onClick={() => {
                  onOpen(source.source, source.version);
                }}
                size="xs"
                type="button"
                variant="link"
              >
                <Trans>Open version {version}</Trans>
              </Button>
            </>
          )}
          {memory.store === "own" ? (
            <Badge variant="outline">
              <Trans context="a memory nobody else may read">Only you</Trans>
            </Badge>
          ) : null}
          {memory.confirmed ? (
            <Badge variant="passed">
              <Trans context="a memory a person confirmed">Confirmed</Trans>
            </Badge>
          ) : null}
          {memory.contested ? (
            <Badge variant="attention">
              <Trans>Sources disagree</Trans>
            </Badge>
          ) : null}
          <MemoryFoundBadge found={memory.found} />
        </span>
      </ItemContent>
    </Item>
  );
};

/** The pack, as recall gave it: its memories and passages in its order, what it didn't find, and whether it was cut short. */
const SearchResults = ({
  pack,
  onOpen,
}: {
  pack: BrainSearchPack;
  onOpen: (source: BrainSourceRef, version: number) => void;
}) => {
  const missing = formatList(pack.notFound);
  const heading = useId();
  const nothing = pack.items.length === 0 && pack.memories.length === 0;
  return (
    <section aria-labelledby={heading} className="flex flex-col gap-3">
      <h2 className="text-sm font-medium" id={heading}>
        <Trans>Results</Trans>
      </h2>
      {nothing ? (
        <p className="text-muted-foreground text-sm">
          <Trans>Nothing you may read matched.</Trans>
        </p>
      ) : null}
      {pack.memories.length === 0 ? null : (
        <div className="flex flex-col gap-2">
          <h3 className="text-muted-foreground text-xs font-medium">
            <Trans>What the Brain remembers</Trans>
          </h3>
          <ItemGroup render={<ol />} spacing="tight">
            {pack.memories.map((memory) => (
              <li key={`${memory.store}:${memory.id}`}>
                <MemoryResult memory={memory} onOpen={onOpen} />
              </li>
            ))}
          </ItemGroup>
        </div>
      )}
      {pack.items.length === 0 ? null : (
        <div className="flex flex-col gap-2">
          {pack.memories.length === 0 ? null : (
            <h3 className="text-muted-foreground text-xs font-medium">
              <Trans>Passages</Trans>
            </h3>
          )}
          <ItemGroup render={<ol />} spacing="tight">
            {pack.items.map((item) => {
              const { version } = item;
              return (
                <li key={`${keyOf(item.source)}@${version}#${item.position}`}>
                  <Item
                    onClick={() => {
                      onOpen(item.source, version);
                    }}
                    render={
                      // oxlint-disable-next-line jsx-a11y/control-has-associated-label -- the passage and its labels are its words, as the Item's children
                      <button type="button" />
                    }
                    size="sm"
                  >
                    <ItemContent>
                      <span className="text-sm whitespace-pre-wrap">
                        {item.text}
                      </span>
                      <span className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
                        <ProducerBadge producer={item.source.producer} />
                        <FoundBadge found={item.found} />
                        <span>
                          <Trans>Version {version}</Trans>
                        </span>
                        {item.whole ? null : (
                          <span>
                            <Trans>The best part of its passage</Trans>
                          </span>
                        )}
                      </span>
                    </ItemContent>
                  </Item>
                </li>
              );
            })}
          </ItemGroup>
        </div>
      )}
      {/* What wasn't found only beside what was: a search that found
          nothing says so once, above. */}
      {nothing || pack.notFound.length === 0 ? null : (
        <p className="text-muted-foreground text-sm">
          <Trans>Nothing you may read holds {missing}.</Trans>
        </p>
      )}
      {pack.truncated ? (
        <p className="text-muted-foreground text-sm">
          <Trans>More was found than fits: these are the best of it.</Trans>
        </p>
      ) : null}
    </section>
  );
};

/** Search: the question, and recall's pack for it. */
const Search = ({
  onOpen,
}: {
  onOpen: (source: BrainSourceRef, version: number) => void;
}) => {
  const { t } = useLingui();
  const core = useCore();
  const id = useId();
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<Read<BrainSearchPack>>();
  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const asked = question.trim();
          // One search at a time, so answers can't arrive out of order.
          if (asked === "" || result?.state === "loading") {
            return;
          }
          setResult({ state: "loading" });
          void (async () => {
            setResult(
              await readFrom(
                core,
                async (sources) => await sources.search(asked)
              )
            );
          })();
        }}
      >
        <label className="sr-only" htmlFor={id}>
          <Trans>Search the Brain</Trans>
        </label>
        <Input
          id={id}
          onChange={(event) => {
            setQuestion(event.target.value);
          }}
          maxLength={brainQuestionMaxLength}
          placeholder={t`Ask what you're looking for`}
          type="search"
          value={question}
        />
        <Button
          disabled={result?.state === "loading" || question.trim() === ""}
          type="submit"
        >
          <Trans>Search</Trans>
        </Button>
      </form>
      {result?.state === "refused" ? (
        <ErrorText>{result.message}</ErrorText>
      ) : null}
      {result?.state === "ready" ? (
        <SearchResults onOpen={onOpen} pack={result.data} />
      ) : null}
    </div>
  );
};

/**
 * How the person's connections feed the Brain. What an agent reads as one
 * item (a message, a page) through a connection of their own is kept in
 * their own Brain, for them alone (core's connection-capture.ts,
 * GRA-1730); everything else agents search live, and the Brain keeps
 * nothing of it. A full copy comes with native sync. These connections
 * don't say which are the person's own, so the rule is said once.
 */
const ConnectionFeeds = ({ connections }: { connections: Connection[] }) => {
  const heading = useId();
  return (
    <section aria-labelledby={heading} className="flex flex-col gap-3">
      <h2 className="text-sm font-medium" id={heading}>
        <Trans>How your connections feed the Brain</Trans>
      </h2>
      {connections.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          <Trans>You have no connections yet.</Trans>
        </p>
      ) : (
        <>
          <p className="text-muted-foreground text-sm">
            <Trans>
              The Brain keeps one Gmail message or attachment, or one OneNote
              page, when an agent reads it for you through an account you
              connected yourself, and keeps it for you alone. Everything else
              agents search live when you ask, and the Brain keeps nothing of
              it.
            </Trans>
          </p>
          <ul className="flex flex-col gap-2 text-sm">
            {connections.map(({ name, keepsReads }) => (
              <li className="flex flex-col" key={name}>
                <span>{name}</span>
                <span className="text-muted-foreground">
                  {keepsReads === true ? (
                    <Trans>
                      The Brain keeps the messages and pages an agent reads for
                      you from this.
                    </Trans>
                  ) : (
                    <Trans>Searched live, nothing kept.</Trans>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
};

const SourceLine = ({
  listed,
  picked,
  onPick,
}: {
  listed: BrainSourceListed;
  picked: boolean;
  onPick: () => void;
}) => {
  const { versions } = listed;
  return (
    <Item
      onClick={onPick}
      render={
        // oxlint-disable-next-line jsx-a11y/control-has-associated-label -- the source's first line and labels are its words, as the Item's children
        <button aria-pressed={picked} type="button" />
      }
      size="sm"
    >
      <ItemContent>
        <span className="min-w-0 text-sm">
          {listed.firstLine === "" ? (
            <span className="text-muted-foreground">
              <Trans>No first line</Trans>
            </span>
          ) : (
            listed.firstLine
          )}
        </span>
        <span className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
          <ProducerBadge producer={listed.source.producer} />
          {listed.personal ? (
            <Badge variant="outline">
              <Trans context="a source nobody else may read">Only you</Trans>
            </Badge>
          ) : null}
          <span>{formatDateTime(listed.addedAt)}</span>
          <span>
            <Plural one="# version" other="# versions" value={versions} />
          </span>
        </span>
      </ItemContent>
    </Item>
  );
};

/** The sources the person may read, newest first, a page at a time. */
const SourceList = ({
  picked,
  onPick,
}: {
  picked: BrainSourceRef | undefined;
  onPick: (source: BrainSourceRef) => void;
}) => {
  const core = useCore();
  const [listed, setListed] = useState<Read<BrainSourcePage>>({
    state: "loading",
  });
  const [more, setMore] = useState<Read<BrainSourcePage>>();
  useEffect(() => {
    let left = false;
    const read = async (): Promise<void> => {
      const answer = await readFrom(
        core,
        async (sources) => await sources.list()
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
  const { sources, next } = listed.data;
  if (sources.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>
            <Trans>Nothing in the Brain you may read yet</Trans>
          </EmptyTitle>
          <EmptyDescription>
            <Trans>
              Documents and workflow runs show here once they reach the Brain.
            </Trans>
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-sm">
        <Trans>
          Those marked Only you are yours alone: nobody else sees them, admins
          included.
        </Trans>
      </p>
      <ItemGroup render={<ul />} spacing="tight">
        {sources.map((each) => (
          <li key={keyOf(each.source)}>
            <SourceLine
              listed={each}
              onPick={() => {
                onPick(each.source);
              }}
              picked={picked !== undefined && sameSource(picked, each.source)}
            />
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
                async (read) => await read.list(next)
              );
              setMore(answer.state === "refused" ? answer : undefined);
              if (answer.state === "ready") {
                setListed({
                  state: "ready",
                  data: {
                    sources: [...sources, ...answer.data.sources],
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

/** A source's versions, newest first, the one shown marked. */
const VersionList = ({
  page,
  shown,
  source,
  onChoose,
  onMore,
}: {
  page: BrainSourceVersionPage;
  shown: number | undefined;
  source: BrainSourceRef;
  onChoose: (version: number) => void;
  onMore: (page: BrainSourceVersionPage) => void;
}) => {
  const core = useCore();
  const [more, setMore] = useState<Read<BrainSourceVersionPage>>();
  const { before } = page;
  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-muted-foreground text-xs font-medium">
        <Trans>Versions</Trans>
      </h4>
      <ItemGroup render={<ul />} spacing="tight">
        {page.versions.map(({ version, addedAt }) => {
          const added = formatDateTime(addedAt);
          return (
            <li key={version}>
              <Item
                onClick={() => {
                  onChoose(version);
                }}
                render={
                  // oxlint-disable-next-line jsx-a11y/control-has-associated-label -- the version and its date are its words, as the Item's children
                  <button aria-pressed={version === shown} type="button" />
                }
                size="xs"
              >
                <Trans>
                  Version {version}, added {added}
                </Trans>
              </Item>
            </li>
          );
        })}
      </ItemGroup>
      {more?.state === "refused" ? <ErrorText>{more.message}</ErrorText> : null}
      {before === null ? null : (
        <Button
          className="self-start"
          disabled={more?.state === "loading"}
          onClick={() => {
            setMore({ state: "loading" });
            void (async () => {
              const answer = await readFrom(
                core,
                async (sources) => await sources.versions(source, before)
              );
              setMore(answer.state === "refused" ? answer : undefined);
              if (answer.state === "ready") {
                onMore(answer.data);
              }
            })();
          }}
          type="button"
          variant="outline"
        >
          <Trans>Older versions</Trans>
        </Button>
      )}
    </div>
  );
};

/** One source: its versions the person may read, and the text of the one in hand. */
const SourcePanel = ({
  source,
  version: asked,
}: {
  source: BrainSourceRef;
  /** The version to show first: the newest they may read when left out. */
  version: number | undefined;
}) => {
  const core = useCore();
  const [versions, setVersions] = useState<Read<BrainSourceVersionPage>>({
    state: "loading",
  });
  const [chosen, setChosen] = useState(asked);
  // Each read is kept with the version it is of, so a version picked
  // after it shows as loading, never under the text of the one before.
  const [readOf, setReadOf] = useState<{
    version: number;
    answer: Read<BrainSourceText | null>;
  }>();
  useEffect(() => {
    let left = false;
    const read = async (): Promise<void> => {
      const answer = await readFrom(
        core,
        async (sources) => await sources.versions(source)
      );
      if (!left) {
        setVersions(answer);
      }
    };
    void read();
    return () => {
      left = true;
    };
  }, [core, source]);
  const newest =
    versions.state === "ready" ? versions.data.versions[0]?.version : undefined;
  const shown = chosen ?? newest;
  useEffect(() => {
    let left = false;
    const read = async (version: number): Promise<void> => {
      const answer = await readFrom(
        core,
        async (sources) => await sources.read(source, version)
      );
      if (!left) {
        setReadOf({ version, answer });
      }
    };
    if (shown !== undefined) {
      void read(shown);
    }
    return () => {
      left = true;
    };
  }, [core, source, shown]);

  if (versions.state === "refused") {
    return <ErrorText>{versions.message}</ErrorText>;
  }
  const text: Read<BrainSourceText | null> =
    readOf !== undefined && readOf.version === shown
      ? readOf.answer
      : { state: "loading" };
  const read = text.state === "ready" ? text.data : undefined;
  return (
    <Card render={<section />} size="sm">
      <CardContent>
        {versions.state === "ready" && versions.data.versions.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            <Trans>You can&apos;t read this source.</Trans>
          </p>
        ) : null}
        {read === undefined || read === null ? null : (
          <>
            <h3 className="text-sm font-medium">
              {firstLineOf(read.text) || <Trans>No first line</Trans>}
            </h3>
            <p className="text-sm whitespace-pre-wrap">{read.text}</p>
          </>
        )}
        {text.state === "ready" && text.data === null ? (
          <p className="text-muted-foreground text-sm">
            <Trans>You can&apos;t read this version.</Trans>
          </p>
        ) : null}
        {text.state === "refused" ? (
          <ErrorText>{text.message}</ErrorText>
        ) : null}
        {versions.state === "ready" && versions.data.versions.length > 0 ? (
          <VersionList
            onChoose={setChosen}
            page={versions.data}
            shown={shown}
            source={source}
            onMore={(page) => {
              setVersions({
                state: "ready",
                data: {
                  versions: [...versions.data.versions, ...page.versions],
                  before: page.before,
                },
              });
            }}
          />
        ) : null}
      </CardContent>
    </Card>
  );
};

/** The Brain's sources page: search, how connections feed it, and the sources. */
export const SourcesPage = ({
  connections,
}: {
  /** The person's connections, each one they have connected. */
  connections: Connection[];
}) => {
  // Each opening counts, so opening a source again (a search result
  // citing a version, after another was picked in its panel) starts its
  // panel afresh at what was asked.
  const [opened, setOpened] = useState<{
    source: BrainSourceRef;
    version?: number;
    opening: number;
  }>();
  const heading = useId();
  const open = (source: BrainSourceRef, version?: number) => {
    const opening = (opened?.opening ?? 0) + 1;
    setOpened(
      version === undefined ? { source, opening } : { source, version, opening }
    );
  };
  return (
    // A page of the brain as its memory is (memory-page.tsx): the title in
    // the serif, in the brain's column, with room at the foot for the chat.
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="pb-chat mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 pt-8 md:px-12">
        <PageHeader>
          <PageHeaderTitle>
            <Trans context="the Brain's sources page">Sources</Trans>
          </PageHeaderTitle>
          <PageHeaderDescription>
            <Trans>
              What the Brain keeps that you may read, and search through it as
              your agents recall it.
            </Trans>
          </PageHeaderDescription>
        </PageHeader>
        <Search onOpen={open} />
        <ConnectionFeeds connections={connections} />
        <section aria-labelledby={heading} className="flex flex-col gap-3">
          <h2 className="text-sm font-medium" id={heading}>
            <Trans>Sources you may read</Trans>
          </h2>
          <div className="grid min-h-0 gap-6 lg:grid-cols-2">
            <SourceList
              onPick={(source) => {
                open(source);
              }}
              picked={opened?.source}
            />
            {opened === undefined ? null : (
              <SourcePanel
                key={opened.opening}
                source={opened.source}
                version={opened.version}
              />
            )}
          </div>
        </section>
        <OwnExportSection />
      </div>
    </div>
  );
};
