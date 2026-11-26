/**
 * The kickoff in an organization's Steps (GRA-1099): bringing in Grasp's
 * first conversation with the sponsor, pasted or as a file, and the
 * sponsor's answers to what it left open, as the staff page in the
 * company's Grasp had it. Each goes to the company's own core
 * (src/clients/kickoff.ts), which reads the transcript for the ten things
 * Stephen needs before his first interview. The page shows which of them
 * it brought, and the questions it left; never what was said.
 */

import type {
  AdminKickoffField,
  AdminKickoffView,
  AdminTranscript,
} from "@grasp-os/shared/admin-kickoff";
import type { VisionField } from "@grasp-os/shared/admin/interviews";
import { toBase64 } from "@grasp-os/shared/encoding";
import {
  answerMaxLength,
  isVisionShared,
  transcriptFileKinds,
  transcriptFileMaxBytes,
  transcriptMaxLength,
} from "@grasp-os/shared/kickoff";
import { interviewLocales } from "@grasp-os/shared/onboarding";
import type { InterviewLocale } from "@grasp-os/shared/onboarding";
import { Alert, AlertDescription } from "@grasp-os/ui/components/alert";
import { Button } from "@grasp-os/ui/components/button";
import { CardContent } from "@grasp-os/ui/components/card";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { Text } from "@grasp-os/ui/components/text";
import { Textarea } from "@grasp-os/ui/components/textarea";
import {
  CircleCheckIcon,
  CircleHelpIcon,
  Icon,
  UploadIcon,
} from "@grasp-os/ui/lib/icons";
import { visuallyHidden } from "@grasp-os/ui/lib/styles";
import { colors, font, space } from "@grasp-os/ui/lib/tokens.stylex";
import * as stylex from "@stylexjs/stylex";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { kickoffFn } from "../clients/kickoff-functions.ts";
import type { KickoffAnswer, KickoffRefusal } from "../clients/kickoff.ts";
import { InvalidFieldError, useAction } from "../use-action.ts";
import { formatDate } from "./words.ts";

const styles = stylex.create({
  // Bringing the transcript in: its fields at a readable width.
  form: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: space["4"],
  },
  field: { width: "100%", maxWidth: "36rem" },
  transcript: { maxHeight: "20rem" },
  language: { maxWidth: "12rem" },
  row: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space["3"],
  },
  chosen: {
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  answer: { display: "flex", flexDirection: "column", gap: space["2"] },
  keep: { display: "flex", justifyContent: "flex-end" },
  // Where the transcript stands, and the way to replace it.
  stands: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space["3"],
  },
  fields: { margin: 0, padding: 0, listStyle: "none" },
  fieldRow: {
    display: "flex",
    flexDirection: "column",
    gap: space["2"],
    paddingBlock: space["3"],
    paddingInline: space["5"],
    borderBlockStartWidth: 1,
    borderBlockStartStyle: "solid",
    borderBlockStartColor: colors.border,
  },
  fieldName: {
    display: "flex",
    alignItems: "center",
    gap: space["2"],
    fontWeight: font.weightMedium,
  },
  open: { color: colors.warning },
  // Under the name, as far in as the name stands past its mark.
  under: {
    display: "flex",
    flexDirection: "column",
    gap: space["2"],
    paddingInlineStart: space["6"],
  },
});

/** The ten things Stephen needs from the first conversation, by name. */
export const visionWords: Record<VisionField, string> = {
  business: "The business in one sentence",
  teams: "The teams, and what each does",
  goals: "Goals for the next two years, and why AI now",
  success: "What success is, in hours or workflows",
  stakeholders: "Who decides, who can block, who hears first",
  pain: "The work the sponsor already suspects",
  limits: "What Stephen must not touch",
  sensitivities: "What is sensitive right now",
  systems: "The main tools",
  languages: "The languages the teams work in",
};

/** What staff read when the company's core didn't take it, by why. */
const refusals: Readonly<Record<KickoffRefusal, string>> = {
  not_deployed:
    "The company has no Grasp to bring it to yet: it isn’t deployed, or the admin can’t reach it.",
  shut_out:
    "The company doesn’t let Grasp’s staff in now: open a staff window from Setup first, or ask its admin.",
  refused: "The company’s Grasp turned the request away.",
  "kickoff.too_short": "That is too short to be a conversation.",
  "kickoff.too_long":
    "That transcript is too long. Bring in the conversation itself, without attachments.",
  "kickoff.unreadable":
    "That file couldn’t be read. Bring in a .txt, .vtt, .srt or .docx transcript, or paste it.",
  "kickoff.not_read":
    "The conversation couldn’t be read just now. Try again in a moment.",
  "kickoff.invalid": "That isn’t something the kickoff takes.",
  "kickoff.purged":
    "Something was erased from the onboarding while this was being read, so nothing of it was kept. Bring the transcript in again.",
  not_answered: "The company’s Grasp didn’t answer. Try again in a moment.",
};

/** The languages the reading can be written in, as staff pick one. */
const languageWords: Record<InterviewLocale, string> = {
  en: "English",
  nl: "Dutch",
  de: "German",
  fr: "French",
  es: "Spanish",
};

const accept = transcriptFileKinds.map((kind) => `.${kind}`).join(",");

/** Says the kickoff's state back to the panel once core answered with it. */
type Keep = (kickoff: AdminKickoffView) => void;

/**
 * Asks the company's core, keeping the kickoff it answers with and
 * reading the organization again, so its Steps count what it brought.
 */
const useKickoff = (keep: Keep) => {
  const router = useRouter();
  const action = useAction(refusals);
  const run = async (ask: () => Promise<KickoffAnswer>): Promise<void> => {
    await action.run(async () => {
      const answer = await ask();
      if (answer.kickoff !== null) {
        keep(answer.kickoff);
        await router.invalidate();
      }
      return answer;
    });
  };
  return { busy: action.busy, failure: action.failure, run };
};

/** A file's transcript as core takes it: its name and bytes, in base64. */
const fileTranscript = async (file: File): Promise<AdminTranscript> => {
  if (file.size > transcriptFileMaxBytes) {
    throw new InvalidFieldError("That file is too large for a transcript.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { file: { name: file.name, base64: toBase64(bytes) } };
};

/** Brings the transcript in, pasted or as a file, and has Stephen read it. */
const BringIn = ({
  clientId,
  replacing,
  keep,
}: {
  clientId: string;
  replacing: boolean;
  keep: Keep;
}) => {
  const { busy, failure, run } = useKickoff(keep);
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  // The file input starts again, empty, each time this changes.
  const [fileInput, setFileInput] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const clearFile = () => {
    setFile(null);
    setFileInput((each) => each + 1);
  };
  const [locale, setLocale] = useState<InterviewLocale>("en");
  const bringIn = async (): Promise<void> => {
    await run(async () => {
      const transcript = file === null ? { text } : await fileTranscript(file);
      const answer = await kickoffFn({
        data: { clientId, ask: { kind: "save", locale, transcript } },
      });
      if (answer.kickoff !== null) {
        setText("");
        clearFile();
      }
      return answer;
    });
  };
  return (
    <CardContent>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void bringIn();
        }}
        {...stylex.props(styles.form)}
      >
        <Field disabled={busy || file !== null} style={styles.field}>
          <FieldLabel>The transcript</FieldLabel>
          <Textarea
            maxLength={transcriptMaxLength}
            onValueChange={setText}
            placeholder="Paste the transcript of the first conversation with the sponsor"
            style={styles.transcript}
            value={text}
          />
        </Field>
        <Field disabled={busy} style={styles.field}>
          <FieldLabel>Or a file</FieldLabel>
          {/* The browser's own file control is kept for what it does and for a
              screen reader, out of sight: a button opens it, and the file's
              name stands beside it. */}
          <input
            accept={accept}
            disabled={busy}
            key={fileInput}
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
            }}
            ref={fileRef}
            tabIndex={-1}
            type="file"
            {...stylex.props(visuallyHidden)}
          />
          <div {...stylex.props(styles.row)}>
            <Button
              disabled={busy}
              onClick={() => {
                fileRef.current?.click();
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              <Icon icon={UploadIcon} />
              Choose a file
            </Button>
            {file === null ? (
              <Text color="muted" size="sm">
                No file chosen
              </Text>
            ) : (
              <span {...stylex.props(styles.chosen)}>
                <Text size="sm">{file.name}</Text>
              </span>
            )}
            {file === null ? null : (
              <Button
                disabled={busy}
                onClick={clearFile}
                size="sm"
                type="button"
                variant="outline"
              >
                Remove the file
              </Button>
            )}
          </div>
          <FieldDescription>
            A .txt, .vtt, .srt or .docx file of at most 5 MB.
          </FieldDescription>
        </Field>
        <Field disabled={busy} style={styles.field}>
          <FieldLabel>Read it in</FieldLabel>
          <NativeSelect
            onChange={(event) => {
              const picked = interviewLocales.find(
                (each) => each === event.target.value
              );
              setLocale(picked ?? "en");
            }}
            style={styles.language}
            value={locale}
          >
            {interviewLocales.map((each) => (
              <NativeSelectOption key={each} value={each}>
                {languageWords[each]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <FieldDescription>
            The language Stephen writes down what it brought in.
          </FieldDescription>
        </Field>
        {failure === null ? null : (
          <Alert appearance="subtle" variant="destructive">
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
        )}
        <div {...stylex.props(styles.row)}>
          <Button
            disabled={busy || (file === null && text.trim() === "")}
            size="sm"
            type="submit"
          >
            {replacing ? "Read it again" : "Read it"}
          </Button>
          {busy ? (
            <span {...stylex.props(styles.row)}>
              <Spinner />
              <Text color="muted" size="sm">
                Stephen is reading it. This takes a minute.
              </Text>
            </span>
          ) : null}
        </div>
      </form>
    </CardContent>
  );
};

/** The sponsor's answer to what the kickoff left open about one field. */
const Answer = ({
  clientId,
  field,
  keep,
}: {
  clientId: string;
  field: AdminKickoffField;
  keep: Keep;
}) => {
  const shared = isVisionShared(field.field);
  const { busy, failure, run } = useKickoff(keep);
  const [text, setText] = useState(field.answer ?? "");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void run(
          async () =>
            await kickoffFn({
              data: {
                clientId,
                ask: { kind: "answer", field: field.field, text },
              },
            })
        );
      }}
      {...stylex.props(styles.answer)}
    >
      <Field disabled={busy}>
        <Textarea
          aria-label={`The sponsor’s answer: ${visionWords[field.field]}`}
          maxLength={answerMaxLength}
          onValueChange={setText}
          placeholder="The sponsor’s answer"
          value={text}
        />
        {shared ? (
          <FieldDescription>
            Part of the company’s vision: every member will see this answer.
          </FieldDescription>
        ) : null}
      </Field>
      {failure === null ? null : (
        <Alert appearance="subtle" variant="destructive">
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      )}
      <div {...stylex.props(styles.keep)}>
        <Button
          disabled={busy || text.trim() === (field.answer ?? "")}
          size="sm"
          type="submit"
          variant="outline"
        >
          Keep the answer
        </Button>
      </div>
    </form>
  );
};

/** One of the ten: brought, answered, or the question for the sponsor. */
const FieldRow = ({
  clientId,
  field,
  keep,
}: {
  clientId: string;
  field: AdminKickoffField;
  keep: Keep;
}) => {
  const known = field.state !== "open";
  return (
    <li {...stylex.props(styles.fieldRow)}>
      <span {...stylex.props(styles.fieldName)}>
        <span {...stylex.props(!known && styles.open)}>
          <Icon icon={known ? CircleCheckIcon : CircleHelpIcon} />
        </span>
        <Text size="sm" weight="medium">
          {visionWords[field.field]}
        </Text>
      </span>
      {field.state === "said" && field.answer === null ? null : (
        <div {...stylex.props(styles.under)}>
          {field.state === "said" ? null : (
            <Text color="muted" size="sm">
              {field.ask === ""
                ? "Ask the sponsor about it."
                : `Ask the sponsor: ${field.ask}`}
            </Text>
          )}
          <Answer
            clientId={clientId}
            field={field}
            key={field.answer ?? ""}
            keep={keep}
          />
        </div>
      )}
    </li>
  );
};

/** When the transcript came in, and from where. */
const broughtWords = (transcript: AdminKickoffView["transcript"]): string => {
  if (transcript === null) {
    return "Not brought in yet.";
  }
  const at = `${formatDate(transcript.at)}, ${transcript.at.slice(11, 16)}`;
  return transcript.fileName === null
    ? `Pasted on ${at} (UTC).`
    : `${transcript.fileName}, brought in on ${at} (UTC).`;
};

/** Client `clientId`'s kickoff as its core answers it, or why it isn't read. Never throws. */
const readKickoff = async (
  clientId: string
): Promise<{ kickoff: AdminKickoffView | null; unread: string | null }> => {
  let answer: KickoffAnswer = { kickoff: null, refused: "not_answered" };
  try {
    answer = await kickoffFn({ data: { clientId, ask: { kind: "read" } } });
  } catch {
    // Said as not answered.
  }
  return {
    kickoff: answer.kickoff,
    unread: answer.refused === null ? null : refusals[answer.refused],
  };
};

/**
 * The kickoff of client `clientId`, read from its core when the panel
 * opens: bringing the transcript in, and what it brought and left open.
 */
export const Kickoff = ({ clientId }: { clientId: string }) => {
  const [kickoff, setKickoff] = useState<AdminKickoffView | null>(null);
  const [unread, setUnread] = useState<string | null>(null);
  // A transcript that is in stays one line until staff ask to replace it.
  const [replacing, setReplacing] = useState(false);
  useEffect(() => {
    let current = true;
    const read = async (): Promise<void> => {
      const { kickoff: found, unread: why } = await readKickoff(clientId);
      if (current) {
        setKickoff(found);
        setUnread(why);
      }
    };
    void read();
    return () => {
      current = false;
    };
  }, [clientId]);
  const broughtIn = kickoff !== null && kickoff.transcript !== null;
  return (
    <>
      <CardContent>
        <div {...stylex.props(styles.stands)}>
          <Text color="muted" size="sm">
            {kickoff === null
              ? (unread ?? "Reading where it stands in the company’s Grasp…")
              : broughtWords(kickoff.transcript)}
          </Text>
          {broughtIn && !replacing ? (
            <Button
              onClick={() => {
                setReplacing(true);
              }}
              size="sm"
              variant="outline"
            >
              Replace
            </Button>
          ) : null}
        </div>
      </CardContent>
      {broughtIn && !replacing ? null : (
        <BringIn
          clientId={clientId}
          keep={(next) => {
            setKickoff(next);
            setReplacing(false);
          }}
          replacing={broughtIn}
        />
      )}
      {kickoff?.read === true ? (
        <CardContent flush>
          <ol
            aria-label="What it brought, and what it left open"
            {...stylex.props(styles.fields)}
          >
            {kickoff.fields.map((field) => (
              <FieldRow
                clientId={clientId}
                field={field}
                keep={setKickoff}
                key={field.field}
              />
            ))}
          </ol>
        </CardContent>
      ) : null}
    </>
  );
};
