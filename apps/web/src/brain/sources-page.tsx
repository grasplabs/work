import type { Connection } from "@grasp-os/shared/brain";
import type {
  BrainFoundBy,
  BrainMemoryFoundBy,
  BrainConnectedSource,
  BrainSearchMemory,
  BrainSearchPack,
  BrainSourceListed,
  BrainSourcePage,
  BrainSourceProducer,
  BrainSourceRef,
  BrainSourceText,
  BrainSourceVersionPage,
  BrainSharedUploadPage,
  BrainUpload,
  BrainUploadReaders,
} from "@grasp-os/shared/brain-sources";
import {
  brainQuestionMaxLength,
  brainUploadErrors,
  firstLineOf,
} from "@grasp-os/shared/brain-sources";
import { failureText } from "@grasp-os/shared/errors";
import {
  uploadErrors,
  uploadMaxBytes,
  uploadTypes,
} from "@grasp-os/shared/uploads";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useId, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatBytes, formatDateTime, formatList } from "../format.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../grasp/alert-dialog/index.ts";
import { Badge } from "../grasp/badge/index.ts";
import { BrandIcon } from "../grasp/brand-icon/index.ts";
import { Button } from "../grasp/button/index.ts";
import { Card } from "../grasp/card/index.ts";
import { Collapsible } from "../grasp/collapsible/index.ts";
import { Empty, EmptyHeader, EmptyTitle } from "../grasp/empty/index.ts";
import { Field, FieldLabel } from "../grasp/field/index.ts";
import { FileUpload } from "../grasp/file-upload/index.ts";
import { Heading } from "../grasp/heading/index.ts";
import { Cable, Trash } from "../grasp/icons/index.ts";
import { Input } from "../grasp/input/index.ts";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { PageHeader } from "../grasp/page-header/index.ts";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "../grasp/select/index.ts";
import { Tag } from "../grasp/tag/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import { brandOf } from "../inbox/brand-of.ts";
import { useCore } from "../use-core.ts";
import { LearnedSection } from "./learned-section.tsx";
import { OwnExportSection } from "./own-export.tsx";

// The Brain's sources, from the new Brain (GRA-1734): what the person may
// read, a page at a time, newest first; one source's versions and text;
// search, which is recall as that person, shown as recall packs it (no
// ranking of the page's own), its memories each with where it came from,
// and everything the pack holds shown, as its budget was spent on it; and
// how each of their connections feeds the Brain today. Core answers each
// from what they may read alone. Texts are shown as text, never markup.
// A file uploaded here goes straight into the Brain, for who the person
// chooses: only them, a team of theirs, or everyone (GRA-1824); its
// uploader adds its next version. Its uploader deletes one for only them,
// erasing it; one shared with a team or everyone its uploader removes,
// out of use for everyone with its history kept (GRA-1877), and an admin
// erases, from the shared uploads listed for admins, removed ones among
// them. What each may do to an upload, and what their Delete does, is
// core's to say (`uploadOf`). At its foot, the person's own export of
// what only they may read (own-export.tsx).

/** A team the person is in. */
interface Team {
  id: string;
  name: string;
}

type Sources = Session["brainSources"];

/** What a read from core came to. */
type Read<T> =
  | { state: "loading" }
  | { state: "refused"; message: string; code?: string }
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
    const code = brainUploadErrors.codeOf(error);
    return {
      state: "refused",
      message: failureText(error),
      ...(code === undefined ? {} : { code }),
    };
  }
};

/**
 * Why an upload was refused, as the person reads it.
 */
const UploadRefusal = ({
  refused,
}: {
  refused: { message: string; code?: string };
}) => {
  const { t } = useLingui();
  // Core's refusals the page says in the person's own language; every
  // other is core's own words.
  const said: Record<string, string> = {
    "brain.upload_text_too_long": t`This file's text is too long for the Brain to keep. Split it into smaller files and upload those.`,
    "brain.upload_other_file": t`This upload was already made with another file, which is kept as it was. Choose the file again to upload it as a new upload, or add it as a new version.`,
  };
  return (
    <ErrorText>
      {(refused.code === undefined ? undefined : said[refused.code]) ??
        refused.message}
    </ErrorText>
  );
};

/**
 * A file as core takes it: its name and its bytes. Refused here, as core
 * would, before reading and sending it all: the size the browser reports
 * only saves the trip. Core checks the bytes that arrive.
 */
const fileOf = async (file: File) => {
  if (file.size > uploadMaxBytes) {
    throw uploadErrors.create("upload.too_large");
  }
  return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
};

/**
 * Whether `answer` is a delete refused as not found: one done before, its
 * answer lost, or one they may no longer make (an admin no longer one).
 * The page reads again what is there, rather than say which.
 */
const notFound = (answer: Read<unknown>): boolean =>
  answer.state === "refused" && answer.code === "brain.upload_not_found";

/** The file types an upload may be, for the file picker: core's own list. */
const uploadAccept = Object.keys(uploadTypes)
  .map((extension) => `.${extension}`)
  .join(",");

/** Who may read an upload, as the form's choice names it: `me`, `everyone` or a team's id. */
const readersOf = (choice: string): BrainUploadReaders => {
  if (choice === "me" || choice === "everyone") {
    return { kind: choice };
  }
  return { kind: "team", teamId: choice };
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
  group: { display: "flex", flexDirection: "column", gap: grasp.space2 },
  versions: { display: "flex", flexDirection: "column", gap: grasp.space1 },
  form: { display: "flex", gap: grasp.space2 },
  grow: { flexGrow: 1, minWidth: 0 },
  start: { alignSelf: "flex-start" },
  // The upload's fields side by side where there is room, the button at their foot.
  fields: {
    display: "flex",
    flexDirection: { default: "column", [media.fromTablet]: "row" },
    alignItems: { default: "stretch", [media.fromTablet]: "flex-end" },
    gap: grasp.space3,
  },
  // The source list and the opened source side by side on a wide page.
  split: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
    alignItems: "start",
    gap: grasp.space6,
    minHeight: 0,
  },
  // Room for the source beside the list only while one is open: an empty
  // half would push the list and its empty state off the middle.
  splitOpen: {
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      [media.fromSidebar]: "repeat(2, minmax(0, 1fr))",
    },
  },
  // A row's facts: its kind, how it was found, its version.
  facts: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: grasp.space2,
  },
  // The words of its source a memory rests on, set off by a line.
  quote: {
    margin: 0,
    paddingInlineStart: grasp.space3,
    borderInlineStartWidth: grasp.hairline,
    borderInlineStartStyle: "solid",
    borderInlineStartColor: grasp.line,
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
    capture: t({
      message: "Fetched from a connection",
      context: "a source of the Brain",
    }),
    interview: t({ message: "Interview", context: "a source of the Brain" }),
    claim: t({
      message: "What your team said",
      context: "a source of the Brain",
    }),
    drawing: t({
      message: "How a team works",
      context: "a source of the Brain",
    }),
    opinion: t({
      message: "What people across the company say",
      context: "a source of the Brain",
    }),
    kickoff: t({
      message: "The company's vision",
      context: "a source of the Brain",
    }),
    roster: t({
      message: "The company's teams",
      context: "a source of the Brain",
    }),
    connected: t({
      message: "Read from a shared connection",
      context: "a source of the Brain",
    }),
    sync: t({
      message: "Copied from a connected system",
      context: "a source of the Brain",
    }),
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
  return (
    <Tag size="sm" variant="outline">
      {label}
    </Tag>
  );
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
  return <Tag size="sm">{label}</Tag>;
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
  const { t } = useLingui();
  const { source, context } = memory;
  const version = source?.version;
  return (
    <Item size="sm" variant="outline">
      <ItemContent>
        <ItemTitle>{memory.statement}</ItemTitle>
        {memory.quote === null ? null : (
          <blockquote {...stylex.props(styles.quote)}>
            <Text size="sm" tone="muted">
              <span {...stylex.props(styles.plain)}>{memory.quote}</span>
            </Text>
          </blockquote>
        )}
        {context === null ? null : (
          <Collapsible fit title={t`The passage around it`}>
            <Text size="sm" tone="muted">
              <span {...stylex.props(styles.plain)}>{context.text}</span>
            </Text>
          </Collapsible>
        )}
        <ItemDescription>
          <span {...stylex.props(styles.facts)}>
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
                  variant="ghost"
                >
                  {t`Open version ${version}`}
                </Button>
              </>
            )}
            {memory.store === "own" ? (
              <Tag size="sm" variant="outline">
                <Trans context="a memory nobody else may read">Only you</Trans>
              </Tag>
            ) : null}
            {/* A saved memory is taken as correct: a confirmation is shown
                only where it settled a disagreement. */}
            {memory.confirmed && memory.contested ? (
              <Badge size="sm" tone="success">
                <Trans context="a memory a person confirmed">Confirmed</Trans>
              </Badge>
            ) : null}
            {memory.contested ? (
              <Badge size="sm" tone="attention">
                <Trans>Sources disagree</Trans>
              </Badge>
            ) : null}
            <MemoryFoundBadge found={memory.found} />
          </span>
        </ItemDescription>
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
    <section aria-labelledby={heading} {...stylex.props(styles.section)}>
      <Heading id={heading} level={2} size="ui-sm">
        <Trans>Results</Trans>
      </Heading>
      {nothing ? (
        <Text size="sm" tone="muted">
          <Trans>Nothing you may read matched.</Trans>
        </Text>
      ) : null}
      {pack.memories.length === 0 ? null : (
        <div {...stylex.props(styles.group)}>
          <Heading level={3} size="ui-sm">
            <Trans>What the Brain remembers</Trans>
          </Heading>
          <ItemGroup>
            {pack.memories.map((memory) => (
              <MemoryResult
                key={`${memory.store}:${memory.id}`}
                memory={memory}
                onOpen={onOpen}
              />
            ))}
          </ItemGroup>
        </div>
      )}
      {pack.items.length === 0 ? null : (
        <div {...stylex.props(styles.group)}>
          {pack.memories.length === 0 ? null : (
            <Heading level={3} size="ui-sm">
              <Trans>Passages</Trans>
            </Heading>
          )}
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
        </div>
      )}
      {/* What wasn't found only beside what was: a search that found
          nothing says so once, above. */}
      {nothing || pack.notFound.length === 0 ? null : (
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

/** Uploading a file into the Brain: the file, and who may read it. */
const UploadForm = ({
  teams,
  onUploaded,
}: {
  teams: Team[];
  onUploaded: (source: BrainSourceRef) => void;
}) => {
  const { t } = useLingui();
  const core = useCore();
  // The upload's id, minted for the file chosen and sent again when it is
  // retried, so a retry after a lost answer is the same upload.
  const [file, setFile] = useState<{ chosen: File; uploadId: string }>();
  // Each upload done starts the picker afresh, without the file it sent.
  const [uploads, setUploads] = useState(0);
  const [choice, setChoice] = useState("me");
  const [sent, setSent] = useState<Read<{ source: BrainSourceRef }>>();
  const busy = sent?.state === "loading";
  // What an upload takes, from core's own limits.
  const types = formatList(Object.keys(uploadTypes).map((type) => `.${type}`));
  const size = formatBytes(uploadMaxBytes);
  const readers = [
    { value: "me", label: t`Only me` },
    ...teams.map(({ id, name }) => ({ value: id, label: t`Team ${name}` })),
    { value: "everyone", label: t`Everyone` },
  ];
  return (
    <form
      {...stylex.props(styles.stack)}
      onSubmit={(event) => {
        event.preventDefault();
        if (file === undefined || busy) {
          return;
        }
        setSent({ state: "loading" });
        void (async () => {
          const answer = await readFrom(
            core,
            async (sources) =>
              await sources.upload(
                await fileOf(file.chosen),
                readersOf(choice),
                file.uploadId
              )
          );
          setSent(answer);
          if (answer.state === "ready") {
            setFile(undefined);
            setUploads((before) => before + 1);
            onUploaded(answer.data.source);
          }
        })();
      }}
    >
      <div {...stylex.props(styles.fields)}>
        <Field layout={styles.grow}>
          <FieldLabel>
            <Trans>File</Trans>
          </FieldLabel>
          <FileUpload
            accept={uploadAccept}
            // Out of reach while a file uploads: the picker starts afresh
            // when it is done, which would drop a file chosen meanwhile.
            disabled={busy}
            key={uploads}
            onValueChange={([chosen]) => {
              setFile(
                chosen === undefined
                  ? undefined
                  : { chosen, uploadId: crypto.randomUUID() }
              );
            }}
            variant="button"
          />
        </Field>
        <Field layout={styles.grow}>
          <FieldLabel>
            <Trans context="a file uploaded into the Brain">
              Who may read it
            </Trans>
          </FieldLabel>
          <Select
            items={readers}
            onValueChange={(value) => {
              if (value !== null) {
                setChoice(value);
              }
            }}
            value={choice}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent />
          </Select>
        </Field>
        <Button disabled={file === undefined || busy} type="submit">
          {busy ? t`Uploading…` : t`Upload`}
        </Button>
      </div>
      <Text size="sm" tone="muted">
        <Trans>
          It takes {types} files of up to {size}. Who may read it stays as you
          choose: to share it with others, upload it again for them.
        </Trans>
      </Text>
      {sent?.state === "refused" ? <UploadRefusal refused={sent} /> : null}
    </form>
  );
};

/** Who may read an upload, in words. */
const ReadersLine = ({
  readers,
  teams,
}: {
  readers: BrainUploadReaders;
  teams: Team[];
}) => {
  if (readers.kind === "me") {
    return <Trans>Only you can read this upload.</Trans>;
  }
  if (readers.kind === "everyone") {
    return <Trans>Everyone can read this upload.</Trans>;
  }
  const team = teams.find(({ id }) => id === readers.teamId)?.name;
  return team === undefined ? (
    <Trans>A team can read this upload.</Trans>
  ) : (
    <Trans>Team {team} can read this upload.</Trans>
  );
};

/**
 * What the person may do to an upload, as core says: upload its next
 * version, and delete it: erase it for good, or remove it.
 */
const UploadActions = ({
  source,
  teams,
  onChanged,
  onDeleted,
}: {
  source: BrainSourceRef;
  teams: Team[];
  onChanged: (source: BrainSourceRef) => void;
  onDeleted: (source: BrainSourceRef) => void;
}) => {
  const { t } = useLingui();
  const core = useCore();
  const [upload, setUpload] = useState<Read<BrainUpload | null>>({
    state: "loading",
  });
  // The new version's id, minted for the file chosen and sent again when
  // it is retried, so a retry after a lost answer is the same version.
  const [file, setFile] = useState<{ chosen: File; versionId: string }>();
  const [acting, setActing] = useState<Read<unknown>>();
  // Which action is under way: a new version shows it uploads.
  const [uploading, setUploading] = useState(false);
  useEffect(() => {
    let left = false;
    const read = async (): Promise<void> => {
      const answer = await readFrom(
        core,
        async (sources) => await sources.uploadOf(source.id)
      );
      if (!left) {
        setUpload(answer);
      }
    };
    void read();
    return () => {
      left = true;
    };
  }, [core, source]);
  if (upload.state === "refused") {
    return <ErrorText>{upload.message}</ErrorText>;
  }
  if (upload.state !== "ready" || upload.data === null) {
    return null;
  }
  const { readers, mayAddVersion, deletes } = upload.data;
  const busy = acting?.state === "loading";
  return (
    <div {...stylex.props(styles.stack)}>
      <Text size="sm" tone="muted">
        <ReadersLine readers={readers} teams={teams} />
      </Text>
      {mayAddVersion ? (
        <form
          {...stylex.props(styles.fields)}
          onSubmit={(event) => {
            event.preventDefault();
            if (file === undefined || busy) {
              return;
            }
            setActing({ state: "loading" });
            setUploading(true);
            void (async () => {
              const answer = await readFrom(
                core,
                async (sources) =>
                  await sources.uploadVersion(
                    source.id,
                    await fileOf(file.chosen),
                    file.versionId
                  )
              );
              setUploading(false);
              setActing(answer);
              if (answer.state === "ready") {
                onChanged(source);
              }
            })();
          }}
        >
          <Field layout={styles.grow}>
            <FieldLabel>
              <Trans>New version</Trans>
            </FieldLabel>
            <FileUpload
              accept={uploadAccept}
              onValueChange={([chosen]) => {
                setFile(
                  chosen === undefined
                    ? undefined
                    : { chosen, versionId: crypto.randomUUID() }
                );
              }}
              variant="button"
            />
          </Field>
          <Button disabled={file === undefined || busy} type="submit">
            {uploading ? t`Uploading…` : t`Upload new version`}
          </Button>
        </form>
      ) : null}
      {deletes === null ? null : (
        <AlertDialog>
          <AlertDialogTrigger
            aria-label={t`Delete this upload`}
            disabled={busy}
            icon={Trash}
            layout={styles.start}
            size="sm"
            variant="ghost"
          >
            {t`Delete`}
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogTitle>{t`Delete this upload?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {deletes === "erase"
                ? t`Every version of it is erased from the Brain for everyone who could read it. This can't be undone. What a workflow kept from it between its runs isn't erased, but it is no longer shown or used.`
                : t`Nobody can find or read it from then on, you included, and it can't be brought back. The Brain keeps its history until an admin erases it.`}
            </AlertDialogDescription>
            <AlertDialogFooter>
              <AlertDialogAction>{t`Cancel`}</AlertDialogAction>
              <AlertDialogAction
                // It closes at once and confirms nothing while the delete
                // runs; what goes wrong shows under the actions.
                action={() => {
                  setActing({ state: "loading" });
                  void (async () => {
                    const answer = await readFrom(core, async (sources) => {
                      await sources.deleteUpload(source.id);
                    });
                    if (answer.state === "ready") {
                      setActing(undefined);
                      onDeleted(source);
                      return;
                    }
                    if (notFound(answer)) {
                      // Read again: gone, or still there without Delete.
                      setActing(undefined);
                      onChanged(source);
                      return;
                    }
                    setActing(answer);
                  })();
                }}
                variant="danger"
              >
                {deletes === "erase" ? t`Delete for good` : t`Delete`}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
      {acting?.state === "refused" ? <UploadRefusal refused={acting} /> : null}
    </div>
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
 * How the person's connections feed the Brain. What an agent reads as one
 * item (a message, a page) through a connection of their own is kept in
 * their own Brain, for them alone (core's connection-capture.ts,
 * GRA-1730); everything else agents search live, and the Brain keeps
 * nothing of it. A full copy comes with native sync. These connections
 * don't say which are the person's own, so the rule is said once.
 */
const ConnectionFeeds = ({ connections }: { connections: Connection[] }) => {
  const heading = useId();
  // With no connection there is nothing to say how it feeds the Brain.
  if (connections.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby={heading} {...stylex.props(styles.section)}>
      <Heading id={heading} level={2} size="ui-sm">
        <Trans>How your connections feed the Brain</Trans>
      </Heading>
      <Text size="sm" tone="muted">
        <Trans>
          When an agent reads for you through an account you connected yourself,
          the Brain keeps what it read for you alone, while that account stays
          connected: one Gmail message or attachment, one OneNote page, or the
          answer of a read in another app, the company’s records included.
          Everything else agents search live when you ask, and the Brain keeps
          nothing of it.
        </Trans>
      </Text>
      <ItemGroup separated>
        {connections.map(({ name, keepsReads, activityGap }) => {
          const brand = brandOf(name);
          return (
            <Item key={name} size="xs">
              {brand === undefined ? (
                <ItemMedia icon={Cable} iconLook="inline" />
              ) : (
                <ItemMedia>
                  <BrandIcon brand={brand} decorative size="md" tile={false} />
                </ItemMedia>
              )}
              <ItemContent>
                <ItemTitle>{name}</ItemTitle>
                <ItemDescription>
                  {keepsReads === true ? (
                    <Trans>
                      The Brain may keep, for you alone, some of what an agent
                      reads for you through this connection, while it stays
                      connected.
                    </Trans>
                  ) : (
                    <Trans>Searched live, nothing kept.</Trans>
                  )}
                </ItemDescription>
                {activityGap === true ? (
                  <Text size="sm" tone="muted">
                    <Trans>
                      A gap: this connection can’t tell Grasp what changed in
                      it, so Grasp sees only what is done there through Grasp.
                    </Trans>
                  </Text>
                ) : null}
              </ItemContent>
            </Item>
          );
        })}
      </ItemGroup>
    </section>
  );
};

/**
 * The shared connections whose kept reads the person may read
 * (GRA-1831): what agents read through a connection an admin shared,
 * kept for the people the admin chose. One row a connection, not one a
 * record.
 */
const SharedConnectionReads = ({
  connected,
}: {
  connected: BrainConnectedSource[];
}) => {
  const heading = useId();
  if (connected.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby={heading} {...stylex.props(styles.section)}>
      <Heading id={heading} level={2} size="ui-sm">
        <Trans>What agents read through shared connections</Trans>
      </Heading>
      <Text size="sm" tone="muted">
        <Trans>
          The Brain keeps what agents read through these connections an admin
          shared, for the people the admin chose. It is what each system said
          when it was read, not kept up to date.
        </Trans>
      </Text>
      <ItemGroup separated>
        {connected.map(
          ({ connectionId, name, account, records, lastReadAt }) => {
            const lastRead = formatDateTime(lastReadAt);
            const brand = brandOf(name);
            return (
              <Item key={connectionId} size="xs">
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
                    {account === null ? name : `${name} (${account})`}
                  </ItemTitle>
                  <ItemDescription>
                    <span {...stylex.props(styles.facts)}>
                      <span>
                        <Plural
                          one="# record kept"
                          other="# records kept"
                          value={records}
                        />
                      </span>
                      <span>
                        <Trans>Last read {lastRead}</Trans>
                      </span>
                    </span>
                  </ItemDescription>
                </ItemContent>
              </Item>
            );
          }
        )}
      </ItemGroup>
    </section>
  );
};

/** The shared connection a kept read's source is under: the first part of its ID. */
const connectionOfSource = (source: BrainSourceRef): string | undefined =>
  source.producer === "connected" ? source.id.split("/")[0] : undefined;

/**
 * Where and when a kept read was read (a `connected` source): its
 * system's name, when known, and its version's time. Nothing for any
 * other source.
 */
const ReadFrom = ({
  source,
  read,
  names,
}: {
  source: BrainSourceRef;
  read: BrainSourceText;
  names: ReadonlyMap<string, string>;
}) => {
  const connectionId = connectionOfSource(source);
  if (connectionId === undefined) {
    return null;
  }
  const name = names.get(connectionId);
  const readOn = formatDateTime(read.addedAt);
  return (
    <Text size="sm" tone="muted">
      {name === undefined ? (
        <Trans>Read from a shared connection on {readOn}</Trans>
      ) : (
        <Trans>
          Read from {name} on {readOn}
        </Trans>
      )}
    </Text>
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
  const lastRead =
    listed.readAt === undefined ? undefined : formatDateTime(listed.readAt);
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
            {lastRead === undefined ? null : (
              <span>
                <Trans>Last read {lastRead}</Trans>
              </span>
            )}
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
  teams,
  connectedNames,
  onChanged,
  onDeleted,
}: {
  source: BrainSourceRef;
  /** The version to show first: the newest they may read when left out. */
  version: number | undefined;
  teams: Team[];
  /** The names of the shared connections whose kept reads they may read, by ID. */
  connectedNames: ReadonlyMap<string, string>;
  /** A new version of it was added. */
  onChanged: (source: BrainSourceRef) => void;
  /** It was deleted. */
  onDeleted: (source: BrainSourceRef) => void;
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
            <ReadFrom names={connectedNames} read={read} source={source} />
            <Text size="sm">
              <span {...stylex.props(styles.plain)}>{read.text}</span>
            </Text>
            <LearnedSection
              key={`${keyOf(source)}#${read.version}`}
              source={source}
              version={read.version}
            />
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
        {source.producer === "upload" ? (
          <UploadActions
            onChanged={onChanged}
            onDeleted={onDeleted}
            source={source}
            teams={teams}
          />
        ) : null}
      </div>
    </Card>
  );
};

/**
 * For an admin: the uploads shared with a team or everyone, newest first,
 * each by its file's name, who may read it, who uploaded it and when, and
 * when its uploader removed it, never its text, with Erase for good: a
 * shared upload only an admin erases, also one of a team they aren't in,
 * or one removed.
 */
const SharedUploads = ({ onErased }: { onErased: () => void }) => {
  const { t } = useLingui();
  const core = useCore();
  const heading = useId();
  const [listed, setListed] = useState<Read<BrainSharedUploadPage>>({
    state: "loading",
  });
  const [acting, setActing] = useState<Read<unknown>>();
  const [more, setMore] = useState<Read<BrainSharedUploadPage>>();
  useEffect(() => {
    let left = false;
    const read = async (): Promise<void> => {
      const answer = await readFrom(
        core,
        async (sources) => await sources.sharedUploads()
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
  const busy = acting?.state === "loading";
  return (
    <section aria-labelledby={heading} {...stylex.props(styles.section)}>
      <Heading id={heading} level={2} size="ui-sm">
        <Trans>Shared uploads</Trans>
      </Heading>
      <Text size="sm" tone="muted">
        <Trans>
          Uploads shared with a team or everyone, those their uploader removed
          among them. Only an admin can erase one, for everyone and for good.
          Its text isn&apos;t shown here.
        </Trans>
      </Text>
      {listed.state === "refused" ? (
        <ErrorText>{listed.message}</ErrorText>
      ) : null}
      {listed.state === "ready" && listed.data.uploads.length === 0 ? (
        <Text size="sm" tone="muted">
          <Trans>No uploads are shared with a team or everyone.</Trans>
        </Text>
      ) : null}
      {listed.state === "ready" && listed.data.uploads.length > 0 ? (
        <ItemGroup separated>
          {listed.data.uploads.map((upload) => {
            const { uploaderName, teamName, readers } = upload;
            // Named only for an admin who may read it; else told apart by
            // its team, uploader and the minute it was uploaded.
            const { name } = upload;
            const uploaded = formatDateTime(upload.uploadedAt);
            const removed =
              upload.removedAt === null
                ? null
                : formatDateTime(upload.removedAt);
            let readBy = t`Everyone`;
            if (readers.kind === "team") {
              readBy =
                teamName === null ? t`A deleted team` : t`Team ${teamName}`;
            }
            return (
              <Item key={upload.source.id} size="sm">
                <ItemContent>
                  <ItemTitle>{name ?? t`An upload`}</ItemTitle>
                  <ItemDescription>
                    <span {...stylex.props(styles.facts)}>
                      <Tag size="sm" variant="outline">
                        {readBy}
                      </Tag>
                      <span>
                        <Trans>
                          Uploaded by {uploaderName}, {uploaded}
                        </Trans>
                      </span>
                      {removed === null ? null : (
                        <Tag size="sm">
                          <Trans>Removed by its uploader, {removed}</Trans>
                        </Tag>
                      )}
                    </span>
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <AlertDialog>
                    <AlertDialogTrigger
                      aria-label={
                        name === null
                          ? t`Erase this upload for good`
                          : t`Erase ${name} for good`
                      }
                      disabled={busy}
                      size="sm"
                      variant="ghost"
                    >
                      {t`Erase for good`}
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogTitle>
                        {t`Erase this upload for good?`}
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        {t`Every version of it is erased from the Brain for everyone who could read it. This can't be undone. What a workflow kept from it between its runs isn't erased, but it is no longer shown or used.`}
                      </AlertDialogDescription>
                      <AlertDialogFooter>
                        <AlertDialogAction>{t`Cancel`}</AlertDialogAction>
                        <AlertDialogAction
                          // It closes at once; what goes wrong shows under the list.
                          action={() => {
                            setActing({ state: "loading" });
                            void (async () => {
                              const answer = await readFrom(
                                core,
                                async (sources) => {
                                  await sources.deleteUpload(upload.source.id);
                                }
                              );
                              // Not found: read the lists again, which show what
                              // is there (or that they may no longer list it).
                              if (
                                answer.state !== "ready" &&
                                !notFound(answer)
                              ) {
                                setActing(answer);
                                return;
                              }
                              onErased();
                            })();
                          }}
                          variant="danger"
                        >
                          {t`Erase for good`}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </ItemActions>
              </Item>
            );
          })}
        </ItemGroup>
      ) : null}
      {acting?.state === "refused" ? <UploadRefusal refused={acting} /> : null}
      {more?.state === "refused" ? <ErrorText>{more.message}</ErrorText> : null}
      {listed.state === "ready" && listed.data.next !== null ? (
        <Button
          disabled={more?.state === "loading"}
          layout={styles.start}
          onClick={() => {
            const { next, uploads } = listed.data;
            setMore({ state: "loading" });
            void (async () => {
              const answer = await readFrom(
                core,
                async (sources) => await sources.sharedUploads(next)
              );
              setMore(answer.state === "refused" ? answer : undefined);
              if (answer.state === "ready") {
                setListed({
                  state: "ready",
                  data: {
                    uploads: [...uploads, ...answer.data.uploads],
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
      ) : null}
    </section>
  );
};

/** The Brain's sources page: search, how connections feed it, and the sources. */
export const SourcesPage = ({
  connections,
  teams,
  admin,
}: {
  /** The person's connections, each one they have connected. */
  connections: Connection[];
  /** The teams the person is in, whom they may upload for. */
  teams: Team[];
  /** Whether they are an admin, who erases shared uploads. */
  admin: boolean;
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
  const uploadHeading = useId();
  const core = useCore();
  // Each change to the sources counts, so the list reads them again.
  const [listing, setListing] = useState(0);
  const [connected, setConnected] = useState<Read<BrainConnectedSource[]>>({
    state: "loading",
  });
  useEffect(() => {
    let left = false;
    const read = async (): Promise<void> => {
      const answer = await readFrom(
        core,
        async (sources) => await sources.connections()
      );
      if (!left) {
        setConnected(answer);
      }
    };
    void read();
    return () => {
      left = true;
    };
  }, [core]);
  const connectedList = connected.state === "ready" ? connected.data : [];
  const connectedNames = new Map(
    connectedList.map(({ connectionId, name }) => [connectionId, name])
  );
  const open = (source: BrainSourceRef, version?: number) => {
    const opening = (opened?.opening ?? 0) + 1;
    setOpened(
      version === undefined ? { source, opening } : { source, version, opening }
    );
  };
  // What an action on `source` changed, once it finished: read from the
  // state as it is then, as the person may have opened another source
  // meanwhile, which stays open.
  const changed = (source: BrainSourceRef) => {
    setListing((before) => before + 1);
    setOpened((current) =>
      current !== undefined && sameSource(current.source, source)
        ? { source, opening: current.opening + 1 }
        : current
    );
  };
  const deleted = (source: BrainSourceRef) => {
    setListing((before) => before + 1);
    setOpened((current) =>
      current !== undefined && sameSource(current.source, source)
        ? undefined
        : current
    );
  };
  return (
    // A page of the brain: the title in the serif, in the brain's column,
    // with room at the foot for the chat.
    <div {...stylex.props(styles.pane)}>
      <div {...stylex.props(styles.column)}>
        <PageHeader
          title={<Trans context="the Brain's sources page">Sources</Trans>}
        />
        <Search onOpen={open} />
        <section
          aria-labelledby={uploadHeading}
          {...stylex.props(styles.section)}
        >
          <Heading id={uploadHeading} level={2} size="ui-sm">
            <Trans>Upload a file</Trans>
          </Heading>
          <UploadForm
            onUploaded={(source) => {
              setListing((before) => before + 1);
              open(source);
            }}
            teams={teams}
          />
        </section>
        {admin ? (
          <SharedUploads
            // Read again from the start whenever the sources are (an
            // upload, a new version, a delete), as the list below is.
            key={`shared-${listing}`}
            onErased={() => {
              setListing((before) => before + 1);
            }}
          />
        ) : null}
        <ConnectionFeeds connections={connections} />
        {connected.state === "refused" ? (
          <ErrorText>{connected.message}</ErrorText>
        ) : (
          <SharedConnectionReads connected={connectedList} />
        )}
        <section aria-labelledby={heading} {...stylex.props(styles.section)}>
          <Heading id={heading} level={2} size="ui-sm">
            <Trans>Sources you may read</Trans>
          </Heading>
          <div
            {...stylex.props(
              styles.split,
              opened !== undefined && styles.splitOpen
            )}
          >
            <SourceList
              key={`list-${listing}`}
              onPick={(source) => {
                open(source);
              }}
              picked={opened?.source}
            />
            {opened === undefined ? null : (
              <SourcePanel
                connectedNames={connectedNames}
                key={`panel-${opened.opening}`}
                onChanged={changed}
                onDeleted={deleted}
                source={opened.source}
                teams={teams}
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
