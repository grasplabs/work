import { failureText } from "@grasp-os/shared/errors";
import { Badge } from "@grasp-os/ui/components/badge";
import { Button } from "@grasp-os/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@grasp-os/ui/components/empty";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";

import type { CoreConnection } from "../core-connection.ts";
import type { Session } from "../core.ts";
import { ErrorText } from "../error-text.tsx";
import { formatDateTime } from "../format.ts";
import { useCoreAction } from "../use-core-action.ts";
import { useCore } from "../use-core.ts";

// The Brain's lessons, as a person inspects and corrects them (GRA-301):
// what consolidation kept from repeated failures they may see, each with
// its versions and the turns or runs it rests on, as far as they were
// part of them. Core decides what they see and what they may retire; a
// retirement goes against the revision read. Text is text, never markup.

type Knowledge = Session["knowledge"];
type Summary = Awaited<ReturnType<Knowledge["lessonsList"]>>[number];
type Lineage = Awaited<ReturnType<Knowledge["lessonsLineage"]>>;

type Read<T> =
  | { state: "loading" }
  | { state: "refused"; message: string }
  | { state: "ready"; data: T };

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

const LessonBadges = ({ lesson }: { lesson: Summary }) => {
  const { t } = useLingui();
  return (
    <span className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
      <Badge variant="outline">
        {lesson.scope === "person"
          ? t({ message: "Yours", context: "lesson scope" })
          : t({ message: "A shared chat", context: "lesson scope" })}
      </Badge>
      <Badge variant={lesson.state === "candidate" ? "secondary" : "outline"}>
        {lesson.state === "candidate"
          ? t({ message: "Candidate", context: "lesson state" })
          : t({ message: "Retired", context: "lesson state" })}
      </Badge>
      <Badge variant="outline">
        {lesson.evidenceStatus === "supported"
          ? t({ message: "Supported", context: "lesson evidence" })
          : t({ message: "Contested", context: "lesson evidence" })}
      </Badge>
      <span>
        <Trans>Revision {lesson.revision}</Trans>
      </span>
    </span>
  );
};

/** One lesson's versions and what it rests on, and its retirement. */
const LessonPanel = ({
  lessonId,
  admin,
  onChanged,
}: {
  lessonId: string;
  admin: boolean;
  onChanged: () => void;
}) => {
  const core = useCore();
  const { busy, failure, run } = useCoreAction();
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
  return (
    <section
      aria-label={lesson.instruction}
      className="flex flex-col gap-5 rounded-lg border p-4"
    >
      <div className="flex flex-col gap-1.5">
        <span className="text-sm">{lesson.instruction}</span>
        <LessonBadges lesson={lesson} />
      </div>
      <ol className="flex flex-col gap-4">
        {versions.map((version) => (
          <li
            className="flex flex-col gap-1 border-l pl-3"
            key={version.revision}
          >
            <span className="text-xs font-medium">
              {version.supersedes === null ? (
                <Trans>Revision {version.revision}</Trans>
              ) : (
                <Trans>
                  Revision {version.revision}, after revision{" "}
                  {version.supersedes}
                </Trans>
              )}
              {" · "}
              {formatDateTime(version.createdAt)}
            </span>
            {version.instruction === null ? (
              <span className="text-muted-foreground text-xs">
                <Trans>It rests on turns you were not part of.</Trans>
              </span>
            ) : (
              <span className="text-sm">{version.instruction}</span>
            )}
            {version.wording === null ? null : (
              <span className="text-muted-foreground text-sm">
                <Trans>Written by a model: {version.wording}</Trans>
              </span>
            )}
            <ul className="text-muted-foreground flex flex-col gap-0.5 text-xs">
              {version.episodes.map((episode) => (
                <li key={episode.episodeId}>
                  {episode.role === "supporting" ? (
                    <Trans>Failed: {episode.taskType}</Trans>
                  ) : (
                    <Trans>Completed: {episode.taskType}</Trans>
                  )}
                  {" · "}
                  {formatDateTime(episode.occurredAt)}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
      {/* A person's own lesson is theirs to retire; a shared chat's, an
          admin's among the people who may see it (core decides). */}
      {lesson.state === "candidate" && (lesson.scope === "person" || admin) ? (
        <div className="flex flex-col gap-2">
          <div>
            <Button
              disabled={busy}
              onClick={() => {
                void (async () => {
                  const retired = await run(async (session) => {
                    await session.knowledge.lessonsRetire({
                      lessonId: lesson.id,
                      expectedRevision: lesson.revision,
                    });
                    return true;
                  });
                  // Read again only once retired: a refusal stays on screen.
                  if (retired === true) {
                    onChanged();
                  }
                })();
              }}
              variant="outline"
            >
              <Trans>Retire this lesson</Trans>
            </Button>
          </div>
          {failure === undefined ? null : <ErrorText>{failure}</ErrorText>}
        </div>
      ) : null}
    </section>
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
  return (
    <div className="flex flex-col gap-1">
      {listed.state === "refused" ? (
        <ErrorText>{listed.message}</ErrorText>
      ) : null}
      {listed.state === "ready" && listed.data.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>
              <Trans>No lessons yet</Trans>
            </EmptyTitle>
            <EmptyDescription>
              <Trans>
                When a task keeps failing the same way, the Brain notes it here
                as a lesson you can check.
              </Trans>
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {listed.state === "ready"
        ? listed.data.map((lesson) => (
            <button
              aria-pressed={picked === lesson.id}
              className="hover:bg-accent aria-pressed:bg-accent flex w-full flex-col items-start gap-1.5 rounded-md px-3 py-2 text-left"
              key={lesson.id}
              onClick={() => {
                onPick(lesson.id);
              }}
              type="button"
            >
              <span className="text-sm">{lesson.instruction}</span>
              <LessonBadges lesson={lesson} />
            </button>
          ))
        : null}
    </div>
  );
};

/** The lessons the person may see, and the one in hand. */
export const LessonsView = ({ admin }: { admin: boolean }) => {
  const [picked, setPicked] = useState<string>();
  const [changes, setChanges] = useState(0);
  return (
    <div className="grid min-h-0 gap-6 lg:grid-cols-2">
      <LessonList key={changes} onPick={setPicked} picked={picked} />
      {picked === undefined ? null : (
        <LessonPanel
          key={`${picked}:${changes}`}
          admin={admin}
          lessonId={picked}
          onChanged={() => {
            setChanges((count) => count + 1);
          }}
        />
      )}
    </div>
  );
};
