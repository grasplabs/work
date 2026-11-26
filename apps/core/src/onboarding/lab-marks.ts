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
    en: "7f1d7d0430c88c9673900ce8b272ee267f1762c4d2c0f85601777721be525486",
    nl: "a40a1589a3801560139382f64607d097180262deb8bd793253ceb7804b53ab7b",
    de: "5e42a604d0755cd34668776763d7a7507bafc2ab1e75332e16e7db0a73910ac0",
    fr: "ef02280b849fce1c95099f89967436e0e27c7eb0ae643a0f0ade6078d4cbc7b8",
    es: "739a4b5662710a2ac1b0328b739cb234e6b1e81d6c3c6c3245884d8088147b59",
  },
  lead: {
    en: "a7b3fc29df6aa73dd2ad8c915368da1bce3cfd4fdcd6160964b54a5602a802f2",
    nl: "94f105be5d83558ef3981baf633fcae2e484a8348256423e1e99377ca675428c",
    de: "50ccf3d6a616db8bde5b3c3ceba045a709e77636802d87cec4e3219e4bc82b5b",
    fr: "51b722722cc6e9a222b497b4966fcc8c15398212f5d938c9d923b1ce3402df48",
    es: "1c4c8c4054dd290cca468674aecb34e3c44bfbc00fcda6caae4fa8f186355013",
  },
};

// The marks above as one: the first twelve hex digits of the SHA-256 of
// every mark, in the order they stand here, one to a line. A test holds it
// to the marks, so no text changes under a version's name: whoever changes
// a mark changes this.
export const marksDigest = "97d081995c13";

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
    en: "c9ed2e32e821f22192aa9666d13bdf95983bb17937ca52f8622ade8017ff6826",
    nl: "d9e3fea732462fd1060792e1fb5d1ea5eb344250ca4d505cd52d731c07ed9830",
    de: "d420903dfd575f01219dd407eb886519cb59c4393f4ced6d92e83f26dcb2a685",
    fr: "cab71a6f28bd4d56501675ced00914633eb34ab948b7c022e22d948321594b23",
    es: "1c1bb3341f487708bffa5e79d0d77f9de3f062f46b61c072dd2dfdc5de568335",
  },
  lead: {
    en: "95cfcaa5587adfc50e65c59794e6c7df21112215f3a8644db66542361648451b",
    nl: "390810c186a2ba351b11bf0818e07613ae425a2b1183815500619bf636b36e82",
    de: "0d6b5c8dc71d3e5cfdda93a3c99ba17d6cae0163dcbae109ed5e528007b89a9c",
    fr: "c592de06b84b58403ce61fe8c6f2906b65df36bcd77a283556a0c0f89c00d5b8",
    es: "125879aa45ed70a965023dba234ca212214af56f0182750e898812cb8ae476bd",
  },
};

/** Every voice mark above, in the order they stand: what `voiceMarksDigest` is taken over. */
export const everyVoiceMark = (): string[] =>
  Object.values(voiceMarks).flatMap((locales) => Object.values(locales));

// The voice marks as one, as `marksDigest` is taken over the turn marks.
export const voiceMarksDigest = "b1c89bcc44f7";

// Which Stephen holds a voice interview: its own name, so the admin's lab
// sets voice interviews apart from turn interviews.
export const voiceVersion = `voice-${voiceMarksDigest}`;
