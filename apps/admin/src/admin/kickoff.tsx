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
  transcriptFileKinds,
  transcriptFileMaxBytes,
  transcriptMaxLength,
} from "@grasp-os/shared/kickoff";
import { interviewLocales } from "@grasp-os/shared/onboarding";
import type { InterviewLocale } from "@grasp-os/shared/onboarding";
import { Button } from "@grasp-os/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@grasp-os/ui/components/field";
import { Input } from "@grasp-os/ui/components/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@grasp-os/ui/components/native-select";
import { Spinner } from "@grasp-os/ui/components/spinner";
import { Textarea } from "@grasp-os/ui/components/textarea";
import { useRouter } from "@tanstack/react-router";
import { CircleCheckIcon, CircleHelpIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { kickoffFn } from "../clients/kickoff-functions.ts";
import type { KickoffAnswer, KickoffRefusal } from "../clients/kickoff.ts";
import { InvalidFieldError, useAction } from "../use-action.ts";

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
  const id = useId();
  const { busy, failure, run } = useKickoff(keep);
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [locale, setLocale] = useState<InterviewLocale>("en");
  const bringIn = async (): Promise<void> => {
    await run(async () => {
      const transcript = file === null ? { text } : await fileTranscript(file);
      const answer = await kickoffFn({
        data: { clientId, ask: { kind: "save", locale, transcript } },
      });
      if (answer.kickoff !== null) {
        setText("");
        setFile(null);
      }
      return answer;
    });
  };
  return (
    <form
      className="flex flex-col gap-4 border-t px-5 py-4"
      onSubmit={(event) => {
        event.preventDefault();
        void bringIn();
      }}
    >
      <Field>
        <FieldLabel htmlFor={`${id}-text`}>The transcript</FieldLabel>
        <Textarea
          className="max-h-80"
          disabled={busy || file !== null}
          id={`${id}-text`}
          maxLength={transcriptMaxLength}
          onChange={(event) => {
            setText(event.target.value);
          }}
          placeholder="Paste the transcript of the first conversation with the sponsor"
          value={text}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-file`}>Or a file</FieldLabel>
        <Input
          accept={accept}
          disabled={busy}
          id={`${id}-file`}
          // Keyed by the file: empty again once it is brought in.
          key={file === null ? "none" : "chosen"}
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
          }}
          type="file"
        />
        <FieldDescription>
          A .txt, .vtt, .srt or .docx file of at most 5 MB.
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-language`}>Read it in</FieldLabel>
        <NativeSelect
          className="max-w-48"
          disabled={busy}
          id={`${id}-language`}
          onChange={(event) => {
            const picked = interviewLocales.find(
              (each) => each === event.target.value
            );
            setLocale(picked ?? "en");
          }}
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
        <p className="text-destructive" role="alert">
          {failure}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={busy || (file === null && text.trim() === "")}
          size="sm"
          type="submit"
        >
          {replacing ? "Read it again" : "Read it"}
        </Button>
        {busy ? (
          <span className="text-muted-foreground flex items-center gap-2">
            <Spinner />
            Stephen is reading it. This takes a minute.
          </span>
        ) : null}
      </div>
    </form>
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
  const id = useId();
  const { busy, failure, run } = useKickoff(keep);
  const [text, setText] = useState(field.answer ?? "");
  return (
    <form
      className="flex flex-col gap-2"
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
    >
      <label className="sr-only" htmlFor={id}>
        {`The sponsor’s answer: ${visionWords[field.field]}`}
      </label>
      <Textarea
        disabled={busy}
        id={id}
        maxLength={answerMaxLength}
        onChange={(event) => {
          setText(event.target.value);
        }}
        placeholder="The sponsor’s answer"
        value={text}
      />
      {failure === null ? null : (
        <p className="text-destructive" role="alert">
          {failure}
        </p>
      )}
      <div className="flex justify-end">
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
  const Icon = known ? CircleCheckIcon : CircleHelpIcon;
  return (
    <li className="flex flex-col gap-2 border-t px-5 py-3">
      <span className="flex items-center gap-2">
        <Icon
          aria-hidden
          className={
            known
              ? "size-4 flex-none"
              : "text-status-attention size-4 flex-none"
          }
        />
        <span className="font-medium">{visionWords[field.field]}</span>
      </span>
      {field.state === "said" && field.answer === null ? null : (
        <div className="flex flex-col gap-2 pl-6">
          {field.state === "said" ? null : (
            <p className="text-muted-foreground">
              {field.ask === ""
                ? "Ask the sponsor about it."
                : `Ask the sponsor: ${field.ask}`}
            </p>
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
  const at = transcript.at.slice(0, 16).replace("T", " ");
  return transcript.fileName === null
    ? `Pasted on ${at} (UTC). Bring it in again to read it again.`
    : `${transcript.fileName}, brought in on ${at} (UTC). Bring it in again to read it again.`;
};

/**
 * The kickoff of client `clientId`, read from its core when the panel
 * opens: bringing the transcript in, and what it brought and left open.
 */
export const Kickoff = ({ clientId }: { clientId: string }) => {
  const [kickoff, setKickoff] = useState<AdminKickoffView | null>(null);
  const [unread, setUnread] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    const read = async (): Promise<void> => {
      try {
        const answer = await kickoffFn({
          data: { clientId, ask: { kind: "read" } },
        });
        if (current) {
          setKickoff(answer.kickoff);
          setUnread(answer.refused === null ? null : refusals[answer.refused]);
        }
      } catch {
        if (current) {
          setUnread(refusals.not_answered);
        }
      }
    };
    void read();
    return () => {
      current = false;
    };
  }, [clientId]);
  return (
    <>
      <p className="text-muted-foreground border-t px-5 py-3">
        {kickoff === null
          ? (unread ?? "Reading where it stands in the company’s Grasp…")
          : broughtWords(kickoff.transcript)}
      </p>
      <BringIn
        clientId={clientId}
        keep={setKickoff}
        replacing={kickoff?.transcript !== null && kickoff !== null}
      />
      {kickoff?.read === true ? (
        <ol aria-label="What it brought, and what it left open">
          {kickoff.fields.map((field) => (
            <FieldRow
              clientId={clientId}
              field={field}
              keep={setKickoff}
              key={field.field}
            />
          ))}
        </ol>
      ) : null}
    </>
  );
};
