/* oxlint-disable typescript/no-deprecated -- the breaking release's step 3: ComposerTakeover stays a wrapper over QuestionTool's buttons until step 9 removes it (handover/audit/RELEASE.md §7). */
export { Composer } from "./composer";
export type {
  ComposerActivity,
  ComposerLayoutStyle,
  ComposerProps,
  ComposerSendDetails,
} from "./composer";
export {
  COMPOSER_CLIPBOARD,
  composerPictureToken,
  composerReference,
  composerTextParts,
  composerUnreferenced,
} from "./pictures";
export type { ComposerReference } from "./pictures";
export type { ComposerAccent, ComposerEdge } from "./glow";
export { ComposerAction } from "./action";
export type {
  ComposerActionPressedVariant,
  ComposerActionProps,
} from "./action";
export { ComposerAttachment } from "./attachment";
export type {
  ComposerAttachmentProps,
  ComposerAttachmentStatus,
  ComposerAttachmentWords,
} from "./attachment";
export type { ComposerFile } from "./attachments";
export { ComposerSurface } from "./surface";
export type { ComposerSurfaceProps } from "./surface";
export { ComposerQueue } from "./queue";
export type { ComposerQueued, ComposerQueueProps } from "./queue";
export { ComposerTakeover } from "./takeover";
export type { ComposerChoice, ComposerTakeoverProps } from "./takeover";
export { ComposerModel } from "./model";
export type {
  ComposerModelMaker,
  ComposerModelOption,
  ComposerModelProps,
} from "./model";
export { ComposerReasoning } from "./reasoning";
export type {
  ComposerReasoningOption,
  ComposerReasoningProps,
} from "./reasoning";
export { ComposerAdd } from "./add";
export type { ComposerAddAction, ComposerAddProps, ComposerKind } from "./add";
export { ComposerModelEffort } from "./model-effort";
export type {
  ComposerModelEffortOption,
  ComposerModelEffortProps,
} from "./model-effort";
export type { ComposerMentionItem } from "./mention";
export { ComposerVoice, composerVoiceWords } from "./voice";
export type {
  ComposerVoicePhase,
  ComposerVoiceProblem,
  ComposerVoiceProps,
  ComposerVoiceVariant,
  ComposerVoiceWords,
  VoiceReading,
} from "./voice";
export { useComposerMicrophone } from "./microphone";
export type {
  ComposerMicrophone,
  ComposerMicrophoneStatus,
} from "./microphone";
export { ComposerAgent } from "./agent";
export type {
  ComposerAgentAll,
  ComposerAgentOption,
  ComposerAgentProps,
} from "./agent";
