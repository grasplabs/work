import { absent, answer, hidden } from "./company.ts";
import type { BrainEvalQuestion, BrainEvalSource } from "./company.ts";

// Groenhaven in Dutch: the head office in Utrecht and the warehouse in
// Nieuwegein (company.ts). The largest part of the set: Dutch comes first.
// Written in Dutch, sources and questions alike; never translated.

export const nlSources: readonly BrainEvalSource[] = [
  {
    key: "nl-verlof",
    language: "nl",
    kind: "handbook",
    readers: { team: "everyone" },
    text: `Verlofregeling Groenhaven

Vakantiedagen
Bij een volledig dienstverband heb je recht op 25 vakantiedagen per jaar. Je vraagt ze minstens drie weken van tevoren aan in het HR-portaal; je leidinggevende reageert binnen vijf werkdagen. Niet opgenomen vakantiedagen vervallen zes maanden na het einde van het kalenderjaar.

Bijzonder verlof
Voor je eigen huwelijk of geregistreerd partnerschap krijg je twee dagen bijzonder verlof. Bij een verhuizing krijg je één dag per jaar. Bij het overlijden van je partner, een kind of een ouder krijg je vier dagen.

Geboorteverlof
Na de bevalling heeft de partner recht op één werkweek geboorteverlof met behoud van loon, op te nemen binnen vier weken na de geboorte.`,
  },
  {
    key: "nl-ziekte",
    language: "nl",
    kind: "handbook",
    readers: { team: "everyone" },
    text: `Ziek en weer beter

Ziek melden doe je vóór 8.30 uur telefonisch bij je leidinggevende, dus niet per mail of app. Vertel hoe je bereikbaar bent en of er werk ligt dat iemand moet overnemen.

Over je klachten praat je alleen met de bedrijfsarts, niet met je leidinggevende. Ben je langer dan twee weken ziek, dan neemt de bedrijfsarts contact met je op.

Hersteld melden doe je op de dag dat je weer begint, ook als je eerst halve dagen werkt.`,
  },
  {
    key: "nl-reiskosten",
    language: "nl",
    kind: "handbook",
    readers: { team: "everyone" },
    text: `Reiskosten en thuiswerkvergoeding

Woon-werkverkeer met eigen vervoer: je krijgt 0,23 euro per kilometer, tot maximaal 60 kilometer enkele reis. Reis je met het openbaar vervoer, dan worden de kosten volledig vergoed met de zakelijke ov-kaart.

Op een thuiswerkdag krijg je een thuiswerkvergoeding van 2,40 euro per dag in plaats van reiskosten.

Zakelijke reizen declareren gaat met declaratieformulier DEC-04, binnen dertig dagen na de reis. Voeg bij parkeerkosten altijd het bonnetje toe.`,
  },
  {
    key: "nl-thuiswerken",
    language: "nl",
    kind: "handbook",
    readers: { team: "everyone" },
    text: `Thuiswerkbeleid kantoor Utrecht

Kantoormedewerkers werken twee dagen per week op kantoor; dinsdag en donderdag zijn vaste kantoordagen, dan plannen we teamoverleg. De andere dagen mag je thuiswerken als je werk dat toelaat.

Voor een goede werkplek thuis krijg je eenmalig een werkplekbudget van 400 euro voor een bureaustoel of beeldscherm. Laptop en headset krijg je van IT.`,
  },
  {
    key: "nl-fiets",
    language: "nl",
    kind: "handbook",
    readers: { team: "everyone" },
    text: `Fietsplan

Via het fietsplan kun je eens in de drie jaar een fiets of e-bike aanschaffen van maximaal 1.500 euro. De kosten worden verrekend met je eindejaarsuitkering, waardoor je minder belasting betaalt. Aanvragen gaat via het HR-portaal onder Arbeidsvoorwaarden.`,
  },
  {
    key: "nl-eerste-werkdag",
    language: "nl",
    kind: "handbook",
    readers: { team: "everyone" },
    text: `Je eerste werkdag

Op je eerste werkdag meld je je om 9.00 uur bij de receptie in Utrecht. Daar haal je je toegangspas op en maak je kennis met je buddy, een collega die je de eerste maand wegwijs maakt.

In je eerste week volg je de veiligheidsinstructie in het magazijn in Nieuwegein, ook als je op kantoor gaat werken.`,
  },
  {
    key: "nl-magazijn",
    language: "nl",
    kind: "handbook",
    readers: { team: "everyone" },
    text: `Veiligheidsregels magazijn Nieuwegein

In de hallen zijn veiligheidsschoenen (klasse S3) en een hesje verplicht, ook voor bezoekers. Heftrucks rijden alleen bestuurders met een geldig heftruckcertificaat. De maximale snelheid van een heftruck in de hallen is 6 km per uur.

Voetgangers lopen alleen over de geel gemarkeerde looppaden. Bij een brandalarm verlaat je het gebouw via de dichtstbijzijnde nooduitgang en verzamel je op parkeerplaats P2.`,
  },
  {
    key: "nl-ophaaltijden",
    language: "nl",
    kind: "email",
    readers: { team: "planning" },
    text: `Van: Daan Bakker
Aan: team Planning
Onderwerp: Nieuwe ophaaltijd Transportbedrijf Van Dijk

Hoi allemaal,

Vanaf maandag 17 november haalt Van Dijk de zendingen voor België om 15.30 uur op in plaats van om 17.00 uur. Orders voor België moeten daarom uiterlijk om 14.00 uur gepickt en ingepakt zijn. Wil je dit doorgeven aan de avondploeg?

Groet,
Daan`,
  },
  {
    key: "nl-scanners",
    language: "nl",
    kind: "ticket",
    readers: { team: "planning" },
    text: `Ticket GH-2291 · Magazijn Nieuwegein · Opgelost

Melding: de handscanners in hal 3 verliezen steeds de wifi-verbinding, vooral bij dock 7. Orderpickers moeten hun scans opnieuw doen.

Oorzaak: het accesspoint boven dock 7 was defect. Vervangen op 6 november. Tot die tijd werkten de pickers met de reservescanners uit hal 2.`,
  },
  {
    key: "nl-planningsoverleg",
    language: "nl",
    kind: "meeting",
    readers: { team: "planning" },
    text: `Notulen planningsoverleg 4 november

Aanwezig: Eva, Daan, Lukas, Javier

1. Voorjaarspiek. We verwachten in maart en april twee keer zoveel orders tuinmeubelen als nu. We nemen vanaf week 10 extra uitzendkrachten aan, acht in Nieuwegein en vier in Duisburg.
2. Besloten: in maart en april draaien we op zaterdag een extra dienst van 7.00 tot 13.00 uur.
3. Actie Daan: het rooster voor de zaterdagdiensten staat vóór 1 februari klaar.`,
  },
  {
    key: "nl-klacht-linde",
    language: "nl",
    kind: "ticket",
    readers: { team: "sales" },
    text: `Klacht · Tuincentrum De Linde, Amersfoort

De klant ontving op 29 oktober 40 loungesets met beschadigde verpakking; bij zes sets waren de kussens nat geworden. Afgesproken: de klant houdt de sets en krijgt creditnota CN-2026-118 van 1.240 euro. De vervoerder is aansprakelijk gesteld.`,
  },
  {
    key: "nl-leaseauto",
    language: "nl",
    kind: "handbook",
    readers: { team: "everyone" },
    text: `Leaseauto en tankpas

Een leaseauto krijg je vanaf functieschaal 9, of als je per jaar meer dan 20.000 zakelijke kilometers rijdt. Je kiest uit de autolijst van Groenhaven; elektrische auto's hebben de voorkeur.

De tankpas gebruik je voor zakelijke ritten en woon-werkverkeer. Privé tanken in het buitenland met de tankpas is niet toegestaan.`,
  },
  {
    key: "nl-wachtwoorden",
    language: "nl",
    kind: "handbook",
    readers: { team: "everyone" },
    text: `Wachtwoorden en inloggen

Een wachtwoord heeft minimaal 14 tekens. Inloggen gaat altijd met tweestapsverificatie via de authenticator-app op je telefoon.

Wachtwoord vergeten of kun je niet meer inloggen? Bel de servicedesk op toestel 4400; zij zetten je account terug nadat ze je identiteit hebben gecontroleerd.`,
  },
  {
    key: "nl-levering-teak",
    language: "nl",
    kind: "email",
    readers: { owner: "daan" },
    text: `Van: Houtwerk Oost, orderafdeling
Aan: Daan Bakker
Onderwerp: Vertraging bestelling PO-77812

Beste Daan,

Door een late houtlevering komt de partij teakhouten tafels van bestelling PO-77812 twee weken later. De nieuwe leverdatum is maandag 8 december, op het magazijn in Nieuwegein.

Met vriendelijke groet,
Orderafdeling Houtwerk Oost`,
  },
  {
    key: "nl-salaris-daan",
    language: "nl",
    kind: "email",
    readers: { owner: "anna" },
    text: `Van: Anna de Wit
Aan: Anna de Wit
Onderwerp: Salarisaanpassing Daan Bakker

Notitie voor de salarisadministratie: Daan Bakker gaat per 1 januari naar schaal 7, trede 4, met een brutosalaris van € 3.980 per maand. Nog bevestigen met Eva vóór de loonrun van december.`,
  },
  {
    key: "nl-reorganisatie",
    language: "nl",
    kind: "meeting",
    readers: { team: "hr" },
    text: `Vertrouwelijk · HR-overleg 6 november

De klantenservice in Utrecht wordt per 1 april samengevoegd met de afdeling verkoop. Daarbij vier functies vervallen; we zoeken eerst passend ander werk binnen Groenhaven. Medewerkers horen het op 15 januari, na het advies van de ondernemingsraad.`,
  },
  {
    key: "nl-overname",
    language: "nl",
    kind: "meeting",
    readers: "nobody",
    text: `Concept · overname

Werktitel Project Reiger: overname van een kleine groothandel in tuingereedschap in Gent. Eerste bod 2,1 miljoen euro, afhankelijk van het boekenonderzoek.`,
  },
];

export const nlQuestions: readonly BrainEvalQuestion[] = [
  // Met de woorden van de bron.
  {
    id: "nl-vakantiedagen",
    language: "nl",
    question:
      "Hoeveel vakantiedagen heb ik per jaar bij een volledig dienstverband?",
    expects: answer("words", "nl-verlof", "25 vakantiedagen per jaar"),
  },
  {
    id: "nl-huwelijk",
    language: "nl",
    question: "Hoeveel dagen bijzonder verlof krijg ik voor mijn huwelijk?",
    expects: answer("words", "nl-verlof", "twee dagen bijzonder verlof"),
  },
  {
    id: "nl-ziek-melden",
    language: "nl",
    question: "Voor hoe laat moet ik me ziek melden?",
    expects: answer("words", "nl-ziekte", "vóór 8.30 uur telefonisch"),
  },
  {
    id: "nl-thuiswerkvergoeding",
    language: "nl",
    question: "Hoe hoog is de thuiswerkvergoeding per dag?",
    expects: answer("words", "nl-reiskosten", "2,40 euro per dag"),
  },
  {
    id: "nl-werkplekbudget",
    language: "nl",
    question: "Hoeveel is het werkplekbudget voor thuis?",
    expects: answer("words", "nl-thuiswerken", "werkplekbudget van 400 euro"),
  },
  {
    id: "nl-fietsplan",
    language: "nl",
    question: "Hoe vaak kan ik via het fietsplan een fiets aanschaffen?",
    expects: answer("words", "nl-fiets", "eens in de drie jaar"),
  },
  {
    id: "nl-buddy",
    language: "nl",
    question: "Waar meld ik me op mijn eerste werkdag?",
    expects: answer(
      "words",
      "nl-eerste-werkdag",
      "om 9.00 uur bij de receptie"
    ),
  },
  {
    id: "nl-heftruck-snelheid",
    language: "nl",
    question: "Wat is de maximale snelheid van een heftruck in de hallen?",
    expects: answer("words", "nl-magazijn", "6 km per uur"),
  },
  {
    id: "nl-brandalarm",
    language: "nl",
    question: "Waar verzamelen we bij een brandalarm?",
    expects: answer("words", "nl-magazijn", "verzamel je op parkeerplaats P2"),
  },
  {
    id: "nl-van-dijk",
    language: "nl",
    question: "Hoe laat haalt Van Dijk voortaan de zendingen voor België op?",
    expects: answer("words", "nl-ophaaltijden", "om 15.30 uur op"),
  },
  {
    id: "nl-zaterdagdienst",
    language: "nl",
    question: "In welke maanden draaien we een extra dienst op zaterdag?",
    expects: answer(
      "words",
      "nl-planningsoverleg",
      "in maart en april draaien we"
    ),
  },
  {
    id: "nl-wachtwoord-lengte",
    language: "nl",
    question: "Hoeveel tekens moet een wachtwoord minimaal hebben?",
    expects: answer("words", "nl-wachtwoorden", "minimaal 14 tekens"),
  },
  // Met andere vormen van de woorden van de bron.
  {
    id: "nl-vakantiedag-vervalt",
    language: "nl",
    question: "Wanneer vervalt een vakantiedag die ik niet heb opgenomen?",
    expects: answer(
      "forms",
      "nl-verlof",
      "zes maanden na het einde van het kalenderjaar"
    ),
  },
  {
    id: "nl-zakelijke-reis",
    language: "nl",
    question: "Hoe declareer ik een zakelijke reis?",
    expects: answer("forms", "nl-reiskosten", "binnen dertig dagen na de reis"),
  },
  {
    id: "nl-veiligheidsschoen",
    language: "nl",
    question: "Welke veiligheidsschoen moet ik in het magazijn dragen?",
    expects: answer("forms", "nl-magazijn", "veiligheidsschoenen (klasse S3)"),
  },
  {
    id: "nl-handscanner-wifi",
    language: "nl",
    question: "Waarom viel de wifi van de handscanner in hal 3 weg?",
    expects: answer(
      "forms",
      "nl-scanners",
      "het accesspoint boven dock 7 was defect"
    ),
  },
  {
    id: "nl-uitzendkracht",
    language: "nl",
    question: "Hoeveel extra uitzendkracht komt er in Nieuwegein bij?",
    expects: answer("forms", "nl-planningsoverleg", "acht in Nieuwegein"),
  },
  {
    id: "nl-ziekmelding",
    language: "nl",
    question: "Mag mijn ziekmelding per mail?",
    expects: answer("forms", "nl-ziekte", "dus niet per mail of app"),
  },
  {
    id: "nl-tankpassen",
    language: "nl",
    question:
      "Mogen tankpassen gebruikt worden om privé in het buitenland te tanken?",
    expects: answer(
      "forms",
      "nl-leaseauto",
      "Privé tanken in het buitenland met de tankpas is niet toegestaan"
    ),
  },
  // Met een code, nummer of naam.
  {
    id: "nl-gh-2291",
    language: "nl",
    question: "Is GH-2291 al opgelost?",
    expects: answer("exact", "nl-scanners", "Vervangen op 6 november"),
  },
  {
    id: "nl-dec-04",
    language: "nl",
    question: "Waarvoor is DEC-04?",
    expects: answer("exact", "nl-reiskosten", "declaratieformulier DEC-04"),
  },
  {
    id: "nl-cn-2026-118",
    language: "nl",
    question: "Hoeveel bedraagt CN-2026-118?",
    expects: answer(
      "exact",
      "nl-klacht-linde",
      "creditnota CN-2026-118 van 1.240 euro"
    ),
  },
  {
    id: "nl-toestel-4400",
    language: "nl",
    question: "Wie bereik ik op toestel 4400?",
    expects: answer(
      "exact",
      "nl-wachtwoorden",
      "Bel de servicedesk op toestel 4400"
    ),
  },
  {
    id: "nl-po-77812",
    language: "nl",
    asker: "daan",
    question: "Wanneer komt PO-77812 binnen?",
    expects: answer("exact", "nl-levering-teak", "maandag 8 december"),
  },
  // Met andere woorden.
  {
    id: "nl-trein-vergoed",
    language: "nl",
    question: "Krijg ik mijn treinkaartje naar kantoor terug?",
    expects: answer(
      "paraphrase",
      "nl-reiskosten",
      "de kosten volledig vergoed met de zakelijke ov-kaart"
    ),
  },
  {
    id: "nl-vaker-thuis",
    language: "nl",
    question: "Op welke dagen moet ik op de zaak zijn?",
    expects: answer("paraphrase", "nl-thuiswerken", "dinsdag en donderdag"),
  },
  {
    id: "nl-medische-klachten",
    language: "nl",
    question: "Met wie bespreek ik wat er medisch met me aan de hand is?",
    expects: answer(
      "paraphrase",
      "nl-ziekte",
      "Over je klachten praat je alleen met de bedrijfsarts"
    ),
  },
  {
    id: "nl-voeten-hal",
    language: "nl",
    question: "Wat moet ik aan mijn voeten als ik de hal in loop?",
    expects: answer("paraphrase", "nl-magazijn", "klasse S3"),
  },
  {
    id: "nl-auto-van-de-zaak",
    language: "nl",
    question: "Wie heeft recht op een auto van de zaak?",
    expects: answer("paraphrase", "nl-leaseauto", "vanaf functieschaal 9"),
  },
  {
    id: "nl-account-geblokkeerd",
    language: "nl",
    question: "Mijn account zit op slot, hoe kom ik er weer in?",
    expects: answer(
      "paraphrase",
      "nl-wachtwoorden",
      "zij zetten je account terug"
    ),
  },
  {
    id: "nl-kapotte-dozen",
    language: "nl",
    question: "Wat hebben we de klant met de natte kussens vergoed?",
    expects: answer(
      "paraphrase",
      "nl-klacht-linde",
      "bij zes sets waren de kussens nat geworden"
    ),
  },
  {
    id: "nl-drukke-seizoen",
    language: "nl",
    question:
      "Hoeveel tijdelijk personeel huren we in voor het drukke seizoen?",
    expects: answer("paraphrase", "nl-planningsoverleg", "vier in Duisburg"),
  },
  {
    id: "nl-nieuwe-vader",
    language: "nl",
    question: "Hoeveel vrij krijgt een kersverse vader?",
    expects: answer("paraphrase", "nl-verlof", "één werkweek geboorteverlof"),
  },
  {
    id: "nl-elektrische-fiets",
    language: "nl",
    question: "Betaalt de werkgever mee aan een e-bike?",
    expects: answer(
      "paraphrase",
      "nl-fiets",
      "verrekend met je eindejaarsuitkering"
    ),
  },
  {
    id: "nl-inwerken",
    language: "nl",
    question: "Wie helpt me de eerste maand op weg als nieuwe collega?",
    expects: answer("paraphrase", "nl-eerste-werkdag", "kennis met je buddy"),
  },
  // Antwoord nergens te vinden.
  {
    id: "nl-kerstborrel",
    language: "nl",
    question: "Wat is de dresscode voor de kerstborrel?",
    expects: absent,
  },
  {
    id: "nl-kinderopvang",
    language: "nl",
    question: "Vergoedt Groenhaven een deel van de kinderopvang?",
    expects: absent,
  },
  // Antwoord alleen in een bron die de vrager niet mag lezen.
  {
    id: "nl-salaris-daan",
    language: "nl",
    asker: "lukas",
    question: "Wat wordt het nieuwe salaris van Daan Bakker?",
    expects: hidden("nl-salaris-daan", "3.980", "schaal 7, trede 4"),
  },
  {
    id: "nl-klantenservice-samengevoegd",
    language: "nl",
    asker: "daan",
    question: "Wordt de klantenservice in Utrecht samengevoegd?",
    expects: hidden(
      "nl-reorganisatie",
      "vier functies vervallen",
      "samengevoegd met de afdeling verkoop"
    ),
  },
  {
    id: "nl-bod-gent",
    language: "nl",
    question: "Hoeveel bieden we op de groothandel in Gent?",
    expects: hidden("nl-overname", "Project Reiger", "2,1 miljoen"),
  },
];
