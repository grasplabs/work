import { placeErrors } from "@grasp-os/shared/document-places";
import type { PlacesSuite } from "@grasp-os/shared/document-places";
import type { InterviewLocale } from "@grasp-os/shared/onboarding";
import { documentErrors } from "@grasp-os/shared/onboarding-documents";
import type { OnboardingDocument } from "@grasp-os/shared/onboarding-documents";
import { Button } from "@grasp-os/ui/components/button";
import { Card } from "@grasp-os/ui/components/card";
import { FileUpload } from "@grasp-os/ui/components/file-upload";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@grasp-os/ui/components/item";
import { Text } from "@grasp-os/ui/components/text";
import {
  FileDocIcon,
  FileIcon,
  FilePdfIcon,
  Icon,
  XIcon,
} from "@grasp-os/ui/lib/icons";
import { space } from "@grasp-os/ui/lib/tokens.stylex";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { CoreTimeoutError } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { isLocale } from "../i18n.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { CalmStep } from "./calm-frame.tsx";
import { extensionOf, readable } from "./document-files.ts";
import { DocumentPages } from "./document-pages.tsx";
import { PlacePicker } from "./place-picker.tsx";
import type { PickedFile } from "./place-picker.tsx";
import { kindsOf, useContextWords } from "./sources-step.tsx";
import {
  returnedSchema,
  suiteLogos,
  suiteNames,
  useRefresh,
} from "./step-parts.ts";
import type { StepProps } from "./step-parts.ts";

// Documents that explain how they work, on Damsko's File upload, the kinds
// of file Grasp reads lying over its drop zone as pages (document-pages.tsx):
// each is sent to core the moment it is added and read there for real, its
// row showing how far it is, and a refusal said on its row with Try again.
// Once read it leaves the upload's list for the one list of what was
// shared, on this visit or an earlier one, each with Remove.
// What only the one who shared it can say, Stephen asks at once, with
// the answers to pick from. Where the deployment signs in with Microsoft
// or Google, the admin can pick them where they live instead (GRA-370):
// SharePoint and OneDrive, or Google Drive, connected here through
// Grasp's own read-only connection, which fetches only the files picked.

const styles = stylex.create({
  stack: { display: "grid", gap: space[4] },
  places: { display: "flex", flexWrap: "wrap", gap: space[3] },
  question: { display: "grid", gap: space[4] },
  options: { display: "flex", flexWrap: "wrap", gap: space[2] },
});

/** Where connecting the places documents live comes back to: this step. */
const documentsStep = "/setup?step=documents";

/** A shared document's own icon, by its kind. */
const iconOf = (name: string) => {
  const extension = extensionOf(name);
  if (extension === "pdf") {
    return FilePdfIcon;
  }
  return ["docx", "doc"].includes(extension) ? FileDocIcon : FileIcon;
};

/** Every kind of file core reads, as the upload takes them. */
const accepted = readable.map((extension) => `.${extension}`);

/** Starts connecting the places of `suite`: the browser goes to its sign-in, and comes back here. False if it could not start. */
const startPlaces = async (
  core: ReturnType<typeof useCore>,
  suite: PlacesSuite
): Promise<boolean> => {
  try {
    const { url } = await core.withSession(
      async (session) =>
        await session.onboarding.connectDocumentPlaces(suite, documentsStep)
    );
    window.location.assign(url);
    return true;
  } catch {
    return false;
  }
};

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
    const placeCode = placeErrors.codeOf(error);
    if (placeCode === "place.inactive" || placeCode === "place.not_connected") {
      return t`Not read: connect it again`;
    }
    if (placeCode === "place.no_item" || placeCode === "place.not_a_file") {
      return t`No longer where it was`;
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
  const { suites, places } = data;
  // The files on their way: once read, each leaves for the list of what was shared.
  const [coming, setComing] = useState<File[]>([]);
  const [picked, setPicked] = useState<PickedFile[]>([]);
  const [removeProblem, setRemoveProblem] = useState<string>();
  const navigate = useNavigate();
  const search: unknown = useSearch({ strict: false });
  const returned = returnedSchema.safeParse(search).success;
  const [connecting, setConnecting] = useState<PlacesSuite | null>(null);
  // Back from the sign-in, the picker opens at once; or it says why it can't.
  const connectedNow = returned && places?.status === "active";
  const [picking, setPicking] = useState<PlacesSuite | null>(
    connectedNow ? places.suite : null
  );
  const [placeProblem, setPlaceProblem] = useState<string | null>(
    returned && !connectedNow
      ? t`I could not connect where your documents live. Try again with an administrator’s account, or add them here.`
      : null
  );
  // Back from the sign-in, the address forgets the connection.
  const forgot = useRef(false);
  useEffect(() => {
    if (returned && !forgot.current) {
      forgot.current = true;
      void navigate({
        to: "/setup",
        search: { step: "documents" },
        replace: true,
      });
    }
  });
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
  const sharePicked = async (files: PickedFile[]) => {
    setPicked((now) => [...now, ...files]);
    await Promise.all(
      files.map(async ({ place, item, name }) => {
        try {
          await core.withSession(
            async (session) =>
              await session.onboarding.sharePlaceFile({ locale, place, item })
          );
        } catch (error) {
          setPlaceProblem(`${name}: ${problemOf(error)}`);
        }
      })
    );
    setPicked((now) => now.filter((each) => !files.includes(each)));
    await refresh();
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
  const connect = async (suite: PlacesSuite) => {
    setPicking(null);
    setConnecting(suite);
    setPlaceProblem(null);
    const signIn = suiteNames[suite];
    if (!(await startPlaces(core, suite))) {
      setPlaceProblem(
        t`I could not reach ${signIn} just now. Try again in a moment, or add the documents here.`
      );
      setConnecting(null);
    }
  };
  // Picked from a working connection; connected first, or again, otherwise.
  const choose = (suite: PlacesSuite) => {
    if (places?.suite === suite && places.status === "active") {
      setPlaceProblem(null);
      setPicking(suite);
      return;
    }
    void connect(suite);
  };
  const reading = picked.length;
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
        </Button>
      }
      title={t`Do you have anything that explains how you work?`}
    >
      <div {...stylex.props(styles.stack)}>
        <DocumentPages shared={kept.map(({ name }) => name)}>
          <FileUpload
            accept={accepted}
            // What it takes is said in the step's own words, not in a smaller line under the zone.
            description=""
            multiple
            onUpload={upload}
            onValueChange={setComing}
            value={coming}
          />
        </DocumentPages>
        {kept.length === 0 ? null : (
          <ItemGroup aria-label={t`Documents you shared`}>
            {kept.map(({ id, name }: OnboardingDocument) => (
              <Item key={id} variant="outline">
                <ItemMedia variant="icon">
                  <Icon icon={iconOf(name)} />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{name}</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Button
                    aria-label={t`Remove ${name}`}
                    disabled={busy}
                    onClick={() => {
                      void remove(id);
                    }}
                    size="icon-sm"
                    tooltip={t`Remove`}
                    variant="ghost"
                  >
                    <Icon icon={XIcon} />
                  </Button>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        )}
        <ErrorText>{removeProblem}</ErrorText>
        {open === undefined || ask === null ? null : (
          <Card padding="lg">
            <div {...stylex.props(styles.question)}>
              <Text size="lg">{`${open.reading.about} ${ask.question}`}</Text>
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
        {suites.length === 0 ? null : (
          <div {...stylex.props(styles.places)}>
            {suites.map((suite) => (
              <Button
                disabled={connecting !== null || picked.length > 0}
                key={suite}
                onClick={() => {
                  choose(suite);
                }}
                size="lg"
                status={connecting === suite ? "loading" : "idle"}
                variant="outline"
              >
                <Icon icon={suiteLogos[suite]} />
                {suite === "microsoft"
                  ? t`Choose from SharePoint or OneDrive`
                  : t`Choose from Google Drive`}
              </Button>
            ))}
          </div>
        )}
        {picked.length === 0 ? null : (
          <Text size="lg">
            {plural(reading, {
              one: "I’m reading # document from where it lives.",
              other: "I’m reading # documents from where they live.",
            })}
          </Text>
        )}
        <ErrorText>{placeProblem ?? undefined}</ErrorText>
      </div>
      {picking === null ? null : (
        <PlacePicker
          onAdd={(files) => {
            setPicking(null);
            void sharePicked(files);
          }}
          onOpenChange={(opened) => {
            if (!opened) {
              setPicking(null);
            }
          }}
          onReconnect={() => {
            void connect(picking);
          }}
          open
          suite={picking}
        />
      )}
    </CalmStep>
  );
};
