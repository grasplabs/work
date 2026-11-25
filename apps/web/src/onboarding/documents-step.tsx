import type { InterviewLocale } from "@grasp-os/shared/onboarding";
import { documentErrors } from "@grasp-os/shared/onboarding-documents";
import { Button } from "@grasp-os/ui/components/button";
import { Card } from "@grasp-os/ui/components/card";
import { FileUpload } from "@grasp-os/ui/components/file-upload";
import { Text } from "@grasp-os/ui/components/text";
import { ArrowRightIcon, Icon } from "@grasp-os/ui/lib/icons";
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
import { DocumentShelf } from "./document-shelf.tsx";
import type { Sending } from "./document-shelf.tsx";
import { DocumentVisitors } from "./document-visitors.tsx";
import { kindsOf, useContextWords } from "./sources-step.tsx";
import { useRefresh } from "./step-parts.ts";
import type { StepProps } from "./step-parts.ts";

// Documents that explain how they work, on Damsko's File upload, the kinds
// of file Grasp reads lying over its drop zone as pages (document-pages.tsx):
// each is sent to core the moment it is added and read there for real.
// Over the zone, from its start edge, one shelf of what was shared, on this
// visit or an earlier one (document-shelf.tsx): a small chip each, its own
// pixel page filling in as it is sent, then ticked, with Remove; a refusal
// said on its chip with Try again. The step's words and the way on stand centred.
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
  // The files on their way: each sent the moment it is added, and once read, one of the documents shared.
  const [coming, setComing] = useState<Sending[]>([]);
  const [removeProblem, setRemoveProblem] = useState<string>();
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
      <DocumentVisitors paused={ask !== null} />
    </CalmStep>
  );
};
