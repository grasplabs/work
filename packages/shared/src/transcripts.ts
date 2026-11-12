// A transcript as a producer gives it, as the Brain defines it
// (@grasp-os/brain/transcript-schema): core's file extractor makes one
// from an uploaded WebVTT file.
export {
  transcriptChapterSchema,
  transcriptMaxBytes,
  transcriptMaxChapters,
  transcriptMaxTurns,
  transcriptSchema,
  transcriptTurnSchema,
} from "@grasp-os/brain/transcript-schema";
export type {
  Transcript,
  TranscriptChapter,
  TranscriptTurn,
} from "@grasp-os/brain/transcript-schema";
