import { linkPath, wikiLinkPattern } from "@grasp-os/shared/knowledge";
import type {
  Backlink,
  DocumentRead,
  VersionSummary,
} from "@grasp-os/shared/knowledge";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";

import { ErrorText } from "../error-text.tsx";
import { ExportMenu } from "../export/export-menu.tsx";
import { formatDay } from "../format.ts";
import { PageHeading } from "../frame/page.tsx";
import { RouterLink } from "../frame/router-link.tsx";
import { Alert } from "../grasp/alert/index.ts";
import { Button } from "../grasp/button/index.ts";
import { Doc, Edit } from "../grasp/icons/index.ts";
import { Input } from "../grasp/input/index.ts";
import {
  Item,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { Section, SectionHeader } from "../grasp/section-header/index.ts";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../grasp/tabs/index.ts";
import { Text } from "../grasp/text/index.ts";
import { Textarea } from "../grasp/textarea/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import { useCoreAction } from "../use-core-action.ts";
import { DocumentMarkdown } from "./markdown.tsx";
import { saveOrNewer } from "./save.ts";
import { Timeline } from "./timeline.tsx";
import type { ResolveLink } from "./wiki-links.ts";

// One document, read like a note in the prototype's brain
// (grasplabs/prototype `routes/brain/$noteId.tsx`): its kind, title and
// when to use it, then its text, and its history as a timeline below it.
// Its facts (the collection, the file, the version, its review date) stand
// in a line under its title; what it links to and what links to it, in a
// small section each under its text. Where the person may change it: an editor, and
// restoring from its history. Every save names the version it was edited
// from, so a save that would overwrite one made since, in another tab or
// by someone else, shows that version instead.

const styles = stylex.create({
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
  view: { display: "flex", flex: 1, minWidth: 0, minHeight: 0 },
  scroll: { flex: 1, minWidth: 0, overflowY: "auto" },
  column: {
    display: "flex",
    flexDirection: "column",
    gap: grasp.space8,
    boxSizing: "border-box",
    width: "100%",
    paddingBlock: grasp.space8,
    paddingInline: { default: grasp.space6, [media.fromTablet]: grasp.space12 },
  },
  actions: { display: "flex", alignItems: "center", gap: grasp.space2 },
  // The title, and its facts close under it.
  head: { display: "flex", flexDirection: "column", gap: grasp.space2 },
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

/**
 * The facts under the title, in one quiet line: the collection, the file,
 * the version and when to review it.
 */
const Facts = ({
  doc,
  collection,
}: {
  doc: DocumentRead;
  collection: string;
}) => {
  const { t } = useLingui();
  const version = doc.version.number;
  const review = doc.reviewDate === null ? null : formatDay(doc.reviewDate);
  return (
    <Text size="sm" tone="muted">
      <RouterLink
        params={{ collection: doc.collectionId }}
        search={{}}
        to="/knowledge/$collection"
        variant="standalone"
      >
        {collection}
      </RouterLink>
      {` · ${doc.path.split("/").at(-1) ?? doc.path} · `}
      {t`Version ${version}`}
      {review === null ? null : ` · ${t`Review by ${review}`}`}
    </Text>
  );
};

/**
 * Documents as a small section of links to them: what this one
 * links to, or what links to it. Nothing where there are none.
 */
const Related = ({
  id,
  title,
  documents,
}: {
  id: string;
  title: string;
  documents: readonly {
    collectionId: string;
    documentId: string;
    title: string;
  }[];
}) => {
  if (documents.length === 0) {
    return null;
  }
  return (
    <Section aria-labelledby={id}>
      <SectionHeader id={id} size="sm" title={title} />
      {/* Each one has an address: a link, never a button. */}
      <ItemGroup aria-label={title}>
        {documents.map((document) => (
          <Item
            key={document.documentId}
            render={
              <Link
                params={{ collection: document.collectionId }}
                search={{ doc: document.documentId }}
                to="/knowledge/$collection"
              />
            }
            size="sm"
          >
            <ItemMedia icon={Doc} iconLook="inline" />
            <ItemContent>
              <ItemTitle>{document.title}</ItemTitle>
            </ItemContent>
          </Item>
        ))}
      </ItemGroup>
    </Section>
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
  const links = linksOf(doc.version.text, resolve).map((link) => ({
    ...link,
    collectionId: doc.collectionId,
  }));
  return (
    <div {...stylex.props(styles.view)}>
      <div {...stylex.props(styles.scroll)}>
        <div {...stylex.props(styles.column)}>
          <div {...stylex.props(styles.head)}>
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
              title={doc.title}
            />
            <Facts collection={collection} doc={doc} />
          </div>
          {earlier ? <EarlierVersion doc={doc} /> : null}
          {/* Concept C: the document's three views as tabs. */}
          <Tabs defaultValue="text">
            <TabsList aria-label="Views of the document">
              <TabsTrigger value="text">Text</TabsTrigger>
              <TabsTrigger value="history">
                {`History ${versions.length}`}
              </TabsTrigger>
              <TabsTrigger value="links">
                {`Links ${links.length + backlinks.length}`}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="text">
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
            </TabsContent>
            <TabsContent value="history">
              <Timeline
                doc={doc}
                me={me}
                versions={versions}
                writable={writable}
              />
            </TabsContent>
            <TabsContent value="links">
              <Related documents={links} id="links-to" title={t`Links to`} />
              <Related documents={backlinks} id="used-by" title={t`Used by`} />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
};
