import type {
  Backlink,
  DocumentRead,
  VersionSummary,
} from "@grasp-os/shared/knowledge";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { copyText } from "../copy.ts";
import { ErrorText } from "../error-text.tsx";
import { exportAs } from "../export/export-file.tsx";
import type { ExportFormat } from "../export/export-file.tsx";
import { formatDay } from "../format.ts";
import { useFollowLinks } from "../frame/follow-links.ts";
import { RouterLink } from "../frame/router-link.tsx";
import { Alert } from "../grasp/alert/index.ts";
import { PageBrain } from "../grasp/blocks/page-brain/page-brain.tsx";
import { Button } from "../grasp/button/index.ts";
import { DropdownMenuMore } from "../grasp/dropdown-menu/index.ts";
import type { DropdownMenuAction } from "../grasp/dropdown-menu/index.ts";
import { Heading } from "../grasp/heading/index.ts";
import {
  CalendarIcon,
  Clock,
  Doc,
  Edit,
  Folder,
  Link as LinkIcon,
  Pdf,
  Rows,
  TextParagraph,
} from "../grasp/icons/index.ts";
import { Input } from "../grasp/input/index.ts";
import type { PageVersion } from "../grasp/page-history/index.ts";
import type { PageFact } from "../grasp/page-properties/index.ts";
import { Textarea } from "../grasp/textarea/index.ts";
import { toast } from "../grasp/toast/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import { useCoreAction } from "../use-core-action.ts";
import {
  DocumentMarkdown,
  documentLinksOf,
  readingMarkdown,
} from "./markdown.tsx";
import { saveOrNewer } from "./save.ts";
import type { ResolveLink } from "./wiki-links.ts";

// One document as a Brain page (the library's page-brain, Ruben's pick D):
// its title, its facts one quiet press away under Properties, and its text.
// Its actions stand at the end of the bar: Share, then "…" with Edit, the
// downloads and History, where a version is brought back as the next one.
// The text is read on the page and changed in its Markdown, as written:
// DocumentEditor writes Markdown back changed (`[[links]]` escaped, HTML and
// images dropped), so editing in place waits for it to keep a document as it
// is. Every save names the version it was edited from, so a save that would
// overwrite one made since, in another tab or by someone else, shows that
// version instead.

const styles = stylex.create({
  view: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    overflowY: "auto",
    paddingInline: { default: grasp.space6, [media.fromTablet]: grasp.space12 },
    paddingBlockEnd: grasp.space24,
  },
  // Page-brain's reading column, for what stands above the page and for the editor.
  column: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space4,
    boxSizing: "border-box",
    width: "100%",
    maxWidth: {
      default: `calc(44rem + ${grasp.space16})`,
      [media.belowPhone]: "44rem",
    },
    marginInline: "auto",
    paddingBlockStart: {
      default: grasp.space8,
      [media.belowPhone]: grasp.space2,
    },
    paddingInlineStart: { default: grasp.space16, [media.belowPhone]: 0 },
  },
  form: { display: "flex", flexDirection: "column", gap: grasp.space3 },
  newer: { display: "flex", flexDirection: "column", gap: grasp.space2 },
  start: { alignSelf: "flex-start" },
  buttons: { display: "flex", flexWrap: "wrap", gap: grasp.space2 },
  earlier: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: grasp.space2,
  },
  links: {
    display: "flex",
    flexWrap: "wrap",
    columnGap: grasp.space3,
    rowGap: grasp.space1,
  },
});

const Editor = ({
  doc,
  resolve,
  onClose,
}: {
  doc: DocumentRead;
  resolve: ResolveLink;
  onClose: () => void;
}) => {
  const router = useRouter();
  const { busy, failure, run } = useCoreAction();
  const [text, setText] = useState(doc.version.text);
  const [message, setMessage] = useState("");
  // The version this text is edited from.
  const [base, setBase] = useState(doc.currentVersion);
  // A version saved since `base`, shown after a conflict. While it is, a
  // save would replace it: only the explicit "Replace" does, or the person
  // starts again from it.
  const [newer, setNewer] = useState<DocumentRead>();
  const { t } = useLingui();
  const newerVersion = newer?.currentVersion;
  /** Saves the text as the version after `from`. */
  const save = async (from: number): Promise<void> => {
    const outcome = await run(async (session) => {
      const result = await saveOrNewer(session, doc.id, {
        collectionId: doc.collectionId,
        path: doc.path,
        text,
        ifVersion: from,
        ...(message.trim() === "" ? {} : { message }),
      });
      if ("saved" in result) {
        // `sync` waits for the loader: the page shows the new version.
        await router.invalidate({ sync: true });
      }
      return result;
    });
    if (outcome === undefined) {
      return;
    }
    if ("newer" in outcome) {
      setNewer(outcome.newer);
      return;
    }
    onClose();
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        // With a newer version shown, only the explicit button replaces it.
        if (newer === undefined) {
          void save(base);
        }
      }}
      {...stylex.props(styles.form)}
    >
      {newer === undefined ? null : (
        <section
          aria-labelledby="newer-version"
          {...stylex.props(styles.newer)}
        >
          <Alert id="newer-version" tone="danger">
            {t`This document changed since you opened it. Version ${newerVersion} is below; your text is kept. Start again from it, or replace it with your text.`}
          </Alert>
          <DocumentMarkdown resolve={resolve} text={newer.version.text} />
          <Button
            layout={styles.start}
            onClick={() => {
              setText(newer.version.text);
              setBase(newer.currentVersion);
              setNewer(undefined);
            }}
            type="button"
            variant="quiet"
          >
            {t`Start again from version ${newerVersion}`}
          </Button>
        </section>
      )}
      <Textarea
        aria-label={t`Text`}
        onValueChange={(value) => {
          setText(value);
        }}
        rows={16}
        value={text}
      />
      <Input
        aria-label={t`What changed`}
        maxLength={500}
        onValueChange={(value) => {
          setMessage(value);
        }}
        placeholder={t`What changed`}
        value={message}
      />
      <div {...stylex.props(styles.buttons)}>
        {newer === undefined ? (
          <Button disabled={busy} type="submit" variant="ink">
            <Trans>Save</Trans>
          </Button>
        ) : (
          <Button
            disabled={busy}
            onClick={() => {
              void save(newer.currentVersion);
            }}
            type="button"
            variant="danger"
          >
            {t`Replace version ${newerVersion} with mine`}
          </Button>
        )}
        <Button disabled={busy} onClick={onClose} type="button" variant="quiet">
          <Trans>Cancel</Trans>
        </Button>
      </div>
      <ErrorText>{failure}</ErrorText>
    </form>
  );
};

/** The name a document exports under: its file's, without `.md`. */
const fileNameOf = (doc: DocumentRead): string => {
  const name = doc.path.split("/").at(-1) ?? doc.title;
  return name.endsWith(".md") ? name.slice(0, -3) : name;
};

/** A document this one links to, by its ID, named as the link names it. */
interface Linked {
  collectionId: string;
  documentId: string;
  title: string;
}

/** The documents the text links to that `resolve` knows, named as the text names them. */
const linksOf = (doc: DocumentRead, resolve: ResolveLink): Linked[] =>
  documentLinksOf(doc.version.text, resolve).map(({ documentId, words }) => ({
    collectionId: doc.collectionId,
    documentId,
    title: words,
  }));

/** Documents as links to them, side by side: what this one links to, or what links to it. */
const DocumentLinks = ({ documents }: { documents: readonly Linked[] }) => (
  <span {...stylex.props(styles.links)}>
    {documents.map((document) => (
      <RouterLink
        key={document.documentId}
        params={{ collection: document.collectionId }}
        search={{ doc: document.documentId }}
        to="/knowledge/$collection"
        variant="standalone"
      >
        {document.title}
      </RouterLink>
    ))}
  </span>
);

/**
 * The document's facts, behind the page's Properties: first what every page has (its collection,
 * when it changed and its version), then when to use it, when to review it, and what it links to
 * and what links to it, where it has them.
 */
const useFacts = ({
  doc,
  collection,
  links,
  backlinks,
}: {
  doc: DocumentRead;
  collection: string;
  links: readonly Linked[];
  backlinks: readonly Backlink[];
}): PageFact[] => {
  const { t } = useLingui();
  return [
    {
      key: t`Collection`,
      icon: Folder,
      value: (
        <RouterLink
          params={{ collection: doc.collectionId }}
          search={{}}
          to="/knowledge/$collection"
          variant="standalone"
        >
          {collection}
        </RouterLink>
      ),
    },
    {
      key: t`Updated`,
      icon: Clock,
      value: formatDay(doc.version.createdAt),
    },
    { key: t`Version`, icon: Rows, value: String(doc.version.number) },
    ...(doc.description === ""
      ? []
      : [{ key: t`Description`, icon: TextParagraph, value: doc.description }]),
    ...(doc.reviewDate === null
      ? []
      : [
          {
            key: t`Review by`,
            icon: CalendarIcon,
            value: formatDay(doc.reviewDate),
          },
        ]),
    ...(links.length === 0
      ? []
      : [
          {
            key: t`Links to`,
            icon: LinkIcon,
            value: <DocumentLinks documents={links} />,
          },
        ]),
    ...(backlinks.length === 0
      ? []
      : [
          {
            key: t`Used by`,
            icon: LinkIcon,
            value: <DocumentLinks documents={backlinks} />,
          },
        ]),
  ];
};

/** Says an earlier version is open, with the way back to the current one. */
const EarlierVersion = ({ doc }: { doc: DocumentRead }) => {
  const { t, i18n } = useLingui();
  const { number } = doc.version;
  const current = doc.currentVersion;
  const saved = new Date(doc.version.createdAt).toLocaleDateString(
    i18n.locale,
    { day: "numeric", month: "short", year: "numeric" }
  );
  return (
    <Alert role="none">
      <span {...stylex.props(styles.earlier)}>
        <span>
          {t`You're reading version ${number}, saved ${saved}. The current version is ${current}.`}
        </span>
        <RouterLink
          params={{ collection: doc.collectionId }}
          search={{ doc: doc.id }}
          to="/knowledge/$collection"
          variant="standalone"
        >
          <Trans>Back to the current version</Trans>
        </RouterLink>
      </span>
    </Alert>
  );
};

/** The versions in History, the newest first, each with its text. */
interface DocumentHistory {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  versions: PageVersion[];
}

/**
 * The open document's page: its History, opened from the bar, where every version's text is read
 * as it opens, so the changes show against the text as it stands; and its editor, open on one
 * version, so another opens read. A person's own saves are "You"; another author can't be named
 * here yet (core gives an id, which is never shown), so it is "Someone".
 */
export const useDocumentPage = ({
  read,
  me,
  writable,
}: {
  /** The open document and its versions; none while none is open. */
  read: { doc: DocumentRead; versions: readonly VersionSummary[] } | undefined;
  me: string;
  writable: boolean;
}) => {
  const { t } = useLingui();
  const { run } = useCoreAction();
  const [open, setOpen] = useState(false);
  // Each version's text, for the document they were read for.
  const [loaded, setLoaded] = useState<{
    docId: string;
    texts: ReadonlyMap<number, string>;
  }>();
  const [editing, setEditing] = useState<string>();
  const doc = read?.doc;
  const versions = read?.versions ?? [];
  // The version shown, by its document and number.
  const key = doc === undefined ? undefined : `${doc.id}@${doc.version.number}`;
  const history: DocumentHistory = {
    open,
    onOpenChange: setOpen,
    versions: versions.flatMap((version) => {
      const markdown =
        loaded?.docId === doc?.id
          ? loaded?.texts.get(version.number)
          : undefined;
      const { number, restoredFrom } = version;
      return markdown === undefined
        ? []
        : [
            {
              id: String(number),
              who: version.author === me ? t`You` : t`Someone`,
              when: formatDay(version.createdAt),
              what:
                restoredFrom === null
                  ? (version.message ?? t`Version ${number}`)
                  : t`Restored version ${restoredFrom}`,
              markdown,
            },
          ];
    }),
  };
  // The current version, where the person may change it: its editor, and History, where a version is brought back.
  const changeable =
    writable && doc !== undefined && doc.version.number === doc.currentVersion;
  const openHistory = async (): Promise<void> => {
    if (doc === undefined) {
      return;
    }
    const docs = await run(
      async (session) =>
        await Promise.all(
          versions.map(
            async (version) =>
              await session.knowledge.getDocument(doc.id, version.number)
          )
        )
    );
    if (docs === undefined) {
      toast.error(t`The history didn't load. Try again.`);
      return;
    }
    setLoaded({
      docId: doc.id,
      texts: new Map(
        docs.map((each) => [each.version.number, each.version.text])
      ),
    });
    setOpen(true);
  };
  return {
    key,
    history,
    handleHistory: changeable
      ? () => {
          void openHistory();
        }
      : undefined,
    editing: editing !== undefined && editing === key,
    onEditingChange: (opened: boolean): void => {
      setEditing(opened ? key : undefined);
    },
    /** Opens the editor on the current version, where the person may change it. */
    handleEdit: changeable
      ? () => {
          setEditing(key);
        }
      : undefined,
  };
};

/** Keeps nothing: the page is read; the editor changes the text. */
const unchanged = () => {
  // The text is saved from the editor, as a new version.
};

/**
 * A document's actions at the end of the bar, as the library's Brain page has them: Share, then
 * "…" with Edit where the person may change it, the downloads and History. Share copies the page's
 * link: who may read it is the collection's to say.
 */
export const DocumentActions = ({
  doc,
  onEdit,
  onHistory,
}: {
  doc: DocumentRead;
  /** Opens the editor; none where the person may not change it. */
  onEdit: (() => void) | undefined;
  /** Opens the document's versions; none where the person may not bring one back. */
  onHistory: (() => void) | undefined;
}) => {
  const { t, i18n } = useLingui();
  const download = async (format: ExportFormat): Promise<void> => {
    try {
      await exportAs(
        {
          name: fileNameOf(doc),
          title: doc.title,
          markdown: () => doc.version.text,
        },
        format,
        i18n.locale
      );
    } catch {
      toast.error(t`The export didn't work. Try again.`);
    }
  };
  const actions: DropdownMenuAction[] = [
    ...(onEdit === undefined
      ? []
      : [{ label: t`Edit`, icon: Edit, onSelect: onEdit }]),
    {
      label: t`Download as Markdown`,
      icon: Doc,
      onSelect: () => {
        void download("md");
      },
    },
    {
      label: t`Download as PDF`,
      icon: Pdf,
      onSelect: () => {
        void download("pdf");
      },
    },
    ...(onHistory === undefined
      ? []
      : [{ label: t`History`, icon: Clock, onSelect: onHistory }]),
  ];
  return (
    <>
      <Button
        onClick={() => {
          void (async () => {
            if (await copyText(window.location.href)) {
              toast.success(t`Link copied`);
            } else {
              toast.error(t`Copying didn't work`);
            }
          })();
        }}
        size="sm"
        variant="ghost"
      >
        {t({ message: "Share", context: "a Brain page's link" })}
      </Button>
      <DropdownMenuMore actions={actions} label={t`More for this page`} />
    </>
  );
};

/**
 * A document as a Brain page, read only: its text is changed in the editor (`editing`), and an
 * earlier version, opened from History, is read with the way back to the current one.
 */
export const DocumentView = ({
  doc,
  collection,
  backlinks,
  resolve,
  history,
  editing,
  onEditingChange,
}: {
  doc: DocumentRead;
  /** The name of the collection it is in. */
  collection: string;
  backlinks: Backlink[];
  /** The collection's document at a `[[link]]`'s path, if the page has it. */
  resolve: ResolveLink;
  history: DocumentHistory;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
}) => {
  const router = useRouter();
  const { failure, run } = useCoreAction();
  const followLinks = useFollowLinks();
  // An earlier version, opened from the history: read only.
  const earlier = doc.version.number !== doc.currentVersion;
  const facts = useFacts({
    doc,
    collection,
    links: linksOf(doc, resolve),
    backlinks,
  });
  /** Brings an earlier version back as the next one, and shows it. */
  const restore = async (version: PageVersion): Promise<void> => {
    const restored = await run(
      async (session) =>
        await session.knowledge.restoreVersion({
          documentId: doc.id,
          version: Number(version.id),
          ifVersion: doc.currentVersion,
        })
    );
    history.onOpenChange(false);
    if (restored === undefined) {
      return;
    }
    await router.invalidate({ sync: true });
  };
  if (editing) {
    return (
      <div {...stylex.props(styles.view)}>
        <div {...stylex.props(styles.column)}>
          <Heading level={1}>{doc.title}</Heading>
          <Editor
            doc={doc}
            onClose={() => {
              onEditingChange(false);
            }}
            resolve={resolve}
          />
        </div>
      </div>
    );
  }
  return (
    <div {...stylex.props(styles.view)}>
      {earlier || failure !== undefined ? (
        <div {...stylex.props(styles.column)}>
          {earlier ? <EarlierVersion doc={doc} /> : null}
          <ErrorText>{failure}</ErrorText>
        </div>
      ) : null}
      <div ref={followLinks}>
        <PageBrain
          facts={facts}
          historyOpen={history.open}
          onHistoryOpenChange={(open) => {
            history.onOpenChange(open);
          }}
          onRestore={(version) => {
            void restore(version);
          }}
          onValueChange={unchanged}
          readOnly
          title={doc.title}
          value={readingMarkdown(doc.version.text, doc.title, resolve)}
          // Each version as the page reads it, so History shows what changed in the text.
          versions={history.versions.map((version) => ({
            ...version,
            markdown: readingMarkdown(version.markdown, doc.title, resolve),
          }))}
        />
      </div>
    </div>
  );
};
