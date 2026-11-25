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
    en: "dde21eba640bbc929bce25640cff8b7c8c6bd7db414e0882c58ce2848cc318ad",
    nl: "340011328024b7f6f55c2aa66617cb66e93a694497d55d28185844c3a3c2233f",
    de: "d971f7b29ca96360bd797f01c85397d5762de38887cf1e101832f47e32789572",
    fr: "4ca136d91dab319fdaf710bcc224bd014880a8c0bff2731a2c5c6aa177149ba3",
    es: "4910b8b55df5f335724e71db96216c78fe99d189bd00f61bce82eac07fe48e84",
  },
  lead: {
    en: "200760d265c2bcf280abd478457ea36c49532846f295dda59125614d7e86735f",
    nl: "b57c685b5ffe89f5586a71ba8f7bd014b479539ea0d1f31afff7ad00a7db95bf",
    de: "1cfa326a1129e2b18e21345bb89b492e9d59617d5ed8b33d05b994fcca5fddd3",
    fr: "be2167b95e372312456ce338cd8d08f5e1b663de68340a270b5a0a375e339a59",
    es: "e4f17ed9362162067e5d752670f2bf939466b5212a83036dd431a9d2c5cb3777",
  },
};

// The marks above as one: the first twelve hex digits of the SHA-256 of
// every mark, in the order they stand here, one to a line. A test holds it
// to the marks, so no text changes under a version's name: whoever changes
// a mark changes this.
export const marksDigest = "c10677a67f74";

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
