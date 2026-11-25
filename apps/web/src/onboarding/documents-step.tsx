import type { InterviewLocale } from "@grasp-os/shared/onboarding";
import { documentErrors } from "@grasp-os/shared/onboarding-documents";
import type { OnboardingDocument } from "@grasp-os/shared/onboarding-documents";
import { uploadExtensionOf, uploadTypes } from "@grasp-os/shared/uploads";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "@grasp-os/ui/components/attachment";
import { Button } from "@grasp-os/ui/components/button";
import { Card } from "@grasp-os/ui/components/card";
import { FileUpload } from "@grasp-os/ui/components/file-upload";
import { Text } from "@grasp-os/ui/components/text";
import { ArrowRightIcon, Icon, XIcon } from "@grasp-os/ui/lib/icons";
import { media, space } from "@grasp-os/ui/lib/tokens.stylex";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { CoreTimeoutError } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { isLocale } from "../i18n.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { CalmStep } from "./calm-frame.tsx";
import { readable } from "./document-files.ts";
import { DocumentPages } from "./document-pages.tsx";
import { DocumentVisitors } from "./document-visitors.tsx";
import { kindsOf, useContextWords } from "./sources-step.tsx";
import { useRefresh } from "./step-parts.ts";
import type { StepProps } from "./step-parts.ts";

// Documents that explain how they work, on Damsko's File upload, the kinds
// of file Grasp reads lying over its drop zone as pages (document-pages.tsx):
// each is sent to core the moment it is added and read there for real, its
// row showing how far it is, and a refusal said on its row with Try again.
// Once read it leaves the upload's list for the one list of what was
// shared, on this visit or an earlier one, above the zone: small chips
// side by side (Damsko's Attachment), each with Remove. The step's words and the way on stand centred.
// What only the one who shared it can say, Stephen asks at once, with
// the answers to pick from. The zone is the step's one way in and takes
// the room: where documents live (SharePoint and OneDrive) is connected
// on the step before, so it is not offered again here.
// Now and then a visitor's cursor drifts in beside the zone, asks for a
// kind of document, and tosses one in (document-visitors.tsx).

const styles = stylex.create({
  stack: { display: "grid", gap: space[4] },
  // The drop zone, tall: the step's one place to act.
  zone: { minHeight: { default: "18rem", [media.maxSm]: "12rem" } },
  question: { display: "grid", gap: space[4] },
  options: { display: "flex", flexWrap: "wrap", gap: space[2] },
});

/** A shared document's media type, by its name, for the mark its chip wears. */
const typeOf = (name: string): string | undefined => {
  const extension = uploadExtensionOf(name);
  return extension === undefined ? undefined : uploadTypes[extension];
};

/** Every kind of file core reads, as the upload takes them. */
const accepted = readable.map((extension) => `.${extension}`);

/** Why core could not read a document, as its row says it. */
const useProblemOf = (): ((error: unknown) => string) => {
  const { t } = useLingui();
  return (error) => {
    if (error instanceof CoreTimeoutError) {
      return t`Not read: no connection`;
    }
    const code = documentErrors.codeOf(error);
    if (code === "document.too_large") {
      return t`Too large to read`;
    }
    if (code === "document.old_format" || code === "document.slides") {
      return t`An old format: save it as PDF or a newer file`;
    }
    if (
      code === "document.unsupported" ||
      code === "document.empty" ||
      code === "document.too_complex"
    ) {
      return t`I couldn’t read this one`;
    }
    return t`Not read: add it again`;
  };
};

export const DocumentsStep = ({ data, onward }: StepProps) => {
  const { t, i18n } = useLingui();
  const core = useCore();
  const refresh = useRefresh();
  const { run, busy, failure } = useCoreAction();
  const problemOf = useProblemOf();
  const kinds = kindsOf(useContextWords(data));
  const locale: InterviewLocale = isLocale(i18n.locale) ? i18n.locale : "en";
  const kept = data.documents;
  // The files on their way: once read, each leaves for the list of what was shared.
  const [coming, setComing] = useState<File[]>([]);
  const [removeProblem, setRemoveProblem] = useState<string>();
  const upload = async (file: File): Promise<void> => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await core.withSession(
        async (session) =>
          await session.onboarding.shareDocument({
            locale,
            name: file.name,
            bytes,
          })
      );
      await refresh();
      setComing((now) => now.filter((each) => each !== file));
    } catch (error) {
      throw new Error(problemOf(error), { cause: error });
    }
  };
  const remove = async (id: string): Promise<void> => {
    setRemoveProblem(undefined);
    const removed = await run(async (session) => {
      await session.onboarding.removeDocument(id);
      return true;
    }, setRemoveProblem);
    if (removed === true) {
      await refresh();
    }
  };
  // The one question about a document while it waits for an answer; the first shared is asked first (core lists the newest first).
  const open = kept.findLast(
    (each) => each.reading.ask !== null && each.answer === null
  );
  const ask = open?.reading.ask ?? null;
  const answer = async (option: string) => {
    if (open !== undefined) {
      const saved = await run(
        async (session) =>
          await session.onboarding.answerDocument(open.id, option)
      );
      if (saved !== undefined) {
        await refresh();
      }
    }
  };
  return (
    <CalmStep
      body={
        kinds === null
          ? t`Policies, procedures, work instructions. Drafts are fine too. Leave out anything about one person.`
          : t`${kinds}, and whatever explains how you work. Drafts are fine too. Leave out anything about one person.`
      }
      end={
        <Button
          onClick={() => {
            void onward();
          }}
          size="lg"
        >
          {t`Continue`}
          <Icon icon={ArrowRightIcon} />
        </Button>
      }
      title={t`Do you have anything that explains how you work?`}
    >
      <div {...stylex.props(styles.stack)}>
        {kept.length === 0 ? null : (
          <AttachmentGroup aria-label={t`Documents you shared`}>
            {kept.map(({ id, name }: OnboardingDocument) => (
              <Attachment key={id}>
                <AttachmentMedia type={typeOf(name)} />
                <AttachmentContent>
                  <AttachmentTitle>{name}</AttachmentTitle>
                </AttachmentContent>
                <AttachmentActions>
                  <AttachmentAction
                    aria-label={t`Remove ${name}`}
                    disabled={busy}
                    onClick={() => {
                      void remove(id);
                    }}
                  >
                    <Icon icon={XIcon} />
                  </AttachmentAction>
                </AttachmentActions>
              </Attachment>
            ))}
          </AttachmentGroup>
        )}
        <ErrorText>{removeProblem}</ErrorText>
        {open === undefined || ask === null ? null : (
          <Card padding="lg">
            <div {...stylex.props(styles.question)}>
              <Text>{`${open.reading.about} ${ask.question}`}</Text>
              <div {...stylex.props(styles.options)}>
                {ask.options.map((option) => (
                  <Button
                    disabled={busy}
                    key={option}
                    onClick={() => {
                      void answer(option);
                    }}
                    size="lg"
                    variant="outline"
                  >
                    {option}
                  </Button>
                ))}
              </div>
              <ErrorText>{failure}</ErrorText>
            </div>
          </Card>
        )}
        <DocumentPages shared={kept.map(({ name }) => name)}>
          <FileUpload
            accept={accepted}
            // The one way in on this step, so it takes the room: SharePoint and OneDrive were connected a step before.
            style={styles.zone}
            // What it takes is said in the step's own words, not in a smaller line under the zone.
            description=""
            multiple
            onUpload={upload}
            onValueChange={setComing}
            value={coming}
          />
        </DocumentPages>
      </div>
      <DocumentVisitors paused={ask !== null} />
    </CalmStep>
  );
};
