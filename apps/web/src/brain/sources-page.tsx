import type { Connection, Source as BrainSource } from "@grasp-os/shared/brain";
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
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime, formatDay, formatList } from "../format.ts";
import { Button } from "../grasp/button/index.ts";
import { Card } from "../grasp/card/index.ts";
import { Empty, EmptyHeader, EmptyTitle } from "../grasp/empty/index.ts";
import { Heading } from "../grasp/heading/index.ts";
import { Search as SearchIcon } from "../grasp/icons/index.ts";
import {
  InputGroup,
  InputGroupButton,
  InputGroupClear,
  InputGroupInput,
  InputGroupText,
} from "../grasp/input-group/index.ts";
import {
  Item,
  ItemContent,
  ItemGroup,
  ItemTitle,
} from "../grasp/item/index.ts";
import { PageHeader } from "../grasp/page-header/index.ts";
import { SourceList, Sources } from "../grasp/sources/index.ts";
import type { Source, SourceKind } from "../grasp/sources/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import { brandOf } from "../inbox/brand-of.ts";
import { useCore } from "../use-core.ts";
import { given } from "./brain.ts";

// The Brain's sources, every kind on the library's SourceList: the
// interviews, documents, chats, imports and run logs the Brain learned
// from (each opens its own page, an interview on the library's Interview),
// what the new Brain keeps that the person may read (GRA-1734), a page at
// a time, and the connections agents search live, with their brand marks.
// Search is recall as that person, shown as recall packs it (no ranking of
// the page's own). Core answers each from what they may read alone. Texts
// are shown as text, never markup.

type CoreSources = Session["brainSources"];

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
  read: (sources: CoreSources) => Promise<T>
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

/** The library's kind for what added a source to the new Brain. */
const producerKind: Record<BrainSourceProducer, SourceKind> = {
  upload: "file",
  chat: "message",
  run: "workflow",
};

/** The library's kind for each of the Brain's own sources. */
const sourceKind: Record<BrainSource["kind"], SourceKind> = {
  interview: "meeting",
  chat: "message",
  document: "file",
  import: "record",
  runLog: "workflow",
};

/** One row of the list, and what opening it does. */
interface Row {
  item: Source;
  open: () => void;
}

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
  stack: { display: "flex", flexDirection: "column", gap: grasp.space4 },
  list: { display: "flex", flexDirection: "column", gap: grasp.space3 },
  versions: { display: "flex", flexDirection: "column", gap: grasp.space1 },
  start: { alignSelf: "flex-start" },
  // The list and the opened source side by side on a wide page.
  split: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    alignItems: "start",
    gap: grasp.space6,
    minHeight: 0,
  },
  // Room for the source beside the list only while one is open: an empty
  // half would push the list off the middle.
  splitOpen: {
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      [media.fromSidebar]: "repeat(2, minmax(0, 1fr))",
    },
  },
  // Texts are shown as text, with their own line breaks.
  plain: { whiteSpace: "pre-wrap" },
});

/** What added a source to the new Brain, in a word. */
const useProducerLabel = () => {
  const { t } = useLingui();
  return (producer: BrainSourceProducer): string =>
    ({
      upload: t({ message: "Upload", context: "a source of the Brain" }),
      chat: t({ message: "Chat", context: "a source of the Brain" }),
      run: t({ message: "Workflow run", context: "a source of the Brain" }),
    })[producer];
};

/** How recall found a passage, in a few words. */
const useFoundLabel = () => {
  const { t } = useLingui();
  return (found: BrainFoundBy): string =>
    ({
      exact: t({
        message: "Exact match",
        context: "how search found a passage",
      }),
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
    })[found];
};

/** The pack, as recall gave it: its passages in its order, what it didn't find, and whether it was cut short. */
const SearchResults = ({
  pack,
  titleOf,
  onOpen,
}: {
  pack: BrainSearchPack;
  /** A source's first line, once the list has read it. */
  titleOf: (source: BrainSourceRef) => string | undefined;
  onOpen: (source: BrainSourceRef, version: number) => void;
}) => {
  const { t } = useLingui();
  const producerLabel = useProducerLabel();
  const foundLabel = useFoundLabel();
  const missing = formatList(pack.notFound);
  if (pack.items.length === 0) {
    return (
      <Text size="sm" tone="muted">
        <Trans>Nothing you may read matched.</Trans>
      </Text>
    );
  }
  const items = pack.items.map((item): Source => {
    const { version } = item;
    const producer = producerLabel(item.source.producer);
    const first = titleOf(item.source);
    return {
      kind: producerKind[item.source.producer],
      title: given(first) ? first : producer,
      origin: [
        given(first) ? producer : undefined,
        t`Version ${version}`,
        foundLabel(item.found),
        item.whole ? undefined : t`The best part of its passage`,
      ]
        .filter(given)
        .join(" · "),
      quote: item.text,
    };
  });
  return (
    <div {...stylex.props(styles.list)}>
      <Sources
        items={items}
        onOpen={(_, index) => {
          const item = pack.items[index];
          if (item !== undefined) {
            onOpen(item.source, item.version);
          }
        }}
      >
        <SourceList
          defaultOpen
          fold={items.length}
          heading={t`Results`}
          headingLevel={2}
        />
      </Sources>
      {pack.notFound.length === 0 ? null : (
        <Text size="sm" tone="muted">
          <Trans>Nothing you may read holds {missing}.</Trans>
        </Text>
      )}
      {pack.truncated ? (
        <Text size="sm" tone="muted">
          <Trans>More was found than fits: these are the best of it.</Trans>
        </Text>
      ) : null}
    </div>
  );
};

/** Search: the question, and recall's pack for it. */
const Search = ({
  titleOf,
  onOpen,
}: {
  titleOf: (source: BrainSourceRef) => string | undefined;
  onOpen: (source: BrainSourceRef, version: number) => void;
}) => {
  const { t } = useLingui();
  const core = useCore();
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<Read<BrainSearchPack>>();
  return (
    <div {...stylex.props(styles.stack)}>
      <form
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
        <InputGroup>
          <InputGroupText icon={SearchIcon} />
          <InputGroupInput
            aria-label={t`Search the Brain`}
            maxLength={brainQuestionMaxLength}
            onValueChange={(value) => {
              setQuestion(value);
            }}
            placeholder={t`Ask what you're looking for`}
            type="search"
            value={question}
          />
          <InputGroupClear aria-label={t`Clear`} />
          <InputGroupButton
            disabled={result?.state === "loading" || question.trim() === ""}
            type="submit"
          >
            {t`Search`}
          </InputGroupButton>
        </InputGroup>
      </form>
      {result?.state === "refused" ? (
        <ErrorText>{result.message}</ErrorText>
      ) : null}
      {result?.state === "ready" ? (
        <SearchResults onOpen={onOpen} pack={result.data} titleOf={titleOf} />
      ) : null}
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
          variant="ghost"
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

/** The Brain's sources page: search, then every source, newest first, the connections last. */
export const SourcesPage = ({
  sources,
  connections,
}: {
  /** The Brain's own sources, as `brain.read` gave them. */
  sources: BrainSource[];
  /** The person's connections, each one they have connected. */
  connections: Connection[];
}) => {
  const { t } = useLingui();
  const core = useCore();
  const navigate = useNavigate();
  const producerLabel = useProducerLabel();
  // Each opening counts, so opening a source again (a search result
  // citing a version, after another was picked in its panel) starts its
  // panel afresh at what was asked.
  const [opened, setOpened] = useState<{
    source: BrainSourceRef;
    version?: number;
    opening: number;
  }>();
  const [listed, setListed] = useState<Read<BrainSourcePage>>({
    state: "loading",
  });
  const [more, setMore] = useState<Read<BrainSourcePage>>();
  useEffect(() => {
    let left = false;
    const read = async (): Promise<void> => {
      const answer = await readFrom(core, async (kept) => await kept.list());
      if (!left) {
        setListed(answer);
      }
    };
    void read();
    return () => {
      left = true;
    };
  }, [core]);
  const open = (source: BrainSourceRef, version?: number) => {
    const opening = (opened?.opening ?? 0) + 1;
    setOpened(
      version === undefined ? { source, opening } : { source, version, opening }
    );
  };
  const kept: BrainSourceListed[] =
    listed.state === "ready" ? listed.data.sources : [];
  const next = listed.state === "ready" ? listed.data.next : null;
  const titleOf = (source: BrainSourceRef): string | undefined =>
    kept.find((each) => sameSource(each.source, source))?.firstLine;
  const sourceWord = {
    interview: t({ message: "Interview", context: "a source of the Brain" }),
    chat: t({ message: "Chat", context: "a source of the Brain" }),
    document: t({ message: "Document", context: "a source of the Brain" }),
    import: t({ message: "Import", context: "a source of the Brain" }),
    runLog: t({ message: "Run log", context: "a source of the Brain" }),
  };

  // Newest first, whoever added them; the connections, which keep
  // nothing, last. A source taken out of the brain is no longer one.
  const dated: { at: string; row: Row }[] = [
    ...sources
      .filter((source) => source.removedAt === undefined)
      .map((source) => ({
        at: source.date,
        row: {
          item: {
            kind:
              source.transcriptTurns === undefined
                ? sourceKind[source.kind]
                : "meeting",
            title: source.title,
            origin: [
              source.transcriptTurns === undefined
                ? sourceWord[source.kind]
                : t({
                    message: "Transcript",
                    context: "a source of the Brain",
                  }),
              source.who,
              source.how,
            ]
              .filter(given)
              .join(" · "),
            when: formatDay(source.date),
          },
          open: () => {
            void navigate({
              to: "/brain/$noteId",
              params: { noteId: source.id },
            });
          },
        },
      })),
    ...kept.map((each) => {
      const { versions } = each;
      return {
        at: each.addedAt,
        row: {
          item: {
            kind: producerKind[each.source.producer],
            title: each.firstLine === "" ? t`No first line` : each.firstLine,
            origin: [
              producerLabel(each.source.producer),
              each.personal
                ? t({
                    message: "Only you",
                    context: "a source nobody else may read",
                  })
                : undefined,
              versions > 1
                ? t`${plural(versions, { one: "# version", other: "# versions" })}`
                : undefined,
            ]
              .filter(given)
              .join(" · "),
            when: formatDateTime(each.addedAt),
          },
          open: () => {
            open(each.source);
          },
        },
      };
    }),
  ];
  // While core has older kept sources to give, the Brain's own sources
  // older than the last one given wait for them, so "Show more" only adds
  // at the end.
  const rows: Row[] = [
    ...dated
      .filter(({ at }) => next === null || at >= next.addedAt)
      .toSorted((a, b) => Number(a.at < b.at) - Number(a.at > b.at))
      .map(({ row }) => row),
    ...connections.map(({ name }) => ({
      item: {
        kind: "record" as const,
        title: name,
        brand: brandOf(name),
        origin: t`Agents search it live. The Brain keeps nothing.`,
      },
      open: () => {
        void navigate({ to: "/integrations" });
      },
    })),
  ];

  return (
    // A page of the brain as its memory is (memory-page.tsx): the title in
    // the serif, in the brain's column, with room at the foot for the chat.
    <div {...stylex.props(styles.pane)}>
      <div {...stylex.props(styles.column)}>
        <PageHeader
          title={<Trans context="the Brain's sources page">Sources</Trans>}
        />
        <Search onOpen={open} titleOf={titleOf} />
        {listed.state === "refused" ? (
          <ErrorText>{listed.message}</ErrorText>
        ) : null}
        {listed.state === "ready" && rows.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle headingLevel={2}>
                <Trans>Nothing in the Brain you may read yet</Trans>
              </EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : null}
        {opened === undefined &&
        (listed.state === "loading" || rows.length === 0) ? null : (
          <div
            {...stylex.props(
              styles.split,
              opened !== undefined && styles.splitOpen
            )}
          >
            <div {...stylex.props(styles.list)}>
              {rows.length === 0 ? null : (
                <Sources
                  items={rows.map(({ item }) => item)}
                  labels={{ byRelevance: t`Newest first` }}
                  onOpen={(_, index) => {
                    rows[index]?.open();
                  }}
                >
                  <SourceList
                    defaultOpen
                    fold={rows.length}
                    heading={t`Sources you may read`}
                    headingLevel={2}
                  />
                </Sources>
              )}
              {kept.some((each) => each.personal) ? (
                <Text size="sm" tone="muted">
                  <Trans>
                    Those marked Only you are yours alone: nobody else sees
                    them, admins included.
                  </Trans>
                </Text>
              ) : null}
              {more?.state === "refused" ? (
                <ErrorText>{more.message}</ErrorText>
              ) : null}
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
                            sources: [...kept, ...answer.data.sources],
                            next: answer.data.next,
                          },
                        });
                      }
                    })();
                  }}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <Trans>Show more</Trans>
                </Button>
              )}
            </div>
            {opened === undefined ? null : (
              <SourcePanel
                key={opened.opening}
                source={opened.source}
                version={opened.version}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
};
