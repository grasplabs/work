import type { DocumentSummary } from "@grasp-os/shared/knowledge";
import { pageMaxLimit, searchQueryMaxLength } from "@grasp-os/shared/knowledge";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import { usePageSidebarFold } from "../frame/page-sidebar.tsx";
import { Button } from "../grasp/button/index.ts";
import {
  File,
  Folder as FolderIcon,
  Home,
  Note,
  PanelToggle,
  Search,
} from "../grasp/icons/index.ts";
import {
  InputGroup,
  InputGroupInput,
  InputGroupText,
} from "../grasp/input-group/index.ts";
import { Separator } from "../grasp/separator/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import { Tree } from "../grasp/tree/index.ts";
import type { TreeNode } from "../grasp/tree/index.ts";
import { loadFromCore, NotLoaded, notLoadedText } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";
import { useCore } from "../use-core.ts";
import { CollectionMarks, collectionIconOf } from "./collection-markers.tsx";
import type { KnowledgeNavData } from "./nav-data.ts";
import { countDocuments, folderTree, foldersTo } from "./tree.ts";
import type { Folder } from "./tree.ts";

// Knowledge's navigation beside the page, in the prototype's look
// (grasplabs/prototype `components/brain-nav.tsx`), on Grasp UI's Tree:
// search at the top, the home, the memory files pinned under it, then one
// branch per collection the person may read, which opens in place to its
// folders and documents, a page at a time. The open document is marked
// and its folders open. The home, the memory files, the collections and
// the documents are the router's links, so they open in a new tab too;
// folders and "Show more" are the tree's own actions. It folds to a rail of
// icons.

/** Where the person is: the collection open, and the document in it. */
export interface KnowledgeAt {
  collection?: string;
  document?: DocumentSummary;
  /** The collection's first page of documents, when the page read it. */
  documents?: DocumentSummary[];
}

/** A collection's documents, as far as the navigation has read them. */
interface Listed {
  documents: DocumentSummary[];
  /** Whether there may be more after them. */
  more: boolean;
  /** Whether they go past the first page: the person asked for more. */
  extended: boolean;
  failure?: Loaded<unknown>;
}

const styles = stylex.create({
  // Beside the page from a tablet's width; on a phone the frame's sheet
  // holds the tree instead.
  side: {
    display: { default: "none", [media.fromTablet]: "flex" },
    flexDirection: "column",
    flexShrink: 0,
    minHeight: 0,
    borderInlineEndWidth: grasp.hairline,
    borderInlineEndStyle: "solid",
    borderInlineEndColor: grasp.line,
  },
  open: { width: grasp.sidebarWidth },
  rail: {
    alignItems: "center",
    gap: grasp.space1,
    paddingBlock: grasp.space2,
    paddingInline: grasp.space2,
    overflowY: "auto",
  },
  tree: { display: "flex", flexDirection: "column", minHeight: 0, flex: 1 },
  top: {
    display: "flex",
    alignItems: "center",
    gap: grasp.space1,
    padding: grasp.space2,
  },
  search: { flex: 1, minWidth: 0 },
  body: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space2,
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    paddingInline: grasp.space2,
    paddingBlockEnd: grasp.space4,
  },
});

/** The set with `key` added when it was missing, removed when it was there. */
const flip = (before: ReadonlySet<string>, key: string): Set<string> => {
  const next = new Set(before);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  return next;
};

/** Search, in the navigation's top row: core's search, on the home page. */
const SearchField = () => {
  const navigate = useNavigate();
  // On the results, the box starts from what was searched.
  const { q: searched } = useSearch({ strict: false });
  const [typed, setTyped] = useState(searched ?? "");
  const { t } = useLingui();
  return (
    <search {...stylex.props(styles.search)}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const q = typed.trim();
          void navigate({ to: "/knowledge", search: q === "" ? {} : { q } });
        }}
      >
        <InputGroup>
          <InputGroupText icon={Search} />
          <InputGroupInput
            aria-label={t`Search Knowledge`}
            maxLength={searchQueryMaxLength}
            onValueChange={(value) => {
              setTyped(value);
            }}
            placeholder={t`Search Knowledge`}
            type="search"
            value={typed}
          />
        </InputGroup>
      </form>
    </search>
  );
};

/** A page of `collection`'s documents after `earlier`, or its first page. */
const readListing = async (
  core: CoreConnection,
  collection: string,
  earlier: readonly DocumentSummary[] = []
): Promise<Listed> => {
  const after = earlier.at(-1)?.path;
  const page = await loadFromCore(
    core,
    async (session) =>
      await session.knowledge.listDocuments(
        collection,
        after === undefined ? {} : { after }
      )
  );
  const extended = earlier.length > 0;
  return page.state === "ready"
    ? {
        documents: [...earlier, ...page.data.documents],
        more: page.data.documents.length === pageMaxLimit,
        extended,
      }
    : { documents: [...earlier], more: false, extended, failure: page };
};

/**
 * The documents of the collections that are open, read when one opens and
 * again whenever the page read its data again; the open collection's first
 * page as the page read it.
 */
const useListed = (
  opened: ReadonlySet<string>,
  at: KnowledgeAt,
  data: KnowledgeNavData
): {
  listed: ReadonlyMap<string, Listed>;
  more: (collection: string) => void;
} => {
  const core = useCore();
  const [listed, setListed] = useState<ReadonlyMap<string, Listed>>(new Map());
  const keep = (collection: string, listing: Listed): void => {
    setListed((before) => new Map([...before, [collection, listing]]));
  };
  const {
    collection: atCollection,
    documents: atDocuments,
    document: atDocument,
  } = at;
  const { collections } = data;
  // The collections the listings were read for, and the ones read since:
  // opening another collection reads only that one, so a listing the person
  // extended with "Show more" keeps its pages until the page reads again.
  const readFor = useRef(collections);
  const read = useRef(new Set<string>());
  useEffect(() => {
    // Read again whenever the page read the collections again; nothing to
    // read while they failed.
    if (collections.state !== "ready") {
      return;
    }
    if (readFor.current !== collections) {
      readFor.current = collections;
      read.current = new Set();
    }
    const toRead = [...opened].filter(
      (collection) =>
        !read.current.has(collection) &&
        (collection !== atCollection || atDocuments === undefined)
    );
    for (const collection of toRead) {
      read.current.add(collection);
    }
    const readOpened = async (): Promise<void> => {
      const listings = await Promise.all(
        toRead.map(
          async (collection) =>
            [collection, await readListing(core, collection)] as const
        )
      );
      // Kept unless the page has read its collections again meanwhile: then
      // a newer read is on its way.
      if (readFor.current === collections) {
        setListed((before) => new Map([...before, ...listings]));
      }
    };
    void readOpened();
  }, [opened, collections, core, atCollection, atDocuments]);
  // The open collection's first page as the page read it, unless the person
  // asked for more of it here; and the open document in it even past that
  // page, so it is always there, marked.
  const shown = new Map(listed);
  if (
    atCollection !== undefined &&
    atDocuments !== undefined &&
    listed.get(atCollection)?.extended !== true
  ) {
    shown.set(atCollection, {
      documents: atDocuments,
      more: atDocuments.length === pageMaxLimit,
      extended: false,
    });
  }
  // The pages as read, before the open document is added for display:
  // "Show more" reads on from these, so it never skips past what lies
  // between a page's end and an open document beyond it.
  const paged = new Map(shown);
  const atListing =
    atCollection === undefined ? undefined : shown.get(atCollection);
  if (
    atCollection !== undefined &&
    atListing !== undefined &&
    atDocument !== undefined &&
    !atListing.documents.some(({ id }) => id === atDocument.id)
  ) {
    shown.set(atCollection, {
      ...atListing,
      documents: [...atListing.documents, atDocument],
    });
  }
  return {
    listed: shown,
    more: (collection) => {
      const readMore = async (): Promise<void> => {
        keep(
          collection,
          await readListing(core, collection, paged.get(collection)?.documents)
        );
      };
      void readMore();
    },
  };
};

/** What an item of the tree that isn't a link does. */
type Target =
  | { to: "folder"; value: string }
  | { to: "more"; collection: string };

/** A collection's page, or a document on it, as the router's link for a row. */
const linkTo = (collection: string, doc?: string) => (
  <Link
    params={{ collection }}
    search={doc === undefined ? {} : { doc }}
    to="/knowledge/$collection"
  />
);

/** The words the tree's items say that aren't names. */
interface TreeWords {
  knowledge: string;
  loading: string;
  none: string;
  more: string;
  failed: (failure: Loaded<unknown>) => string;
}

/** A folder's value in the tree: by its collection and path. */
const folderValue = (collection: string, path: string): string =>
  `f:${collection}/${path}`;

/** A collection's documents and folders as items, each kept with its target. */
const entriesOf = (
  collection: string,
  folder: Folder,
  targets: Map<string, Target>
): TreeNode[] => [
  ...folder.documents.map((document): TreeNode => ({
    value: `d:${document.id}`,
    label: document.path.split("/").at(-1) ?? document.path,
    icon: File,
    render: linkTo(document.collectionId, document.id),
  })),
  ...folder.folders.map((inner): TreeNode => {
    const value = folderValue(collection, inner.path);
    targets.set(value, { to: "folder", value });
    return {
      value,
      label: inner.name,
      icon: FolderIcon,
      end: countDocuments(inner),
      children: entriesOf(collection, inner, targets),
    };
  }),
];

/** A collection's items under it: its documents, or why there are none yet. */
const listingOf = (
  collection: string,
  listing: Listed | undefined,
  words: TreeWords,
  targets: Map<string, Target>
): TreeNode[] => {
  if (listing === undefined) {
    return [
      { value: `loading:${collection}`, label: words.loading, disabled: true },
    ];
  }
  const nodes = entriesOf(collection, folderTree(listing.documents), targets);
  if (listing.documents.length === 0 && listing.failure === undefined) {
    nodes.push({
      value: `none:${collection}`,
      label: words.none,
      disabled: true,
    });
  }
  if (listing.failure !== undefined) {
    nodes.push({
      value: `failed:${collection}`,
      label: words.failed(listing.failure),
      disabled: true,
    });
  }
  if (listing.more) {
    const value = `more:${collection}`;
    targets.set(value, { to: "more", collection });
    nodes.push({ value, label: words.more });
  }
  return nodes;
};

/** The tree's items, and where each leads. */
const itemsOf = (
  data: KnowledgeNavData,
  listed: ReadonlyMap<string, Listed>,
  opened: ReadonlySet<string>,
  words: TreeWords
): { items: TreeNode[]; targets: Map<string, Target> } => {
  const targets = new Map<string, Target>();
  const items: TreeNode[] = [
    {
      value: "home",
      label: words.knowledge,
      icon: Home,
      render: <Link search={{}} to="/knowledge" />,
    },
  ];
  const memoryFiles =
    data.memory.state === "ready" ? data.memory.data.files : [];
  for (const file of memoryFiles) {
    items.push({
      value: `m:${file.id}`,
      label: file.path,
      icon: Note,
      render: linkTo(file.collectionId, file.id),
    });
  }
  const collections =
    data.collections.state === "ready" ? data.collections.data : [];
  for (const collection of collections) {
    items.push({
      value: `c:${collection.id}`,
      label: collection.name,
      icon: collectionIconOf(collection),
      end: <CollectionMarks collection={collection} />,
      render: linkTo(collection.id),
      // Only an open collection is read: a closed one waits, empty.
      children: opened.has(collection.id)
        ? listingOf(collection.id, listed.get(collection.id), words, targets)
        : [],
    });
  }
  return { items, targets };
};

/** The item that is the page open: the document, else the collection, else the home. */
const currentOf = (at: KnowledgeAt, data: KnowledgeNavData): string => {
  const doc = at.document?.id;
  if (doc !== undefined) {
    const memory =
      data.memory.state === "ready" &&
      data.memory.data.files.some(({ id }) => id === doc);
    return memory ? `m:${doc}` : `d:${doc}`;
  }
  return at.collection === undefined ? "home" : `c:${at.collection}`;
};

/** The folders on the way to the open document, as the tree's values. */
const foldersOpenAt = (at: KnowledgeAt): string[] => {
  const { collection, document } = at;
  if (collection === undefined || document === undefined) {
    return [];
  }
  return foldersTo(document.path).map((path) => folderValue(collection, path));
};

/** The navigation itself, open: what the sidebar and the phone's sheet show. */
export const KnowledgeTree = ({
  data,
  at,
  fold,
}: {
  data: KnowledgeNavData;
  at: KnowledgeAt;
  fold?: { label: string; onFold: () => void };
}) => {
  const { t, i18n } = useLingui();
  // The collections and folders open: the way to where the person is opens
  // once, and after that closes like anything else.
  const [opened, setOpened] = useState<ReadonlySet<string>>(
    () => new Set(at.collection === undefined ? [] : [at.collection])
  );
  const [folders, setFolders] = useState<ReadonlySet<string>>(
    () => new Set(foldersOpenAt(at))
  );
  const [revealed, setRevealed] = useState(at.document?.id);
  if (at.document !== undefined && revealed !== at.document.id) {
    setRevealed(at.document.id);
    const { collection } = at;
    if (collection !== undefined) {
      setOpened((before) => new Set([...before, collection]));
    }
    setFolders((before) => new Set([...before, ...foldersOpenAt(at)]));
  }
  const { listed, more } = useListed(opened, at, data);
  const { items, targets } = itemsOf(data, listed, opened, {
    knowledge: t`Knowledge`,
    loading: t`Loading…`,
    none: t`No files yet.`,
    more: t`Show more`,
    failed: (failure) => notLoadedText(failure, i18n) ?? "",
  });
  // A row that is a link goes by its link; the rest act here.
  const run = (value: string): void => {
    const target = targets.get(value);
    if (target === undefined) {
      return;
    }
    if (target.to === "folder") {
      setFolders((before) => flip(before, target.value));
    } else {
      more(target.collection);
    }
  };
  return (
    <div {...stylex.props(styles.tree)}>
      <div {...stylex.props(styles.top)}>
        <SearchField />
        {fold === undefined ? null : (
          <Button
            aria-label={fold.label}
            icon={PanelToggle}
            onClick={() => {
              fold.onFold();
            }}
            size="sm"
            variant="ghost"
          />
        )}
      </div>
      <div {...stylex.props(styles.body)}>
        <NotLoaded page={data.collections} />
        <NotLoaded page={data.memory} />
        <Tree
          aria-label={t`Knowledge`}
          current={currentOf(at, data)}
          expandOnPress={false}
          expanded={[
            ...[...opened].map((collection) => `c:${collection}`),
            ...folders,
          ]}
          items={items}
          mode="none"
          onAction={run}
          onExpandedChange={(expanded) => {
            setOpened(
              new Set(
                expanded.flatMap((value) =>
                  value.startsWith("c:") ? [value.slice(2)] : []
                )
              )
            );
            setFolders(
              new Set(expanded.filter((value) => value.startsWith("f:")))
            );
          }}
        />
      </div>
    </div>
  );
};

/** Knowledge's navigation beside the page: the tree, or folded, a rail of its collections. */
export const KnowledgeNav = ({
  data,
  at,
}: {
  data: KnowledgeNavData;
  at: KnowledgeAt;
}) => {
  const { t } = useLingui();
  const [folded, setFolded] = usePageSidebarFold("knowledge");
  if (folded) {
    return (
      <nav
        aria-label={t`Knowledge`}
        {...stylex.props(styles.side, styles.rail)}
      >
        <Button
          aria-label={t`Expand the navigation`}
          icon={PanelToggle}
          onClick={() => {
            setFolded(false);
          }}
          size="sm"
          variant="ghost"
        />
        <Separator />
        <Button
          aria-current={at.collection === undefined ? "page" : undefined}
          aria-label={t`Knowledge`}
          icon={Home}
          render={<Link search={{}} to="/knowledge" />}
          size="sm"
          variant="ghost"
        />
        {data.collections.state === "ready"
          ? data.collections.data.map((collection) => (
              <Button
                aria-current={
                  collection.id === at.collection ? "page" : undefined
                }
                aria-label={collection.name}
                icon={collectionIconOf(collection)}
                key={collection.id}
                render={
                  <Link
                    params={{ collection: collection.id }}
                    search={{}}
                    to="/knowledge/$collection"
                  />
                }
                size="sm"
                variant="ghost"
              />
            ))
          : null}
      </nav>
    );
  }
  return (
    <nav aria-label={t`Knowledge`} {...stylex.props(styles.side, styles.open)}>
      <KnowledgeTree
        at={at}
        data={data}
        fold={{
          label: t`Fold the navigation`,
          onFold: () => {
            setFolded(true);
          },
        }}
      />
    </nav>
  );
};
