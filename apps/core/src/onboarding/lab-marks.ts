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
    en: "b1f5fc8275a27977fe4d1d7cf88f58638d7be73fda956a9ced516d8ef1828f4b",
    nl: "4ba6ae52e4acc5ac0ad21fb3045258a466da4287e064d042e5c068238d79fcb0",
    de: "70f35a1939e513c3e05c7b8fbc57dd174babf0fcf3121ebe3095067821199105",
    fr: "76239731f35f5aaa160f558ef83037ad232111d4690c065011bb9982bd41cf34",
    es: "c9ed96d825db6b4086d4937f84a0927c95020c776988430b268c5f920cdc1de4",
  },
  lead: {
    en: "2ab363362ae8ec50373401069cfd49013e3001ac403a71331603a48eb470e7d5",
    nl: "fd964a8c6b5247e2c36725bcc19783902891ef4a28d814e14750e67a368f8e6b",
    de: "45c037cfc6cd723e3978b3b6b87b2173f5f4e664ed56984fae3f93b6270c9442",
    fr: "989e12a0d7e4a1550ad82ee9b6c9a64fbb4cd41ee498d8397c4b4ada3ec3d20e",
    es: "a2d9cdaa24f43eb4c513f704926976f6bfaef62730ca99e5716e1a0f32647c27",
  },
};

// The marks above as one: the first twelve hex digits of the SHA-256 of
// every mark, in the order they stand here, one to a line. A test holds it
// to the marks, so no text changes under a version's name: whoever changes
// a mark changes this.
export const marksDigest = "e8d62fbbf6a5";

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
    en: "75699dcf39796b22d43c3ba60ce60b7a09acd5cf509d38c5450e8b0356598170",
    nl: "b85b666ffa4338bb4be6be365fb19cb7dc20f7dca0d0d868f6ecc9ad68e59fb6",
    de: "858d45d00d35f03c3f69ad3f0a2629dc094f373f41d1a26132a4059ed88b1289",
    fr: "d03f55eb509803281b338a8eb65f6d09727b797850642509577c190f9e40cbda",
    es: "5f213c1e86b49919527d4c241bb62624e24cf0dabec44992383258d0be537055",
  },
  lead: {
    en: "333d7f622762885e1f1212e38ba2120560d105a49912044cff0e367733f4bdfb",
    nl: "c73fd3fbcfa22e133d8240c7e966d3a65d54f25b57e1174fa2f99f7d3b3360e7",
    de: "c8546fccb091a6fc29f471a79ca91ad2261218317cf96b5c4c3da0a5bccf866b",
    fr: "37a75b2c40beb028b71ca1bb7f657f8f694562eec06403c7b55f69512ca0b7cd",
    es: "9d1cba8086ecfd68157c704286bd81c0827a95c1351e95162d1c2818bbcae367",
  },
};

/** Every voice mark above, in the order they stand: what `voiceMarksDigest` is taken over. */
export const everyVoiceMark = (): string[] =>
  Object.values(voiceMarks).flatMap((locales) => Object.values(locales));

// The voice marks as one, as `marksDigest` is taken over the turn marks.
export const voiceMarksDigest = "ba3a1198115d";

// Which Stephen holds a voice interview: its own name, so the admin's lab
// sets voice interviews apart from turn interviews.
export const voiceVersion = `voice-${voiceMarksDigest}`;
