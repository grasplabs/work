import { knowledgeSearchMaxLength } from "@grasp-os/shared/function-limits";
import type {
  Collection,
  DocumentSummary,
  SearchHit,
} from "@grasp-os/shared/knowledge";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute, Link } from "@tanstack/react-router";

import { PageHeading } from "../frame/page.tsx";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../grasp/empty/index.ts";
import { File, Search } from "../grasp/icons/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemDetail,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { Section, SectionHeader } from "../grasp/section-header/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import {
  CollectionMarkers,
  collectionIconOf,
} from "../knowledge/collection-markers.tsx";
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
    paddingBlock: grasp.space8,
    paddingInline: { default: grasp.space6, [media.fromTablet]: grasp.space12 },
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
    <ItemGroup separated>
      {hits.map((hit) => (
        <Item
          key={`${hit.documentId}:${hit.section}`}
          render={
            <Link
              params={{ collection: hit.collectionId }}
              search={{ doc: hit.documentId }}
              to="/knowledge/$collection"
            />
          }
          size="sm"
        >
          <ItemMedia icon={File} iconLook="inline" />
          <ItemContent>
            <ItemTitle>
              {hit.title}
              <ItemDetail>
                {[
                  collections.get(hit.collectionId) ?? hit.path,
                  ...hit.headings,
                ]
                  // A heading that only repeats the title says nothing.
                  .filter((part) => part !== "" && part !== hit.title)
                  .join(" › ")}
              </ItemDetail>
            </ItemTitle>
            <ItemDescription>{hit.snippet}</ItemDescription>
          </ItemContent>
        </Item>
      ))}
    </ItemGroup>
  );
};

// Concept B: Memory as rows of its files, collections as one list of rows.
const MemoryRowsB = ({ memory }: { memory: MemoryFiles }) =>
  memory.files.length === 0 ? (
    <Text size="sm" tone="muted">
      No memory files are written yet.
    </Text>
  ) : (
    <ItemGroup separated>
      {memory.files.map((file) => (
        <Item
          key={file.id}
          render={
            <Link
              params={{ collection: file.collectionId }}
              search={{ doc: file.id }}
              to="/knowledge/$collection"
            />
          }
          size="sm"
        >
          <ItemMedia icon={File} iconLook="inline" />
          <ItemContent>
            <ItemTitle>
              {file.path}
              <ItemDetail>
                {file.collectionId === memory.personal ? "Yours" : "Company"}
              </ItemDetail>
            </ItemTitle>
          </ItemContent>
        </Item>
      ))}
    </ItemGroup>
  );

const CollectionRowsB = ({
  collections,
  firstPages,
}: {
  collections: Collection[];
  firstPages: ReadonlyMap<string, DocumentSummary[]>;
}) => (
  <ItemGroup separated>
    {collections.map((collection) => {
      const n = firstPages.get(collection.id)?.length ?? 0;
      return (
        <Item
          key={collection.id}
          render={
            <Link
              params={{ collection: collection.id }}
              search={{}}
              to="/knowledge/$collection"
            />
          }
          size="sm"
        >
          <ItemMedia icon={collectionIconOf(collection)} iconLook="inline" />
          <ItemContent>
            <ItemTitle>
              {collection.name}
              <ItemDetail>{n === 1 ? "1 file" : `${n} files`}</ItemDetail>
            </ItemTitle>
            {collection.description === "" ? null : (
              <ItemDescription>{collection.description}</ItemDescription>
            )}
          </ItemContent>
          <ItemActions>
            <CollectionMarkers collection={collection} />
          </ItemActions>
        </Item>
      );
    })}
  </ItemGroup>
);

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
            <Section aria-labelledby="results">
              <SectionHeader id="results" title={<Trans>Results</Trans>} />
              <NotLoaded page={results} />
              {results.state === "ready" ? (
                <SearchResults collections={names} hits={results.data.hits} />
              ) : null}
            </Section>
          )}
          <Section aria-labelledby="memory">
            <SectionHeader
              description="What every agent has in its context, all the time."
              id="memory"
              title={<Trans>Memory</Trans>}
            />
            <NotLoaded page={memory} />
            {memory.state === "ready" ? (
              <MemoryRowsB memory={memory.data} />
            ) : null}
          </Section>
          <Section aria-labelledby="collections">
            <SectionHeader
              actions={<NewCollection identity={identity} />}
              id="collections"
              title={<Trans>Collections</Trans>}
            />
            <NotLoaded page={collections} />
            {collections.state === "ready" ? (
              <CollectionRowsB
                collections={collections.data}
                firstPages={firstPages}
              />
            ) : null}
          </Section>
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
