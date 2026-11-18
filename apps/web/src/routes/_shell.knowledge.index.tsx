import { knowledgeSearchMaxLength } from "@grasp-os/shared/function-limits";
import type {
  Collection,
  DocumentSummary,
  SearchHit,
} from "@grasp-os/shared/knowledge";
import { pageMaxLimit } from "@grasp-os/shared/knowledge";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute, Link } from "@tanstack/react-router";

import { PageHeading, SectionTitle } from "../frame/page.tsx";
import { RouterLink } from "../frame/router-link.tsx";
import {
  Card,
  CardDescription,
  CardLink,
  CardMedia,
  CardTitle,
} from "../grasp/card/index.ts";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../grasp/empty/index.ts";
import { File, Folder, Search } from "../grasp/icons/index.ts";
import {
  Item,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import {
  CollectionDrawing,
  MemoryDrawing,
  Panel,
} from "../knowledge/blocks.tsx";
import { CollectionMarkers } from "../knowledge/collection-markers.tsx";
import { KnowledgeFrame } from "../knowledge/frame.tsx";
import type { MemoryFiles } from "../knowledge/memory.ts";
import { loadKnowledgeNav } from "../knowledge/nav-data.ts";
import { NewCollection } from "../knowledge/new-collection.tsx";
import { loadFromCore, NotLoaded } from "../load-from-core.tsx";

// Knowledge's home, a page to go on from, in the prototype's look
// (grasplabs/prototype `components/brain-home.tsx`): what it is in two
// sentences, the memory files agents always have in context, then a block
// per collection the person may read, three to a row. Core lists only
// those, and searches only those; the page shows what it gets.

const styles = stylex.create({
  scroll: { flex: 1, minWidth: 0, overflowY: "auto" },
  column: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space10,
    boxSizing: "border-box",
    width: "100%",
    maxWidth: grasp.pageMeasure,
    marginInline: "auto",
    paddingBlock: grasp.space8,
    paddingInline: { default: grasp.space6, [media.fromTablet]: grasp.space12 },
  },
  section: { display: "flex", flexDirection: "column", gap: grasp.space3 },
  sectionHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: grasp.space3,
  },
  list: {
    display: "flex",
    flexDirection: "column",
    margin: 0,
    padding: 0,
    listStyleType: "none",
  },
  hit: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space1,
    paddingBlock: grasp.space2,
  },
  memory: {
    display: "flex",
    flexDirection: { default: "column", [media.fromPhone]: "row" },
    alignItems: { default: "stretch", [media.fromPhone]: "flex-start" },
    gap: { default: grasp.space3, [media.fromPhone]: grasp.space6 },
  },
  memoryPanel: {
    flexShrink: 0,
    width: { default: "auto", [media.fromPhone]: `calc(${grasp.space24} * 3)` },
  },
  memoryWords: {
    display: "flex",
    flexDirection: "column",
    flex: 1,
    gap: grasp.space2,
    minWidth: 0,
  },
  files: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space1,
    margin: 0,
    padding: 0,
    listStyleType: "none",
  },
  latest: { display: "flex", flexDirection: "column", gap: grasp.space2 },
  blocks: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      [media.fromPhone]: "repeat(2, minmax(0, 1fr))",
      [media.fromRail]: "repeat(3, minmax(0, 1fr))",
    },
    columnGap: grasp.space6,
    rowGap: grasp.space8,
    margin: 0,
    padding: 0,
    listStyleType: "none",
  },
  block: { display: "flex", flexDirection: "column", gap: grasp.space3 },
});

const SearchResults = ({
  hits,
  collections,
}: {
  hits: SearchHit[];
  collections: ReadonlyMap<string, string>;
}) => {
  if (hits.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia icon={Search} />
          <EmptyTitle>
            <Trans>Nothing matched.</Trans>
          </EmptyTitle>
          <EmptyDescription>
            <Trans>
              Search reads every collection you may read. Try other words, or
              fewer.
            </Trans>
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <ol {...stylex.props(styles.list)}>
      {hits.map((hit) => (
        <li
          key={`${hit.documentId}:${hit.section}`}
          {...stylex.props(styles.hit)}
        >
          <RouterLink
            params={{ collection: hit.collectionId }}
            search={{ doc: hit.documentId }}
            to="/knowledge/$collection"
            variant="standalone"
          >
            {hit.title}
          </RouterLink>
          <Text size="xs" tone="muted">
            {[collections.get(hit.collectionId) ?? hit.path, ...hit.headings]
              .filter((part) => part !== "")
              .join(" › ")}
          </Text>
          <Text size="sm" tone="muted">
            {hit.snippet}
          </Text>
        </li>
      ))}
    </ol>
  );
};

/** The memory files, as the first block: what every agent always has. */
const MemoryBlock = ({ memory }: { memory: MemoryFiles }) => {
  const { t } = useLingui();
  return (
    <div {...stylex.props(styles.memory)}>
      <div {...stylex.props(styles.memoryPanel)}>
        {memory.memory === null ? (
          <Card>
            <CardMedia>
              <Panel short>
                <MemoryDrawing />
              </Panel>
            </CardMedia>
          </Card>
        ) : (
          <CardLink
            aria-label={t`Memory`}
            render={
              <Link
                params={{ collection: memory.memory }}
                search={{}}
                to="/knowledge/$collection"
              />
            }
          >
            <CardMedia>
              <Panel short>
                <MemoryDrawing />
              </Panel>
            </CardMedia>
          </CardLink>
        )}
      </div>
      <div {...stylex.props(styles.memoryWords)}>
        <Text size="sm" tone="muted">
          <Trans>What every agent has in its context, all the time.</Trans>
        </Text>
        {memory.files.length === 0 ? (
          <Text size="sm" tone="muted">
            <Trans>No memory files are written yet.</Trans>
          </Text>
        ) : (
          <ul {...stylex.props(styles.files)}>
            {memory.files.map((file) => (
              <li key={file.id}>
                <Text element="span" size="sm">
                  <RouterLink
                    params={{ collection: file.collectionId }}
                    search={{ doc: file.id }}
                    to="/knowledge/$collection"
                    variant="standalone"
                  >
                    {file.path}
                  </RouterLink>{" "}
                  <Text element="span" size="sm" tone="muted">
                    {file.collectionId === memory.personal
                      ? t`(yours)`
                      : t`(company)`}
                  </Text>
                </Text>
              </li>
            ))}
          </ul>
        )}
        {memory.memory === null ? (
          <Text size="sm" tone="muted">
            <Trans>An admin hasn&apos;t set up company memory yet.</Trans>
          </Text>
        ) : null}
      </div>
    </div>
  );
};

/** How many of a collection's latest documents its block shows. */
const latestShown = 3;

/** How many files a collection has, as far as its first page tells. */
const useFileCount = (count: number): string => {
  const { t } = useLingui();
  if (count === 0) {
    return t`No files yet.`;
  }
  if (count === pageMaxLimit) {
    return t`${count} or more files`;
  }
  return plural(count, { one: "# file", other: "# files" });
};

/**
 * The documents last saved in a collection, newest first, with how many it
 * has. Read from its first page: past that (a collection of more than a
 * page) they are the latest of that page, and the count says "or more".
 */
const LatestDocuments = ({ documents }: { documents: DocumentSummary[] }) => {
  const latest = documents
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, latestShown);
  const count = useFileCount(documents.length);
  return (
    <div {...stylex.props(styles.latest)}>
      {latest.length === 0 ? null : (
        <ItemGroup>
          {latest.map((document) => (
            <Item
              key={document.id}
              render={
                <Link
                  params={{ collection: document.collectionId }}
                  search={{ doc: document.id }}
                  to="/knowledge/$collection"
                />
              }
              size="xs"
            >
              <ItemMedia icon={File} iconLook="inline" />
              <ItemContent>
                <ItemTitle>{document.title}</ItemTitle>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      )}
      <Text size="xs" tone="muted">
        {count}
      </Text>
    </div>
  );
};

/** A block per collection, three to a row, each opening its own page. */
const CollectionBlocks = ({
  collections,
  firstPages,
}: {
  collections: Collection[];
  /** Each collection's first page of documents, where core listed it. */
  firstPages: ReadonlyMap<string, DocumentSummary[]>;
}) => {
  if (collections.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia icon={Folder} />
          <EmptyTitle>
            <Trans>There are no collections you can read yet.</Trans>
          </EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <ul {...stylex.props(styles.blocks)}>
      {collections.map((collection) => {
        const documents = firstPages.get(collection.id);
        return (
          <li key={collection.id} {...stylex.props(styles.block)}>
            <CardLink
              render={
                <Link
                  params={{ collection: collection.id }}
                  search={{}}
                  to="/knowledge/$collection"
                />
              }
            >
              <CardMedia>
                <Panel>
                  <CollectionDrawing collection={collection} />
                </Panel>
              </CardMedia>
              <CardTitle>{collection.name}</CardTitle>
              {collection.description === "" ? null : (
                <CardDescription>{collection.description}</CardDescription>
              )}
            </CardLink>
            <CollectionMarkers collection={collection} />
            {documents === undefined ? null : (
              <LatestDocuments documents={documents} />
            )}
          </li>
        );
      })}
    </ul>
  );
};

const Knowledge = () => {
  const { t } = useLingui();
  const { nav, results, firstPages } = Route.useLoaderData();
  const { q } = Route.useSearch();
  const { identity } = Route.useRouteContext();
  const { collections, memory } = nav;
  const names = new Map(
    collections.state === "ready"
      ? collections.data.map(({ id, name }) => [id, name])
      : []
  );
  return (
    <KnowledgeFrame
      at={{}}
      crumbs={
        q === undefined
          ? [{ label: t`Knowledge` }]
          : [{ label: t`Knowledge`, to: "/knowledge" }, { label: q }]
      }
      data={nav}
    >
      <div {...stylex.props(styles.scroll)}>
        <div {...stylex.props(styles.column)}>
          <PageHeading title={<Trans>Knowledge</Trans>} />
          {results === undefined ? null : (
            <section
              aria-labelledby="results"
              {...stylex.props(styles.section)}
            >
              <SectionTitle id="results">
                <Trans>Results</Trans>
              </SectionTitle>
              <NotLoaded page={results} />
              {results.state === "ready" ? (
                <SearchResults collections={names} hits={results.data.hits} />
              ) : null}
            </section>
          )}
          <section aria-labelledby="memory" {...stylex.props(styles.section)}>
            <SectionTitle id="memory">
              <Trans>Memory</Trans>
            </SectionTitle>
            <NotLoaded page={memory} />
            {memory.state === "ready" ? (
              <MemoryBlock memory={memory.data} />
            ) : null}
          </section>
          <section
            aria-labelledby="collections"
            {...stylex.props(styles.section)}
          >
            <div {...stylex.props(styles.sectionHead)}>
              <SectionTitle id="collections">
                <Trans>Collections</Trans>
              </SectionTitle>
              <NewCollection identity={identity} />
            </div>
            <NotLoaded page={collections} />
            {collections.state === "ready" ? (
              <CollectionBlocks
                collections={collections.data}
                firstPages={firstPages}
              />
            ) : null}
          </section>
        </div>
      </div>
    </KnowledgeFrame>
  );
};

export const Route = createFileRoute("/_shell/knowledge/")({
  // It fills the page\'s card, its panes scrolling on their own (frame/page-fill.ts).
  staticData: { page: "fill" },
  validateSearch: (search: Record<string, unknown>): { q?: string } =>
    typeof search.q === "string" && search.q.trim() !== ""
      ? { q: search.q.slice(0, knowledgeSearchMaxLength) }
      : {},
  loaderDeps: ({ search: { q } }) => ({ q }),
  // Each part says on its own why it failed; search runs beside the rest.
  loader: async ({ abortController, context: { core }, deps: { q } }) => {
    const [nav, results] = await Promise.all([
      loadKnowledgeNav(core, abortController.signal),
      q === undefined
        ? undefined
        : loadFromCore(
            core,
            async (session) => await session.knowledge.search(q)
          ),
    ]);
    // Each collection's first page, for its block's latest documents: one
    // that fails shows its block without them.
    const listed =
      nav.collections.state === "ready"
        ? await Promise.all(
            nav.collections.data.map(
              async ({ id }) =>
                [
                  id,
                  await loadFromCore(core, async (session) => {
                    const page = await session.knowledge.listDocuments(id);
                    return page.documents;
                  }),
                ] as const
            )
          )
        : [];
    const firstPages = new Map(
      listed.flatMap(([id, page]) =>
        page.state === "ready" ? [[id, page.data] as const] : []
      )
    );
    return { nav, results, firstPages };
  },
  component: Knowledge,
});
