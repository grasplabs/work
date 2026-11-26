import type {
  InterviewKind,
  InterviewLocale,
} from "@grasp-os/shared/onboarding";

// The marks of the texts that hold an interview (interviewer-text.ts), one
// per kind of interview and language. These were set from core's text
// without a lab round: the interview now starts with someone's whole job
// and follows what is still open, with AI last, a change Grasp's owner
// asked for directly. The Stephen Lab has not measured this text yet, and
// its people and moments still play the script before it: measuring it
// again is the follow-up. Core speaks only a text whose mark is here, and
// a test holds it to that, so no word changes without its marks, and with
// them the version below, changing in the same pull request.
export const labMarks: Record<
  InterviewKind,
  Record<InterviewLocale, string>
> = {
  own: {
    en: "63aa6312106cc1090080a35234d0deb07a0eba465109627880acfd393ee1de45",
    nl: "cb14c90c5dcbec522643f4e50b450fc0784964f83d59ff1fa381e6bd027d246a",
    de: "18180915f2b2859d721b611148becca110bb8d4c5fc863aec68dd013e49ba674",
    fr: "c019f9b1a51d669474e97e3412b0fb215cf77eed19f9fe19a908385f04fff3a7",
    es: "5d857fc72d4c428f40939614e2a29e2274f8bc17357f43b5c62eec99503bfa10",
  },
  lead: {
    en: "97ae7589df0706778c5add869b558603f2cea6d64abb52c3185a6fdbeef78d42",
    nl: "1ed735e2658658a98710e1c1b86a902c88dc10db55b843751e2633ac096f48b1",
    de: "8556487f4c36fb0f67becac6cd41880619f3ca8a58238fa65bb1e4f6fd5727e8",
    fr: "deb51089f46037da2115c758d5daaad8eb7a370316732210130371e63423abf6",
    es: "3e8ad3819b73573ce5f866dad09880b347b478d03f2fd364ea5859e13e7aa949",
  },
};

// The marks above as one: the first twelve hex digits of the SHA-256 of
// every mark, in the order they stand here, one to a line. A test holds it
// to the marks, so no text changes under a version's name: whoever changes
// a mark changes this.
export const marksDigest = "0f8973c89526";

// Which Stephen this is, as one name for all of the marks above: an
// interview that keeps it says which texts held it, in whatever language
// it ran, and the Stephen Lab sets the interviews of one version beside
// its runs. It is the marks' digest, so a text that changes has a new
// name, and the interviews held before keep the name of the Stephen who
// held them.
export const stephenVersion = marksDigest;

/** Every mark above, in the order they stand: what `marksDigest` is taken over. */
export const everyLabMark = (): string[] =>
  Object.values(labMarks).flatMap((locales) => Object.values(locales));

// The marks of the texts that hold an interview as one live voice session
// (`voiceText` in interviewer-text.ts), kept as the turn texts' are, and
// named by their own version: a voice interview is never set beside a turn
// interview of the same name. The Stephen Lab has not measured these.
export const voiceMarks: Record<
  InterviewKind,
  Record<InterviewLocale, string>
> = {
  own: {
    en: "bad9dc04c3fe868c92892e059d9394b2c9e15ea953c7d5d637bbe1ea925a9347",
    nl: "eb58368c4e59117bea142a5e2f2dbc9534d95eba1c5e965756a55aa5ef6e9cf1",
    de: "6abed4fb7050913b1120ff3dc06d0524abacf2ec6b9532a870818baac3c00f96",
    fr: "c2b85bef5974588d99c4467668da7c34635563fc4a8b85394a296960cb35ec79",
    es: "68f92e2d060c5b2abbd3ca73cd9550ba777ef85a2d69720edc1d3c451aaaf48b",
  },
  lead: {
    en: "c67fb1b694d5653a9f64935000c564259e05264d13dfda36961f39fd0db1dd91",
    nl: "e9629b74db4aaf085b0140991cb5fb20a6b2b681c6dc3294116cb911210997b4",
    de: "ddbfff6dfbaee479786fefe0b5fe63973871f588c83e9d07f270d04ab5cdfb3a",
    fr: "a59d067041cc796ddec67a59877a42a65da36a0f8668d3a027c756c0deafcb90",
    es: "6661b60da20c6ff93dfb589a7d56793378b53a67d64c15b6b1d80f38e9a2e48f",
  },
};

/** Every voice mark above, in the order they stand: what `voiceMarksDigest` is taken over. */
export const everyVoiceMark = (): string[] =>
  Object.values(voiceMarks).flatMap((locales) => Object.values(locales));

// The voice marks as one, as `marksDigest` is taken over the turn marks.
export const voiceMarksDigest = "d2e1b8222306";

// Which Stephen holds a voice interview: its own name, so the admin's lab
// sets voice interviews apart from turn interviews.
export const voiceVersion = `voice-${voiceMarksDigest}`;
