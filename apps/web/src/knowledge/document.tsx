import { linkPath, wikiLinkPattern } from "@grasp-os/shared/knowledge";
import type {
  Backlink,
  DocumentRead,
  VersionSummary,
} from "@grasp-os/shared/knowledge";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";

import { ErrorText } from "../error-text.tsx";
import { ExportMenu } from "../export/export-menu.tsx";
import { PageHeading } from "../frame/page.tsx";
import { RouterLink } from "../frame/router-link.tsx";
import { Alert } from "../grasp/alert/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import { Button } from "../grasp/button/index.ts";
import { Collapsible } from "../grasp/collapsible/index.ts";
import { Edit } from "../grasp/icons/index.ts";
import { Input } from "../grasp/input/index.ts";
import { KeyValueList } from "../grasp/key-value/index.ts";
import { Separator } from "../grasp/separator/index.ts";
import { Tag } from "../grasp/tag/index.ts";
import { Textarea } from "../grasp/textarea/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import { documentTypeLabel } from "../labels.ts";
import { useCoreAction } from "../use-core-action.ts";
import { DocumentMarkdown } from "./markdown.tsx";
import { saveOrNewer } from "./save.ts";
import { Timeline } from "./timeline.tsx";
import type { ResolveLink } from "./wiki-links.ts";

// One document, read like a note in the prototype's brain
// (grasplabs/prototype `routes/brain/$noteId.tsx`): its kind, title and
// when to use it, then its text, and its history as a timeline below it.
// Its details (where it is, what it links to and what links to it, its
// review date) sit beside it, or fold in at its foot on a narrower window. Where the person may change it: an editor, and
// restoring from its history. Every save names the version it was edited
// from, so a save that would overwrite one made since, in another tab or
// by someone else, shows that version instead.

const styles = stylex.create({
  form: { display: "flex", flexDirection: "column", gap: grasp.space3 },
  newer: { display: "flex", flexDirection: "column", gap: grasp.space2 },
  start: { alignSelf: "flex-start" },
  buttons: { display: "flex", flexWrap: "wrap", gap: grasp.space2 },
  chips: {
    display: "flex",
    flexWrap: "wrap",
    gap: grasp.space2,
    margin: 0,
    padding: 0,
    listStyleType: "none",
  },
  chip: { minWidth: 0 },
  earlier: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: grasp.space2,
  },
  view: { display: "flex", flex: 1, minWidth: 0, minHeight: 0 },
  scroll: { flex: 1, minWidth: 0, overflowY: "auto" },
  column: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space8,
    boxSizing: "border-box",
    width: "100%",
    maxWidth: grasp.pageColumnMeasure,
    marginInline: "auto",
    paddingBlock: grasp.space8,
    paddingInline: { default: grasp.space6, [media.fromTablet]: grasp.space12 },
  },
  actions: { display: "flex", alignItems: "center", gap: grasp.space2 },
  // Too narrow for the side: the details fold in at the foot instead.
  foot: {
    display: { default: "flex", [media.fromRail]: "none" },
    flexDirection: "column",
    gap: grasp.space4,
  },
  aside: {
    display: { default: "none", [media.fromRail]: "flex" },
    flexDirection: "column",
    flexShrink: 0,
    boxSizing: "border-box",
    width: grasp.inspectorWidth,
    overflowY: "auto",
    paddingBlock: grasp.space4,
    paddingInline: grasp.space5,
    borderInlineStartWidth: grasp.hairline,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: grasp.line,
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

/** A document another one links to, or that links to it, as a chip. */
const DocumentChip = ({
  collectionId,
  documentId,
  title,
}: {
  collectionId: string;
  documentId: string;
  title: string;
}) => (
  <Tag size="sm">
    <RouterLink
      params={{ collection: collectionId }}
      search={{ doc: documentId }}
      to="/knowledge/$collection"
      variant="standalone"
    >
      {title}
    </RouterLink>
  </Tag>
);

/** What a property shows when it has nothing. */
const none = "–";

/** A document this one links to, by its ID, named as the link names it. */
interface Linked {
  documentId: string;
  title: string;
}

/** Fenced code, whose `[[…]]` are code, not links. */
const fencedCode = /^(?:```|~~~)[^\n]*\n[\s\S]*?^(?:```|~~~)[ \t]*$/gmu;

/**
 * The documents `text` links to with `[[links]]` that `resolve` knows, each
 * once, in the order they first appear, named by the link's label or its
 * target.
 */
const linksOf = (text: string, resolve: ResolveLink): Linked[] => {
  const found = new Map<string, string>();
  for (const match of text
    .replaceAll(fencedCode, "")
    .matchAll(wikiLinkPattern)) {
    const [target = "", ...rest] = (match.groups?.inner ?? "").split("|");
    const path = linkPath(target);
    const documentId = path === undefined ? undefined : resolve(path);
    if (documentId !== undefined && !found.has(documentId)) {
      const label = rest.join("|").trim();
      found.set(documentId, label === "" ? target.trim() : label);
    }
  }
  return [...found].map(([documentId, title]) => ({ documentId, title }));
};

/** Documents as a row of chips, or a dash for none. */
const Chips = ({
  documents,
}: {
  documents: readonly {
    collectionId: string;
    documentId: string;
    title: string;
  }[];
}) =>
  documents.length === 0 ? (
    none
  ) : (
    <ul {...stylex.props(styles.chips)}>
      {documents.map((document) => (
        <li key={document.documentId} {...stylex.props(styles.chip)}>
          <DocumentChip
            collectionId={document.collectionId}
            documentId={document.documentId}
            title={document.title}
          />
        </li>
      ))}
    </ul>
  );

/** The document's properties: where it is, its version and review, and what uses it. */
const Properties = ({
  doc,
  collection,
  links,
  backlinks,
}: {
  doc: DocumentRead;
  collection: string;
  links: Linked[];
  backlinks: Backlink[];
}) => {
  const { t } = useLingui();
  return (
    <KeyValueList
      items={[
        {
          key: t`Collection`,
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
        { key: t`Path`, value: doc.path },
        { key: t`Version`, value: doc.version.number },
        { key: t`Review by`, value: doc.reviewDate ?? none },
        {
          key: t`Links to`,
          value: (
            <Chips
              documents={links.map((link) => ({
                ...link,
                collectionId: doc.collectionId,
              }))}
            />
          ),
        },
        { key: t`Used by`, value: <Chips documents={backlinks} /> },
      ]}
      variant="stacked"
    />
  );
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

/** A document, with its editor and history where the person may change it. */
export const DocumentView = ({
  doc,
  collection,
  versions,
  backlinks,
  resolve,
  me,
  writable,
  actions,
}: {
  doc: DocumentRead;
  /** The name of the collection it is in. */
  collection: string;
  versions: VersionSummary[];
  backlinks: Backlink[];
  /** The collection's document at a `[[link]]`'s path, if the page has it. */
  resolve: ResolveLink;
  me: string;
  writable: boolean;
  /** What else the page offers on it, beside Edit and Export. */
  actions?: ReactNode;
}) => {
  const { t } = useLingui();
  const [editing, setEditing] = useState(false);
  // An earlier version, opened from the history: read only.
  const earlier = doc.version.number !== doc.currentVersion;
  const details = (
    <Properties
      backlinks={backlinks}
      collection={collection}
      doc={doc}
      links={linksOf(doc.version.text, resolve)}
    />
  );
  return (
    <div {...stylex.props(styles.view)}>
      <div {...stylex.props(styles.scroll)}>
        <div {...stylex.props(styles.column)}>
          <PageHeading
            action={
              <span {...stylex.props(styles.actions)}>
                {writable && !editing && !earlier ? (
                  <Button
                    icon={Edit}
                    onClick={() => {
                      setEditing(true);
                    }}
                    size="sm"
                    variant="quiet"
                  >
                    <Trans>Edit</Trans>
                  </Button>
                ) : null}
                {actions}
                <ExportMenu
                  file={{
                    name: fileNameOf(doc),
                    title: doc.title,
                    markdown: () => doc.version.text,
                  }}
                />
              </span>
            }
            {...(doc.description === ""
              ? {}
              : { description: doc.description })}
            meta={<Badge>{documentTypeLabel(doc.type)}</Badge>}
            title={doc.title}
          />
          {earlier ? <EarlierVersion doc={doc} /> : null}
          {editing ? (
            <Editor
              doc={doc}
              resolve={resolve}
              onClose={() => {
                setEditing(false);
              }}
            />
          ) : (
            <DocumentMarkdown
              resolve={resolve}
              text={doc.version.text}
              title={doc.title}
            />
          )}
          <div {...stylex.props(styles.foot)}>
            <Separator />
            <Collapsible title={t`Details`}>{details}</Collapsible>
          </div>
          <Timeline doc={doc} me={me} versions={versions} writable={writable} />
        </div>
      </div>
      <aside aria-label={t`Details`} {...stylex.props(styles.aside)}>
        {details}
      </aside>
    </div>
  );
};
