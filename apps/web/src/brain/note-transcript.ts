import type { Transcript, Workspace } from "@grasp-os/shared/brain";

import type { CoreConnection } from "../core-connection.ts";
import { loadFromCore } from "../load-from-core.tsx";
import type { Loaded } from "../load-from-core.tsx";

// A source's transcript, for its note's page: `brain.read` says only how
// many turns a source's transcript has (`transcriptTurns`), never the
// turns, so a page load never carries every transcript. The note's page
// reads the one it opens with `brain.transcript`, and puts it on its
// source, where the transcript viewer reads it.

/**
 * The transcript of the source `sourceId`, when `workspace` says it has
 * one: read from core, or why it wasn't. Nothing for a note that isn't a
 * source with a transcript, which is never asked about.
 */
export const loadTranscript = async (
  core: Pick<CoreConnection, "withSession">,
  workspace: Workspace | undefined,
  sourceId: string,
  left: AbortSignal
): Promise<Loaded<Transcript | null> | undefined> => {
  const source = workspace?.sources.find(({ id }) => id === sourceId);
  if ((source?.transcriptTurns ?? 0) === 0) {
    return undefined;
  }
  return await loadFromCore(
    core,
    async (session) => await session.brain.transcript(sourceId),
    left
  );
};

/** `workspace` with `transcript` on the source `sourceId`, if one was read. */
export const withTranscript = (
  workspace: Workspace,
  sourceId: string,
  transcript: Loaded<Transcript | null> | undefined
): Workspace => {
  if (transcript?.state !== "ready" || transcript.data === null) {
    return workspace;
  }
  const { data } = transcript;
  return {
    ...workspace,
    sources: workspace.sources.map((source) =>
      source.id === sourceId ? { ...source, transcript: data } : source
    ),
  };
};
