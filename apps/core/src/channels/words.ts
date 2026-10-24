import { interviewLocales } from "@grasp-os/shared/onboarding";
import type { InterviewLocale } from "@grasp-os/shared/onboarding";

// What Stephen says in a chat app, written once for every platform: his
// lines in each language Grasp speaks, as plain records like the
// interviewer's (src/onboarding/interviewer-text.ts), not Lingui, which is
// the web's. Each line is a whole sentence or more in every language, with
// the same form of address the interviews use (stephen.ts): "je" in Dutch,
// "Sie" in German, "vous" in French, "tú" in Spanish. A line may leave room
// for a value (`{count}`); `say` fills it, and the types make every caller
// give each value its line names. The cards (cards.tsx) put the lines on
// what each platform shows.

/** The languages Stephen speaks in a chat: the ones the frontend speaks. */
export const channelLocales = interviewLocales;
export type ChannelLocale = InterviewLocale;

/** One line, in each language. */
type Line = Readonly<Record<ChannelLocale, string>>;

const lines = {
  /** When someone first opens a chat with him. */
  welcome: {
    en: "Hi! I'm here to help with your work. Ask me anything, and I'll answer from what your company shared with Grasp. I never change anything until you confirm it on a card.",
    nl: "Hoi! Ik help je met je werk. Vraag me wat je wilt, dan antwoord ik vanuit wat je bedrijf met Grasp heeft gedeeld. Ik verander nooit iets voordat je het op een kaart bevestigt.",
    de: "Hallo! Ich helfe Ihnen bei Ihrer Arbeit. Fragen Sie mich, was Sie möchten, und ich antworte aus dem, was Ihr Unternehmen mit Grasp geteilt hat. Ich ändere nie etwas, bevor Sie es auf einer Karte bestätigen.",
    fr: "Bonjour ! Je suis là pour vous aider dans votre travail. Posez-moi vos questions, et je réponds à partir de ce que votre entreprise a partagé avec Grasp. Je ne modifie jamais rien avant que vous l’ayez confirmé sur une carte.",
    es: "¡Hola! Estoy aquí para ayudarte con tu trabajo. Pregúntame lo que quieras y te responderé a partir de lo que tu empresa ha compartido con Grasp. Nunca cambio nada hasta que lo confirmes en una tarjeta.",
  },

  // Who may not talk to him: each gets one line, and nothing they sent is
  // read.

  /** A group chat or a channel: he answers one person at a time. */
  privateOnly: {
    en: "I only answer in a private chat. Send me a direct message, and I'll help you there.",
    nl: "Ik antwoord alleen in een privéchat. Stuur me een direct bericht, dan help ik je daar.",
    de: "Ich antworte nur im privaten Chat. Schreiben Sie mir eine Direktnachricht, dann helfe ich Ihnen dort.",
    fr: "Je ne réponds que dans une conversation privée. Envoyez-moi un message direct, et je vous aiderai là-bas.",
    es: "Solo respondo en un chat privado. Envíame un mensaje directo y te ayudaré allí.",
  },
  /** Someone from another company. */
  otherCompany: {
    en: "I only work for the people of the company that set me up, so I can't help you here.",
    nl: "Ik werk alleen voor de mensen van het bedrijf dat mij heeft ingesteld, dus hier kan ik je niet helpen.",
    de: "Ich arbeite nur für die Menschen des Unternehmens, das mich eingerichtet hat, deshalb kann ich Ihnen hier nicht helfen.",
    fr: "Je travaille uniquement pour les personnes de l’entreprise qui m’a mis en place, je ne peux donc pas vous aider ici.",
    es: "Solo trabajo para las personas de la empresa que me configuró, así que aquí no puedo ayudarte.",
  },
  /** A guest in the company's own tenant. */
  guest: {
    en: "I only help the company's own people, not its guests, so I can't help you here.",
    nl: "Ik help alleen de eigen mensen van het bedrijf, geen gasten, dus hier kan ik je niet helpen.",
    de: "Ich helfe nur den eigenen Leuten des Unternehmens, nicht seinen Gästen, deshalb kann ich Ihnen hier nicht helfen.",
    fr: "J’aide uniquement les personnes de l’entreprise, pas ses invités, je ne peux donc pas vous aider ici.",
    es: "Solo ayudo a las personas de la propia empresa, no a sus invitados, así que aquí no puedo ayudarte.",
  },
  /** Someone who was a member and no longer is. */
  removed: {
    en: "You no longer have access to Grasp, so I can't help you. If you think that's a mistake, ask your admin.",
    nl: "Je hebt geen toegang meer tot Grasp, dus ik kan je niet helpen. Denk je dat dit niet klopt, vraag het dan aan je beheerder.",
    de: "Sie haben keinen Zugang mehr zu Grasp, deshalb kann ich Ihnen nicht helfen. Wenn Sie das für einen Fehler halten, wenden Sie sich an Ihren Admin.",
    fr: "Vous n’avez plus accès à Grasp, je ne peux donc pas vous aider. Si vous pensez que c’est une erreur, contactez votre administrateur.",
    es: "Ya no tienes acceso a Grasp, así que no puedo ayudarte. Si crees que es un error, pregunta a tu administrador.",
  },
  /** A member Settings › Stephen doesn't let use him. */
  notTurnedOn: {
    en: "Your company hasn't turned me on for you yet. If you'd like to use me, ask your admin.",
    nl: "Je bedrijf heeft mij nog niet voor je aangezet. Wil je mij gebruiken, vraag het dan aan je beheerder.",
    de: "Ihr Unternehmen hat mich für Sie noch nicht freigeschaltet. Wenn Sie mich nutzen möchten, wenden Sie sich an Ihren Admin.",
    fr: "Votre entreprise ne m’a pas encore activé pour vous. Si vous souhaitez m’utiliser, contactez votre administrateur.",
    es: "Tu empresa todavía no me ha activado para ti. Si quieres usarme, pregunta a tu administrador.",
  },
  /** Someone Grasp hasn't seen yet, above the sign-in button. */
  signIn: {
    en: "I don't know you yet. Sign in to Grasp once with your work account, and I'll answer you right after.",
    nl: "Ik ken je nog niet. Log één keer in bij Grasp met je werkaccount, dan antwoord ik je meteen daarna.",
    de: "Ich kenne Sie noch nicht. Melden Sie sich einmal mit Ihrem Arbeitskonto bei Grasp an, dann antworte ich Ihnen gleich danach.",
    fr: "Je ne vous connais pas encore. Connectez-vous une fois à Grasp avec votre compte professionnel, et je vous répondrai juste après.",
    es: "Todavía no te conozco. Inicia sesión una vez en Grasp con tu cuenta del trabajo y te responderé justo después.",
  },
  signInButton: {
    en: "Sign in",
    nl: "Inloggen",
    de: "Anmelden",
    fr: "Se connecter",
    es: "Iniciar sesión",
  },

  // A workflow step that waits for the person, told in their chat
  // (reach.ts): where to go, and nothing of what it is about.
  decisionWaiting: {
    en: "A workflow is waiting for your decision. Decide in Grasp: {link}",
    nl: "Een workflow wacht op jouw beslissing. Beslis in Grasp: {link}",
    de: "Ein Workflow wartet auf Ihre Entscheidung. Entscheiden Sie in Grasp: {link}",
    fr: "Un workflow attend votre décision. Décidez dans Grasp : {link}",
    es: "Un flujo de trabajo espera tu decisión. Decide en Grasp: {link}",
  },

  // A turn that can't be answered.

  /** Over the per-person limit on incoming messages. */
  tooFast: {
    en: "You've sent me a lot of messages in a short time. Wait a moment, then ask me again.",
    nl: "Je hebt me in korte tijd veel berichten gestuurd. Wacht even en vraag het me dan opnieuw.",
    de: "Sie haben mir in kurzer Zeit viele Nachrichten geschickt. Warten Sie einen Moment und fragen Sie mich dann noch einmal.",
    fr: "Vous m’avez envoyé beaucoup de messages en peu de temps. Attendez un instant, puis posez-moi à nouveau votre question.",
    es: "Me has enviado muchos mensajes en poco tiempo. Espera un momento y vuelve a preguntarme.",
  },
  /** Over the limit the company's admin set for this person. */
  personLimit: {
    en: "You've reached the limit your company set for you. If you need more, ask your admin.",
    nl: "Je hebt de limiet bereikt die je bedrijf voor je heeft ingesteld. Heb je meer nodig, vraag het dan aan je beheerder.",
    de: "Sie haben das Limit erreicht, das Ihr Unternehmen für Sie festgelegt hat. Wenn Sie mehr brauchen, wenden Sie sich an Ihren Admin.",
    fr: "Vous avez atteint la limite que votre entreprise a fixée pour vous. Si vous avez besoin de plus, contactez votre administrateur.",
    es: "Has alcanzado el límite que tu empresa ha fijado para ti. Si necesitas más, pregunta a tu administrador.",
  },
  /** The company's model budget is spent. */
  budget: {
    en: "Your company has used up its AI budget for now, so I can't answer. Ask your admin, or try again later.",
    nl: "Je bedrijf heeft zijn AI-budget voorlopig opgebruikt, dus ik kan niet antwoorden. Vraag het aan je beheerder of probeer het later opnieuw.",
    de: "Ihr Unternehmen hat sein KI-Budget vorerst aufgebraucht, deshalb kann ich nicht antworten. Wenden Sie sich an Ihren Admin oder versuchen Sie es später noch einmal.",
    fr: "Votre entreprise a épuisé son budget d’IA pour le moment, je ne peux donc pas répondre. Contactez votre administrateur ou réessayez plus tard.",
    es: "Tu empresa ha agotado su presupuesto de IA por ahora, así que no puedo responder. Pregunta a tu administrador o vuelve a intentarlo más tarde.",
  },
  /** The model is busy or unavailable. */
  busy: {
    en: "The AI model is busy right now. Try again in a minute.",
    nl: "Het AI-model is nu even druk. Probeer het over een minuut opnieuw.",
    de: "Das KI-Modell ist gerade ausgelastet. Versuchen Sie es in einer Minute noch einmal.",
    fr: "Le modèle d’IA est occupé pour le moment. Réessayez dans une minute.",
    es: "El modelo de IA está ocupado ahora mismo. Vuelve a intentarlo en un minuto.",
  },
  /** Any other turn that failed. */
  failed: {
    en: "Something went wrong, and I couldn't answer. Try again in a moment.",
    nl: "Er ging iets mis en ik kon niet antwoorden. Probeer het zo opnieuw.",
    de: "Etwas ist schiefgegangen, und ich konnte nicht antworten. Versuchen Sie es gleich noch einmal.",
    fr: "Un problème est survenu et je n’ai pas pu répondre. Réessayez dans un instant.",
    es: "Algo ha fallado y no he podido responder. Vuelve a intentarlo en un momento.",
  },
  /** A message with no text in it: a picture, a file, a sticker. */
  textOnly: {
    en: "I can only read text for now. Type your question, and I'll answer it.",
    nl: "Ik kan voorlopig alleen tekst lezen. Typ je vraag, dan beantwoord ik hem.",
    de: "Ich kann vorerst nur Text lesen. Tippen Sie Ihre Frage, dann beantworte ich sie.",
    fr: "Pour l’instant, je ne lis que du texte. Écrivez votre question, et j’y répondrai.",
    es: "Por ahora solo puedo leer texto. Escribe tu pregunta y la responderé.",
  },

  // An answer.

  /** The heading over an answer's numbered sources. */
  sources: {
    en: "Sources",
    nl: "Bronnen",
    de: "Quellen",
    fr: "Sources",
    es: "Fuentes",
  },
  /** An answer cut to fit the platform. */
  answerTooLong: {
    en: "This answer is too long for this chat. Open it in Grasp to read all of it.",
    nl: "Dit antwoord is te lang voor deze chat. Open het in Grasp om alles te lezen.",
    de: "Diese Antwort ist zu lang für diesen Chat. Öffnen Sie sie in Grasp, um alles zu lesen.",
    fr: "Cette réponse est trop longue pour cette conversation. Ouvrez-la dans Grasp pour la lire en entier.",
    es: "Esta respuesta es demasiado larga para este chat. Ábrela en Grasp para leerla entera.",
  },
  openInGrasp: {
    en: "Open in Grasp",
    nl: "Openen in Grasp",
    de: "In Grasp öffnen",
    fr: "Ouvrir dans Grasp",
    es: "Abrir en Grasp",
  },

  // A card of held writes: what would change, before anything does.

  heldOne: {
    en: "I'd like to make this change. Nothing happens until you confirm it.",
    nl: "Ik wil deze wijziging doorvoeren. Er gebeurt niets voordat je hem bevestigt.",
    de: "Ich möchte diese Änderung vornehmen. Es passiert nichts, bevor Sie sie bestätigen.",
    fr: "Je souhaite effectuer cette modification. Rien ne se passe tant que vous ne l’avez pas confirmée.",
    es: "Me gustaría hacer este cambio. No pasa nada hasta que lo confirmes.",
  },
  /** Two or more; one is `heldOne`. */
  heldMany: {
    en: "I'd like to make these {count} changes, in this order. Nothing happens until you confirm them.",
    nl: "Ik wil deze {count} wijzigingen doorvoeren, in deze volgorde. Er gebeurt niets voordat je ze bevestigt.",
    de: "Ich möchte diese {count} Änderungen in dieser Reihenfolge vornehmen. Es passiert nichts, bevor Sie sie bestätigen.",
    fr: "Je souhaite effectuer ces {count} modifications, dans cet ordre. Rien ne se passe tant que vous ne les avez pas confirmées.",
    es: "Me gustaría hacer estos {count} cambios, en este orden. No pasa nada hasta que los confirmes.",
  },
  /** The turn read mail other people wrote. */
  checkMail: {
    en: "To prepare this, I read mail that other people wrote. Check every value before you confirm.",
    nl: "Om dit voor te bereiden, heb ik mail gelezen die andere mensen schreven. Controleer elke waarde voordat je bevestigt.",
    de: "Um das vorzubereiten, habe ich E-Mails gelesen, die andere geschrieben haben. Prüfen Sie jeden Wert, bevor Sie bestätigen.",
    fr: "Pour préparer cela, j’ai lu des e-mails écrits par d’autres personnes. Vérifiez chaque valeur avant de confirmer.",
    es: "Para preparar esto, he leído correos que escribieron otras personas. Revisa cada valor antes de confirmar.",
  },
  /** The turn read a company record others can change, named by `where`. */
  checkRecord: {
    en: "To prepare this, I read {where}, where other people can make changes too. Check every value before you confirm.",
    nl: "Om dit voor te bereiden, heb ik {where} gelezen, waarin ook anderen wijzigingen kunnen maken. Controleer elke waarde voordat je bevestigt.",
    de: "Um das vorzubereiten, habe ich {where} gelesen, wo auch andere Änderungen vornehmen können. Prüfen Sie jeden Wert, bevor Sie bestätigen.",
    fr: "Pour préparer cela, j’ai lu {where}, où d’autres personnes peuvent aussi faire des modifications. Vérifiez chaque valeur avant de confirmer.",
    es: "Para preparar esto, he leído {where}, donde otras personas también pueden hacer cambios. Revisa cada valor antes de confirmar.",
  },
  /** What would change doesn't fit the card: it is confirmed in Grasp. */
  cardTooLong: {
    en: "This card can't show everything that would change. Open it in Grasp to see every value and confirm it there.",
    nl: "Deze kaart kan niet alles laten zien wat er zou veranderen. Open hem in Grasp om elke waarde te zien en bevestig het daar.",
    de: "Diese Karte kann nicht alles zeigen, was sich ändern würde. Öffnen Sie sie in Grasp, um jeden Wert zu sehen, und bestätigen Sie dort.",
    fr: "Cette carte ne peut pas montrer tout ce qui changerait. Ouvrez-la dans Grasp pour voir chaque valeur et confirmez là-bas.",
    es: "Esta tarjeta no puede mostrar todo lo que cambiaría. Ábrela en Grasp para ver cada valor y confírmalo allí.",
  },
  confirm: {
    en: "Confirm",
    nl: "Bevestigen",
    de: "Bestätigen",
    fr: "Confirmer",
    es: "Confirmar",
  },
  cancel: {
    en: "Cancel",
    nl: "Annuleren",
    de: "Abbrechen",
    fr: "Annuler",
    es: "Cancelar",
  },

  // Each change on the card as it runs, the card edited in place.

  stepRunning: {
    en: "Working on it…",
    nl: "Hier ben ik mee bezig…",
    de: "Ich arbeite daran…",
    fr: "J’y travaille…",
    es: "Estoy en ello…",
  },
  stepDone: {
    en: "Done.",
    nl: "Klaar.",
    de: "Erledigt.",
    fr: "Fait.",
    es: "Hecho.",
  },
  stepFailed: {
    en: "This didn't work.",
    nl: "Dit is niet gelukt.",
    de: "Das hat nicht geklappt.",
    fr: "Cela n’a pas fonctionné.",
    es: "Esto no ha funcionado.",
  },
  stepUnknown: {
    en: "I can't tell whether this went through.",
    nl: "Ik weet niet zeker of dit is gelukt.",
    de: "Ich kann nicht sagen, ob das durchgegangen ist.",
    fr: "Je ne sais pas si cela a abouti.",
    es: "No sé si esto se ha completado.",
  },
  stepSkipped: {
    en: "Not done, because an earlier change didn't work.",
    nl: "Niet gedaan, omdat een eerdere wijziging niet lukte.",
    de: "Nicht ausgeführt, weil eine frühere Änderung nicht geklappt hat.",
    fr: "Non effectué, car une modification précédente n’a pas fonctionné.",
    es: "No se ha hecho, porque un cambio anterior no ha funcionado.",
  },

  // How a press ended: one line at the foot of the card.

  allDone: {
    en: "Done. Everything on this card has been changed.",
    nl: "Klaar. Alles op deze kaart is gewijzigd.",
    de: "Erledigt. Alles auf dieser Karte wurde geändert.",
    fr: "C’est fait. Tout ce qui figure sur cette carte a été modifié.",
    es: "Hecho. Todo lo que aparece en esta tarjeta se ha cambiado.",
  },
  cancelled: {
    en: "Cancelled. Nothing was changed.",
    nl: "Geannuleerd. Er is niets gewijzigd.",
    de: "Abgebrochen. Es wurde nichts geändert.",
    fr: "Annulé. Rien n’a été modifié.",
    es: "Cancelado. No se ha cambiado nada.",
  },
  stopped: {
    en: "One change didn't work, so I stopped there. Nothing after it was changed.",
    nl: "Eén wijziging lukte niet, dus daar ben ik gestopt. Niets daarna is gewijzigd.",
    de: "Eine Änderung hat nicht geklappt, deshalb habe ich dort aufgehört. Danach wurde nichts mehr geändert.",
    fr: "Une modification n’a pas fonctionné, je me suis donc arrêté là. Rien n’a été modifié après elle.",
    es: "Un cambio no ha funcionado, así que me he detenido ahí. No se ha cambiado nada después.",
  },
  unknownOutcome: {
    en: "I can't tell whether one change went through. Check it in Grasp before you try again.",
    nl: "Ik weet niet zeker of één wijziging is gelukt. Controleer het in Grasp voordat je het opnieuw probeert.",
    de: "Ich kann nicht sagen, ob eine Änderung durchgegangen ist. Prüfen Sie es in Grasp, bevor Sie es noch einmal versuchen.",
    fr: "Je ne sais pas si une modification a abouti. Vérifiez-la dans Grasp avant de réessayer.",
    es: "No sé si un cambio se ha completado. Compruébalo en Grasp antes de volver a intentarlo.",
  },
  expired: {
    en: "This card expired at the end of the day, and nothing was changed. Ask me again if you still want it.",
    nl: "Deze kaart is aan het eind van de dag verlopen en er is niets gewijzigd. Vraag het me opnieuw als je het nog wilt.",
    de: "Diese Karte ist am Ende des Tages abgelaufen, und es wurde nichts geändert. Fragen Sie mich noch einmal, wenn Sie es weiterhin möchten.",
    fr: "Cette carte a expiré à la fin de la journée, et rien n’a été modifié. Redemandez-moi si vous le souhaitez toujours.",
    es: "Esta tarjeta caducó al final del día y no se ha cambiado nada. Vuelve a pedírmelo si todavía lo quieres.",
  },
  notYours: {
    en: "Only the person this card was made for can confirm it.",
    nl: "Alleen de persoon voor wie deze kaart is gemaakt, kan hem bevestigen.",
    de: "Nur die Person, für die diese Karte erstellt wurde, kann sie bestätigen.",
    fr: "Seule la personne pour qui cette carte a été créée peut la confirmer.",
    es: "Solo la persona para la que se creó esta tarjeta puede confirmarla.",
  },
  alreadyAnswered: {
    en: "This card has already been answered.",
    nl: "Deze kaart is al beantwoord.",
    de: "Diese Karte wurde bereits beantwortet.",
    fr: "Cette carte a déjà reçu une réponse.",
    es: "Esta tarjeta ya se ha respondido.",
  },
  changedSince: {
    en: "Something on this card changed after I showed it, so I changed nothing. Ask me again for a new card.",
    nl: "Er is iets op deze kaart veranderd nadat ik hem liet zien, dus ik heb niets gewijzigd. Vraag het me opnieuw voor een nieuwe kaart.",
    de: "Auf dieser Karte hat sich etwas geändert, nachdem ich sie gezeigt habe, deshalb habe ich nichts geändert. Fragen Sie mich noch einmal nach einer neuen Karte.",
    fr: "Quelque chose sur cette carte a changé après que je l’ai montrée, je n’ai donc rien modifié. Redemandez-moi pour obtenir une nouvelle carte.",
    es: "Algo de esta tarjeta cambió después de que te la mostrara, así que no he cambiado nada. Vuelve a pedírmelo para recibir una tarjeta nueva.",
  },
} as const satisfies Record<string, Line>;

export type LineName = keyof typeof lines;

const isLineName = (name: string): name is LineName =>
  Object.hasOwn(lines, name);

/** Every line, by name, for the tests that read them all. */
export const lineNames: readonly LineName[] =
  Object.keys(lines).filter(isLineName);

/** The names a text leaves room for: `{count}` in it is `count`. */
type HolesOf<Text extends string> =
  Text extends `${string}{${infer Hole}}${infer Rest}`
    ? Hole | HolesOf<Rest>
    : never;

/** What a line needs filled in: the values its English names. */
export type ValuesOf<Name extends LineName> = Record<
  HolesOf<(typeof lines)[Name]["en"]>,
  string | number
>;

/** A line's room for a value: `{name}`. */
const hole = /\{(?<key>\w+)\}/gu;

/** The names a line leaves room for, in one language, in order. */
export const holesIn = (name: LineName, locale: ChannelLocale): string[] =>
  Array.from(
    lines[name][locale].matchAll(hole),
    (match) => match.groups?.key ?? ""
  );

/**
 * A line in one language, its room filled with `values`, for a caller that
 * holds a line only by its name (the tests of every line); `say` is the
 * same with the values each line needs checked by its types. A value is
 * put in as it is, never read for a hole of its own; a hole without one
 * is refused, so no placeholder is ever said out loud.
 */
export const fill = (
  name: LineName,
  locale: ChannelLocale,
  values: Readonly<Record<string, string | number>>
): string =>
  lines[name][locale].replaceAll(hole, (_whole, key: string) => {
    const value = Object.hasOwn(values, key) ? values[key] : undefined;
    if (value === undefined) {
      throw new Error(`Line ${name} (${locale}) has no value for {${key}}`);
    }
    return String(value);
  });

/** A line in one language, its room filled with the values it names. */
export const say = <Name extends LineName>(
  name: Name,
  locale: ChannelLocale,
  ...[values]: HolesOf<(typeof lines)[Name]["en"]> extends never
    ? []
    : [ValuesOf<Name>]
): string => fill(name, locale, values ?? {});

// The language a message is in, from its own words: Stephen answers in
// the language he is spoken to, whatever the person's Grasp is set to.
// A chat message is short ("Wat staat er morgen in mijn agenda?"), so
// this counts small words that belong to one language alone, and letters
// only one of them writes. Words two languages share ("de", "en", "je",
// "die", "was", "la", "morgen") count for neither. English words people
// borrow into the others ("ok", "thanks", "sorry", "meeting") count for
// none, nor do names of systems ("Excel", "SharePoint"): a Dutch question
// about an Excel sheet is Dutch. When nothing tells, or two languages tie,
// the language stays what it was (`fallback`).

/** Small words only one language uses, written as people type them. */
const words: Record<ChannelLocale, ReadonlySet<string>> = {
  en: new Set([
    "the",
    "and",
    "what",
    "what's",
    "which",
    "who",
    "where",
    "when",
    "how",
    "my",
    "you",
    "your",
    "can",
    "could",
    "would",
    "please",
    "for",
    "with",
    "this",
    "that",
    "from",
    "have",
    "has",
    "do",
    "does",
    "tomorrow",
    "today",
    "about",
    "i",
    "i'm",
    "it's",
    "to",
    "of",
    "at",
    "it",
    "be",
    "will",
    "next",
    "send",
    "are",
    "there",
    "any",
    "did",
    "should",
    "find",
    "show",
  ]),
  nl: new Set([
    "het",
    "een",
    "van",
    "ik",
    "jij",
    "jouw",
    "mijn",
    "wat",
    "waar",
    "wanneer",
    "hoe",
    "kun",
    "kan",
    "kunt",
    "wil",
    "vandaag",
    "voor",
    "met",
    "naar",
    "niet",
    "ook",
    "zijn",
    "heb",
    "heeft",
    "deze",
    "dit",
    "dat",
    "op",
    "om",
    "bij",
    "uit",
    "maar",
    "nog",
    "graag",
    "alsjeblieft",
    "volgende",
    "vergadering",
    "welke",
    "staat",
    "mij",
    "zou",
    "moet",
    "stuur",
    "laat",
    "zien",
    "afspraak",
  ]),
  de: new Set([
    "der",
    "das",
    "und",
    "ist",
    "sind",
    "ich",
    "sie",
    "mein",
    "meine",
    "meinem",
    "meinen",
    "meiner",
    "wer",
    "wo",
    "wann",
    "kannst",
    "können",
    "könnten",
    "bitte",
    "für",
    "mit",
    "nach",
    "nicht",
    "auch",
    "ein",
    "eine",
    "einen",
    "heute",
    "nächste",
    "nächsten",
    "woche",
    "termin",
    "besprechung",
    "im",
    "dem",
    "den",
    "zu",
    "auf",
    "von",
    "bei",
    "aus",
    "aber",
    "noch",
    "gern",
    "gerne",
    "welche",
    "steht",
    "mir",
    "mich",
    "haben",
    "habe",
    "hat",
    "schick",
    "schicken",
    "senden",
    "zeig",
    "zeigen",
    "danke",
    "geht",
    "dir",
  ]),
  fr: new Set([
    "les",
    "des",
    "une",
    "et",
    "est",
    "sont",
    "j",
    "vous",
    // Not "mon", which is English for Monday too ("Meeting Mon 3pm").
    "ma",
    "votre",
    "vos",
    "quoi",
    "qui",
    "où",
    "quand",
    "comment",
    "pouvez",
    "peux",
    "peut",
    "voudrais",
    "demain",
    "aujourd",
    "hui",
    "pour",
    "avec",
    "dans",
    "pas",
    "ne",
    "aussi",
    "ce",
    "cette",
    "ces",
    "sur",
    "chez",
    "mais",
    "encore",
    "merci",
    "semaine",
    "prochaine",
    "quel",
    "quelle",
    "quels",
    "quelles",
    // Not "ai", English for AI too: "j'ai" counts by its "j".
    "avez",
    "avons",
    "qu",
    "envoie",
    "envoyez",
    "montre",
    "montrez",
  ]),
  es: new Set([
    "el",
    "los",
    "las",
    "una",
    "y",
    // Not "es", which is German too ("Wie geht es dir?").
    "está",
    "esta",
    "están",
    "yo",
    "tú",
    "mi",
    "mis",
    "qué",
    "quién",
    "dónde",
    "donde",
    "cuándo",
    "cuando",
    "cómo",
    "como",
    "puedes",
    "puede",
    "podrías",
    "quiero",
    "mañana",
    "manana",
    "hoy",
    "para",
    "con",
    "por",
    "también",
    "este",
    "estos",
    "sobre",
    "pero",
    "todavía",
    "gracias",
    "semana",
    "próxima",
    "cuál",
    "tengo",
    "tienes",
    "tiene",
    "hay",
    "del",
    "al",
    "lo",
    "envía",
    "envíame",
    "muéstrame",
    "correo",
    "favor",
    "reunión",
  ]),
};

/**
 * Letters only one of the languages writes. They only settle a tie between
 * languages the words already point to: names carry them too ("Jörg
 * Müller", "Dijkstra") and must not turn an English message German.
 */
const letters: Partial<Record<ChannelLocale, RegExp>> = {
  de: /[ßäöü]/gu,
  es: /[ñ¿¡]/gu,
  fr: /[çœèêàâîôûù]/gu,
  nl: /ij/gu,
};

/** A word: letters, and an apostrophe inside it ("what's", "it's"). */
const word = /\p{L}+(?:['’]\p{L}+)*/gu;

/**
 * The language of a message, from its own words, or `fallback` when its
 * words don't tell (a "👍", an "ok", a name) or two languages tie.
 */
export const languageOf = (
  text: string,
  fallback: ChannelLocale = "en"
): ChannelLocale => {
  const lower = text.toLowerCase();
  const scores = new Map<ChannelLocale, number>(
    channelLocales.map((locale) => [locale, 0])
  );
  const count = (locale: ChannelLocale, by: number): void => {
    scores.set(locale, (scores.get(locale) ?? 0) + by);
  };
  for (const [whole] of lower.matchAll(word)) {
    const typed = whole.replaceAll("’", "'");
    // French elides into the next word ("j'ai", "qu'est-ce"): each part
    // is a word of its own. English keeps "what's" and "it's" whole.
    const parts = words.en.has(typed) ? [typed] : typed.split("'");
    for (const part of parts) {
      for (const locale of channelLocales) {
        if (words[locale].has(part)) {
          count(locale, 1);
        }
      }
    }
  }
  const top = Math.max(...scores.values());
  if (top === 0) {
    return fallback;
  }
  const tied = channelLocales.filter((locale) => scores.get(locale) === top);
  if (tied.length === 1) {
    return tied[0] ?? fallback;
  }
  const byLetters = tied
    .map((locale): [ChannelLocale, number] => [
      locale,
      lower.match(letters[locale] ?? /$^/u)?.length ?? 0,
    ])
    .toSorted(([, a], [, b]) => b - a);
  const [first, second] = byLetters;
  if (first === undefined || first[1] === 0 || first[1] === second?.[1]) {
    return fallback;
  }
  return first[0];
};
