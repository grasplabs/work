import type { InterviewLocale } from "@grasp-os/shared/onboarding";
import { documentErrors } from "@grasp-os/shared/onboarding-documents";
import { Button } from "@grasp-os/ui/components/button";
import { FileUpload } from "@grasp-os/ui/components/file-upload";
import { ArrowRightIcon, Icon } from "@grasp-os/ui/lib/icons";
import { media, space } from "@grasp-os/ui/lib/tokens.stylex";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useState } from "react";

import { CoreTimeoutError } from "../core.ts";
import { TopError } from "../frame/top-error.tsx";
import { isLocale } from "../i18n.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { CalmStep } from "./calm-frame.tsx";
import { readable } from "./document-files.ts";
import { DocumentPages } from "./document-pages.tsx";
import { DocumentShelf } from "./document-shelf.tsx";
import type { Sending } from "./document-shelf.tsx";
import { DocumentVisitors } from "./document-visitors.tsx";
import { kindsOf, useContextWords } from "./sources-step.tsx";
import { useRefresh } from "./step-parts.ts";
import type { StepProps } from "./step-parts.ts";
import { useAnswer, useLeaving } from "./step-voice.tsx";

// Documents that explain how they work, on Damsko's File upload, the kinds
// of file Grasp reads lying over its drop zone as pages (document-pages.tsx):
// each is sent to core the moment it is added and read there for real.
// Over the zone, from its start edge, one shelf of what was shared, on this
// visit or an earlier one (document-shelf.tsx): a small chip each, its own
// pixel page filling in as it is sent, then ticked, with Remove; a refusal
// said on its chip with Try again. The step's words and the way on stand centred.
// The zone is the step's one way in and takes
// the room: where documents live (SharePoint and OneDrive) is connected
// on the step before, so it is not offered again here.
// Now and then a visitor's cursor drifts in beside the zone, asks for a
// kind of document, and tosses one in (document-visitors.tsx).

const styles = stylex.create({
  stack: { display: "grid", gap: space[4] },
  // The drop zone, tall: the step's one place to act.
  zone: { minHeight: { default: "18rem", [media.maxSm]: "12rem" } },
});

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

/** What Stephen says of the documents shared, as the next step arrives. */
const documentsLeft = {
  none: msg`No documents for now, that’s fine. You can add them later too.`,
  one: msg`Thanks for the document. I’ll read it before I talk to anyone.`,
  some: msg`Thanks for the documents. I’ll read them before I talk to anyone.`,
};

/**
 * What Stephen answers as files are dropped in. One he couldn't read shows in the bar at the top,
 * and he answers that as he does every error (step-voice.tsx).
 */
const documentAnswers = {
  one: msg`Got it, I’ll read that one.`,
  some: msg`Got them, I’ll read through those.`,
};

export const DocumentsStep = ({ data, onward }: StepProps) => {
  const { t, i18n } = useLingui();
  const core = useCore();
  const refresh = useRefresh();
  const { run, busy } = useCoreAction();
  const problemOf = useProblemOf();
  const kinds = kindsOf(useContextWords(data));
  const locale: InterviewLocale = isLocale(i18n.locale) ? i18n.locale : "en";
  const kept = data.documents;
  // The files on their way: each sent the moment it is added, and once read, one of the documents shared.
  const [coming, setComing] = useState<Sending[]>([]);
  const [removeProblem, setRemoveProblem] = useState<string>();
  const answer = useAnswer([documentAnswers.one, documentAnswers.some]);
  let left = documentsLeft.some;
  if (kept.length === 0) {
    left = documentsLeft.none;
  } else if (kept.length === 1) {
    left = documentsLeft.one;
  }
  useLeaving(left);
  const change = (file: File, to: Partial<Sending> | null) => {
    setComing((now) =>
      to === null
        ? now.filter((each) => each.file !== file)
        : now.map((each) => (each.file === file ? { ...each, ...to } : each))
    );
  };
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
      change(file, { done: true });
      await refresh();
      // Its page fills to the end before it becomes one of the documents shared.
      window.setTimeout(() => {
        change(file, null);
      }, 420);
    } catch (error) {
      change(file, { problem: problemOf(error) });
    }
  };
  const send = (files: File[]) => {
    if (files.length > 0) {
      answer(files.length === 1 ? documentAnswers.one : documentAnswers.some);
    }
    setComing((now) => [
      ...now,
      ...files.map((file) => ({ file, done: false, problem: null })),
    ]);
    for (const file of files) {
      void upload(file);
    }
  };
  const retry = (file: File) => {
    change(file, { problem: null });
    void upload(file);
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
  return (
    <CalmStep
      body={
        kinds === null
          ? t`Policies, procedures, work instructions. Anything that explains how you work helps.`
          : t`${kinds}, and whatever explains how you work.`
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
      spoken={t`This is a good moment to give me some context. A process description, an onboarding guide or a price list helps me understand what you’re dealing with every day. The more I know, the better my questions to your team, and the more useful everything I give back.`}
      title={t`Do you have anything that explains how you work?`}
    >
      <div {...stylex.props(styles.stack)}>
        <TopError>{removeProblem}</TopError>
        <DocumentShelf
          busy={busy}
          coming={coming}
          kept={kept}
          onDismiss={(file) => {
            change(file, null);
          }}
          onRemove={(id) => {
            void remove(id);
          }}
          onRetry={retry}
        />
        <DocumentPages shared={kept.map(({ name }) => name)}>
          <FileUpload
            accept={accepted}
            // The one way in on this step, so it takes the room: SharePoint and OneDrive were connected a step before.
            style={styles.zone}
            // What it takes is said in the step's own words, not in a smaller line under the zone.
            description=""
            multiple
            // Its own list stays empty: the files show on the shelf under it, as pixel pages.
            onValueChange={send}
            value={[]}
          />
        </DocumentPages>
      </div>
      <DocumentVisitors />
    </CalmStep>
  );
};
