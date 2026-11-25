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
    en: "4d23b10dcb6629b30f47c0d735865286f626d6db40efc1d330ebaa4d6d109cd6",
    nl: "4001d38d1047e6207b8a8cc2fe28288a2981a96b8774135797f1d31f885f344f",
    de: "e7c5f5e0fcb46b44d878793aec63701c4f2d1f07c2f2f0baf4121817a48b08b7",
    fr: "e7658c02da82d7d82c2b5887dde8f03ba9313c03a3ad7a99913c7f99bd8709fe",
    es: "ceb74d8459a128186f55e3ae38eee959899c8968eaf8e81d55c29681f4f92ff4",
  },
  lead: {
    en: "6962165e74cec77c0dfa8d9529ecfb2d5a62ea992e3463aa0561f89d398ef1bd",
    nl: "c906b9021b66161b5d9a08da3d3b887d406ca066027f8074a53f6a4172662908",
    de: "65d9692a13ae911bb1f246fc2278f4b87bc6c0839bff0ab9f48afa3c61521cc9",
    fr: "3a68d083eca76455d8e9a6b73edfb7a088d64148c90d9c28c2d982b60c6d412e",
    es: "d078ce1f12320f3d7858829918e16542aa25316fba5b8c729c764779db7ab34f",
  },
};

// The marks above as one: the first twelve hex digits of the SHA-256 of
// every mark, in the order they stand here, one to a line. A test holds it
// to the marks, so no text changes under a version's name: whoever changes
// a mark changes this.
export const marksDigest = "86f7e0ec0e09";

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
