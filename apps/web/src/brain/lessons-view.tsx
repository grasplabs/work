import { failureText } from "@grasp-os/shared/errors";
import { Trans, useLingui } from "@lingui/react/macro";
import * as stylex from "@stylexjs/stylex";
import { useEffect, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
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
import { Empty, EmptyHeader, EmptyTitle } from "../grasp/empty/index.ts";
import { Skill } from "../grasp/icons/index.ts";
import { InspectorPanel } from "../grasp/inspector-panel/index.ts";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../grasp/item/index.ts";
import { Text } from "../grasp/text/index.ts";
import { grasp, media } from "../grasp/tokens/tokens.stylex.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";
import { FactLine } from "./memory-parts.tsx";
import type { Fact } from "./memory-parts.tsx";

// The Brain's lessons, as a person inspects and corrects them (GRA-301):
// what consolidation kept from repeated failures they may see, each with
// its versions and the turns or runs it rests on, as far as they were
// part of them, in the inspector beside the list. Core decides what they
// see and what they may retire; a retirement asks first, and goes against
// the revision read. Text is text, never markup.

type Knowledge = Session["knowledge"];
type Summary = Awaited<ReturnType<Knowledge["lessonsList"]>>[number];
type Lineage = Awaited<ReturnType<Knowledge["lessonsLineage"]>>;

type Read<T> =
  | { state: "loading" }
  | { state: "refused"; message: string }
  | { state: "ready"; data: T };

const styles = stylex.create({
  // The list, and the lesson in hand beside it once the page is wide
  // enough; under it on a narrow one.
  split: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      [media.fromSidebar]: `minmax(0, 1fr) ${grasp.inspectorWidth}`,
    },
    gap: grasp.space6,
    alignItems: "start",
    minWidth: 0,
  },
  list: { display: "grid", gap: grasp.space2, minWidth: 0 },
  // A lesson's versions in the panel's card, newest first.
  versions: {
    display: "grid",
    gap: grasp.space4,
    margin: 0,
    paddingBlock: grasp.space3,
    paddingInline: grasp.inspectorInset,
    listStyle: "none",
  },
  version: { display: "grid", gap: grasp.space1, minWidth: 0 },
  episodes: { display: "grid", margin: 0, padding: 0, listStyle: "none" },
});

/** What `read` answers, or why not; outside components, which can't `try`. */
const readFrom = async <T,>(
  core: CoreConnection,
  read: (knowledge: Knowledge) => Promise<T>
): Promise<Read<T>> => {
  try {
    const data = await core.withSession(
      async (session) => await read(session.knowledge)
    );
    return { state: "ready", data };
  } catch (error) {
    return { state: "refused", message: failureText(error) };
  }
};

const ScopeLabel = ({ lesson }: { lesson: Summary }) => {
  const { t } = useLingui();
  return lesson.scope === "person"
    ? t({ message: "Yours", context: "lesson scope" })
    : t({ message: "A shared chat", context: "lesson scope" });
};

const StateLabel = ({ lesson }: { lesson: Summary }) => {
  const { t } = useLingui();
  return lesson.state === "candidate"
    ? t({ message: "Candidate", context: "lesson state" })
    : t({ message: "Retired", context: "lesson state" });
};

/** The evidence: supported in words; contested, which wants a look, marked. */
const EvidenceMark = ({ lesson }: { lesson: Summary }) => {
  const { t } = useLingui();
  return lesson.evidenceStatus === "supported" ? (
    t({ message: "Supported", context: "lesson evidence" })
  ) : (
    <Badge size="sm" tone="attention">
      {t({ message: "Contested", context: "lesson evidence" })}
    </Badge>
  );
};

/** What a lesson is: whose, its state, its evidence and its revision. */
const factsOf = (lesson: Summary): Fact[] => [
  { id: "scope", fact: <ScopeLabel lesson={lesson} /> },
  { id: "state", fact: <StateLabel lesson={lesson} /> },
  { id: "evidence", fact: <EvidenceMark lesson={lesson} /> },
  { id: "revision", fact: <Trans>Revision {lesson.revision}</Trans> },
];

/** Retires a lesson against the revision read, once the person says so. */
const RetireLesson = ({
  lesson,
  onDone,
}: {
  lesson: Summary;
  onDone: () => void;
}) => {
  const { t } = useLingui();
  const { failure, run } = useCoreAction();
  const retire = async (): Promise<void> => {
    const retired = await run(async (session) => {
      await session.knowledge.lessonsRetire({
        lessonId: lesson.id,
        expectedRevision: lesson.revision,
      });
      return true;
    });
    // Read again only once retired: a refusal stays on screen.
    if (retired !== true) {
      throw new Error("The lesson wasn't retired.");
    }
    onDone();
  };
  return (
    <AlertDialog>
      <AlertDialogTrigger size="xs">{t`Retire this lesson`}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogTitle>{t`Retire this lesson?`}</AlertDialogTitle>
        <AlertDialogDescription>
          {t`Grasp and your agents stop using it. It stays here, as retired.`}
        </AlertDialogDescription>
        <ErrorText>{failure}</ErrorText>
        <AlertDialogFooter>
          <AlertDialogAction>{t`Keep it`}</AlertDialogAction>
          <AlertDialogAction
            action={retire}
            failedLabel={t`Not retired`}
            variant="danger"
            workingLabel={t`Retiring`}
          >
            {t({ message: "Retire", context: "confirm retiring a lesson" })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};

/** A lesson's versions, newest first, and the turns or runs each rests on. */
const Versions = ({ versions }: { versions: Lineage["versions"] }) => (
  <ol {...stylex.props(styles.versions)}>
    {versions.map((version) => (
      <li key={version.revision} {...stylex.props(styles.version)}>
        <Text element="span" size="xs" weight="medium">
          {version.supersedes === null ? (
            <Trans>Revision {version.revision}</Trans>
          ) : (
            <Trans>
              Revision {version.revision}, after revision {version.supersedes}
            </Trans>
          )}
          {" · "}
          {formatDateTime(version.createdAt)}
        </Text>
        {version.instruction === null ? (
          <Text element="span" size="xs" tone="muted">
            <Trans>It rests on turns you were not part of.</Trans>
          </Text>
        ) : (
          <Text element="span" size="sm">
            {version.instruction}
          </Text>
        )}
        {version.wording === null ? null : (
          <Text element="span" size="sm" tone="muted">
            <Trans>Written by a model: {version.wording}</Trans>
          </Text>
        )}
        <ul {...stylex.props(styles.episodes)}>
          {version.episodes.map((episode) => (
            <li key={episode.episodeId}>
              <Text element="span" size="xs" tone="muted">
                {episode.role === "supporting" ? (
                  <Trans>Failed: {episode.taskType}</Trans>
                ) : (
                  <Trans>Completed: {episode.taskType}</Trans>
                )}
                {" · "}
                {formatDateTime(episode.occurredAt)}
              </Text>
            </li>
          ))}
        </ul>
      </li>
    ))}
  </ol>
);

/** One lesson's versions and what it rests on, and its retirement. */
const LessonPanel = ({
  lessonId,
  admin,
  onChanged,
  onClose,
}: {
  lessonId: string;
  admin: boolean;
  onChanged: () => void;
  onClose: () => void;
}) => {
  const { t } = useLingui();
  const core = useCore();
  // Keyed by the lesson and the changes made: read afresh for each.
  const [answered, setAnswered] = useState<Read<Lineage>>({
    state: "loading",
  });
  useEffect(() => {
    let left = false;
    const read = async (): Promise<void> => {
      const answer = await readFrom(
        core,
        async (knowledge) => await knowledge.lessonsLineage({ lessonId })
      );
      if (!left) {
        setAnswered(answer);
      }
    };
    void read();
    return () => {
      left = true;
    };
  }, [core, lessonId]);
  if (answered.state === "loading") {
    return null;
  }
  if (answered.state === "refused") {
    return <ErrorText>{answered.message}</ErrorText>;
  }
  const { lesson, versions } = answered.data;
  // A person's own lesson is theirs to retire; a shared chat's, an
  // admin's among the people who may see it (core decides).
  const retirable =
    lesson.state === "candidate" && (lesson.scope === "person" || admin);
  return (
    <InspectorPanel
      actions={
        retirable ? <RetireLesson lesson={lesson} onDone={onChanged} /> : null
      }
      aria-label={lesson.instruction}
      icon={Skill}
      meta={factsOf(lesson).map(({ fact }) => fact)}
      onClose={onClose}
      sections={[
        {
          id: "versions",
          label: t({ message: "Versions", context: "a lesson's revisions" }),
          content: <Versions versions={versions} />,
        },
      ]}
      title={lesson.instruction}
      words={{ close: t`Close` }}
    />
  );
};

/** The lessons the person may see; keyed by the changes made, read afresh. */
const LessonList = ({
  picked,
  onPick,
}: {
  picked: string | undefined;
  onPick: (lessonId: string) => void;
}) => {
  const core = useCore();
  const [listed, setListed] = useState<Read<Summary[]>>({ state: "loading" });
  useEffect(() => {
    let left = false;
    const read = async (): Promise<void> => {
      const answer = await readFrom(
        core,
        async (knowledge) => await knowledge.lessonsList()
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
  if (listed.state === "loading") {
    return null;
  }
  if (listed.state === "refused") {
    return <ErrorText>{listed.message}</ErrorText>;
  }
  if (listed.data.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>
            <Trans>No lessons yet</Trans>
          </EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <ItemGroup>
      {listed.data.map((lesson) => (
        <Item
          current={picked === lesson.id}
          key={lesson.id}
          render={
            <button
              aria-label={lesson.instruction}
              onClick={() => {
                onPick(lesson.id);
              }}
              type="button"
            />
          }
          size="sm"
        >
          <ItemMedia icon={Skill} iconLook="inline" />
          <ItemContent>
            <ItemTitle>{lesson.instruction}</ItemTitle>
            <ItemDescription>
              <FactLine facts={factsOf(lesson)} />
            </ItemDescription>
          </ItemContent>
        </Item>
      ))}
    </ItemGroup>
  );
};

/** The lessons the person may see, and the one in hand. */
export const LessonsView = ({ admin }: { admin: boolean }) => {
  const [picked, setPicked] = useState<string>();
  const [changes, setChanges] = useState(0);
  return (
    <div {...stylex.props(styles.split)}>
      <div {...stylex.props(styles.list)}>
        <LessonList key={changes} onPick={setPicked} picked={picked} />
      </div>
      {picked === undefined ? null : (
        <LessonPanel
          admin={admin}
          key={`${picked}:${changes}`}
          lessonId={picked}
          onChanged={() => {
            setChanges((count) => count + 1);
          }}
          onClose={() => {
            setPicked(undefined);
          }}
        />
      )}
    </div>
  );
};
