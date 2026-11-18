import type { Connection } from "@grasp-os/shared/brain";
import type {
  BrainFoundBy,
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
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useId, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime, formatList } from "../format.ts";
import { BrandIcon } from "../grasp/brand-icon/index.ts";
import { Button } from "../grasp/button/index.ts";
import { Card } from "../grasp/card/index.ts";
import { Empty, EmptyHeader, EmptyTitle } from "../grasp/empty/index.ts";
import { Heading } from "../grasp/heading/index.ts";
import { Cable } from "../grasp/icons/index.ts";
import { Input } from "../grasp/input/index.ts";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { PageHeader } from "../grasp/page-header/index.ts";
import { Tag } from "../grasp/tag/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import { brandOf } from "../inbox/brand-of.ts";
import { useCore } from "../use-core.ts";

// The Brain's sources, from the new Brain (GRA-1734): what the person may
// read, a page at a time, newest first; one source's versions and text;
// search, which is recall as that person, shown as recall packs it (no
// ranking of the page's own); and how each of their connections feeds the
// Brain today. Core answers each from what they may read alone. Texts are
// shown as text, never markup.

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

const styles = stylex.create({
  // A page of the brain as its memory is: its own pane that scrolls, the
  // column in its middle, with room at the foot for the chat.
  pane: { flexGrow: 1, minHeight: 0, overflowY: "auto" },
  column: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space8,
    boxSizing: "border-box",
    width: "100%",
    maxWidth: grasp.pageMeasure,
    marginInline: "auto",
    paddingInline: { default: grasp.space6, [media.fromTablet]: grasp.space12 },
  },
  section: { display: "flex", flexDirection: "column", gap: grasp.space3 },
  stack: { display: "flex", flexDirection: "column", gap: grasp.space4 },
  list: { display: "flex", flexDirection: "column", gap: grasp.space3 },
  versions: { display: "flex", flexDirection: "column", gap: grasp.space1 },
  form: { display: "flex", gap: grasp.space2 },
  grow: { flexGrow: 1, minWidth: 0 },
  start: { alignSelf: "flex-start" },
  // The source list and the opened source side by side on a wide page.
  split: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      [media.fromSidebar]: "repeat(2, minmax(0, 1fr))",
    },
    alignItems: "start",
    gap: grasp.space6,
    minHeight: 0,
  },
  // A row's facts: its kind, how it was found, its version.
  facts: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space2,
  },
  // Texts are shown as text, with their own line breaks.
  plain: { whiteSpace: "pre-wrap" },
});

const ProducerBadge = ({ producer }: { producer: BrainSourceProducer }) => {
  const { t } = useLingui();
  const label = {
    upload: t({ message: "Upload", context: "a source of the Brain" }),
    chat: t({ message: "Chat", context: "a source of the Brain" }),
    run: t({ message: "Workflow run", context: "a source of the Brain" }),
  }[producer];
  return <Tag size="sm">{label}</Tag>;
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
  return (
    <Tag size="sm" variant="outline">
      {label}
    </Tag>
  );
};

/** The pack, as recall gave it: its passages in its order, what it didn't find, and whether it was cut short. */
const SearchResults = ({
  pack,
  onOpen,
}: {
  pack: BrainSearchPack;
  onOpen: (source: BrainSourceRef, version: number) => void;
}) => {
  const missing = formatList(pack.notFound);
  const heading = useId();
  return (
    <section aria-labelledby={heading} {...stylex.props(styles.section)}>
      <Heading id={heading} level={2} size="ui-sm">
        <Trans>Results</Trans>
      </Heading>
      {pack.items.length === 0 ? (
        <Text size="sm" tone="muted">
          <Trans>Nothing you may read matched.</Trans>
        </Text>
      ) : (
        <ItemGroup>
          {pack.items.map((item) => {
            const { version } = item;
            return (
              <Item
                key={`${keyOf(item.source)}@${version}#${item.position}`}
                render={
                  // oxlint-disable-next-line jsx-a11y/control-has-associated-label -- the passage and its labels are its words, as the Item's children
                  <button
                    onClick={() => {
                      onOpen(item.source, version);
                    }}
                    type="button"
                  />
                }
                size="sm"
              >
                <ItemContent>
                  <ItemTitle>
                    <span {...stylex.props(styles.plain)}>{item.text}</span>
                  </ItemTitle>
                  <ItemDescription>
                    <span {...stylex.props(styles.facts)}>
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
                  </ItemDescription>
                </ItemContent>
              </Item>
            );
          })}
        </ItemGroup>
      )}
      {/* What wasn't found only beside what was: a search that found
          nothing says so once, above. */}
      {pack.items.length === 0 || pack.notFound.length === 0 ? null : (
        <Text size="sm" tone="muted">
          <Trans>Nothing you may read holds {missing}.</Trans>
        </Text>
      )}
      {pack.truncated ? (
        <Text size="sm" tone="muted">
          <Trans>More was found than fits: these are the best of it.</Trans>
        </Text>
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
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<Read<BrainSearchPack>>();
  return (
    <div {...stylex.props(styles.stack)}>
      <form
        {...stylex.props(styles.form)}
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
        <Input
          aria-label={t`Search the Brain`}
          layout={styles.grow}
          maxLength={brainQuestionMaxLength}
          onValueChange={(value) => {
            setQuestion(value);
          }}
          placeholder={t`Ask what you're looking for`}
          type="search"
          value={question}
        />
        <Button
          disabled={result?.state === "loading" || question.trim() === ""}
          type="submit"
          variant="ink"
        >
          {t`Search`}
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
 * How each of the person's connections feeds the Brain. Today only one
 * way exists: an agent searches the connection live, with its own tools,
 * and nothing it reads is kept. What agents fetch is kept once capture
 * is built (GRA-1730), and a full copy once native sync is.
 */
const ConnectionFeeds = ({ connections }: { connections: Connection[] }) => {
  const heading = useId();
  return (
    <section aria-labelledby={heading} {...stylex.props(styles.section)}>
      <Heading id={heading} level={2} size="ui-sm">
        <Trans>How your connections feed the Brain</Trans>
      </Heading>
      {connections.length === 0 ? (
        <Text size="sm" tone="muted">
          <Trans>You have no connections yet.</Trans>
        </Text>
      ) : (
        <ItemGroup separated>
          {connections.map(({ name }) => {
            const brand = brandOf(name);
            return (
              <Item key={name} size="xs">
                {brand === undefined ? (
                  <ItemMedia icon={Cable} iconLook="inline" />
                ) : (
                  <ItemMedia>
                    <BrandIcon
                      brand={brand}
                      decorative
                      size="md"
                      tile={false}
                    />
                  </ItemMedia>
                )}
                <ItemContent>
                  <ItemTitle>
                    <Trans>
                      {name}: agents search it live when you ask. The Brain
                      keeps nothing from it.
                    </Trans>
                  </ItemTitle>
                </ItemContent>
              </Item>
            );
          })}
        </ItemGroup>
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
      current={picked}
      render={
        // oxlint-disable-next-line jsx-a11y/control-has-associated-label -- the source's first line and labels are its words, as the Item's children
        <button aria-pressed={picked} onClick={onPick} type="button" />
      }
      size="sm"
    >
      <ItemContent>
        <ItemTitle>
          {listed.firstLine === "" ? (
            <Text element="span" size="sm" tone="muted">
              <Trans>No first line</Trans>
            </Text>
          ) : (
            listed.firstLine
          )}
        </ItemTitle>
        <ItemDescription>
          <span {...stylex.props(styles.facts)}>
            <ProducerBadge producer={listed.source.producer} />
            {listed.personal ? (
              <Tag size="sm" variant="outline">
                <Trans context="a source nobody else may read">Only you</Trans>
              </Tag>
            ) : null}
            <span>{formatDateTime(listed.addedAt)}</span>
            <span>
              <Plural one="# version" other="# versions" value={versions} />
            </span>
          </span>
        </ItemDescription>
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
          <EmptyTitle headingLevel={3}>
            <Trans>Nothing in the Brain you may read yet</Trans>
          </EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div {...stylex.props(styles.list)}>
      <Text size="sm" tone="muted">
        <Trans>
          Those marked Only you are yours alone: nobody else sees them, admins
          included.
        </Trans>
      </Text>
      <ItemGroup>
        {sources.map((each) => (
          <SourceLine
            key={keyOf(each.source)}
            listed={each}
            onPick={() => {
              onPick(each.source);
            }}
            picked={picked !== undefined && sameSource(picked, each.source)}
          />
        ))}
      </ItemGroup>
      {more?.state === "refused" ? <ErrorText>{more.message}</ErrorText> : null}
      {next === null ? null : (
        <Button
          disabled={more?.state === "loading"}
          layout={styles.start}
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
    <div {...stylex.props(styles.versions)}>
      <Heading level={4} size="ui-sm">
        <Trans>Versions</Trans>
      </Heading>
      <ItemGroup>
        {page.versions.map(({ version, addedAt }) => {
          const added = formatDateTime(addedAt);
          return (
            <Item
              current={version === shown}
              key={version}
              render={
                // oxlint-disable-next-line jsx-a11y/control-has-associated-label -- the version and its date are its words, as the Item's children
                <button
                  aria-pressed={version === shown}
                  onClick={() => {
                    onChoose(version);
                  }}
                  type="button"
                />
              }
              size="xs"
            >
              <ItemContent>
                <ItemTitle>
                  <Trans>
                    Version {version}, added {added}
                  </Trans>
                </ItemTitle>
              </ItemContent>
            </Item>
          );
        })}
      </ItemGroup>
      {more?.state === "refused" ? <ErrorText>{more.message}</ErrorText> : null}
      {before === null ? null : (
        <Button
          disabled={more?.state === "loading"}
          layout={styles.start}
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
          size="sm"
          type="button"
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
    <Card element="section" padding="md">
      <div {...stylex.props(styles.stack)}>
        {versions.state === "ready" && versions.data.versions.length === 0 ? (
          <Text size="sm" tone="muted">
            <Trans>You can&apos;t read this source.</Trans>
          </Text>
        ) : null}
        {read === undefined || read === null ? null : (
          <>
            <Heading level={3} size="ui-sm">
              {firstLineOf(read.text) || <Trans>No first line</Trans>}
            </Heading>
            <Text size="sm">
              <span {...stylex.props(styles.plain)}>{read.text}</span>
            </Text>
          </>
        )}
        {text.state === "ready" && text.data === null ? (
          <Text size="sm" tone="muted">
            <Trans>You can&apos;t read this version.</Trans>
          </Text>
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
      </div>
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
    <div {...stylex.props(styles.pane)}>
      <div {...stylex.props(styles.column)}>
        <PageHeader
          title={<Trans context="the Brain's sources page">Sources</Trans>}
        />
        <Search onOpen={open} />
        <ConnectionFeeds connections={connections} />
        <section aria-labelledby={heading} {...stylex.props(styles.section)}>
          <Heading id={heading} level={2} size="ui-sm">
            <Trans>Sources you may read</Trans>
          </Heading>
          <div {...stylex.props(styles.split)}>
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
      </div>
    </div>
  );
};
