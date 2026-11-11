import { absent, answer, hidden } from "./company.ts";
import type { BrainEvalQuestion, BrainEvalSource } from "./company.ts";

// Groenhaven's long Dutch documents: a handbook chapter on training, the
// Nieuwegein warehouse's chapter on returns, the purchasing policy and HR's
// confidential memo on the 2027 pay round. Written in Dutch, sources and
// questions alike; never translated.

export const nlLongHandbookSources: readonly BrainEvalSource[] = [
  {
    key: "nl-handboek-opleiding",
    language: "nl",
    readers: { team: "everyone" },
    text: `Personeelshandboek Groenhaven · Hoofdstuk 6 Opleiding en ontwikkeling

Groenhaven wil dat je je vak bijhoudt en binnen het bedrijf kunt doorgroeien. In dit hoofdstuk lees je welk budget daarvoor beschikbaar is, hoe je een opleiding aanvraagt, welke trainingen verplicht zijn en hoe het ontwikkelgesprek verloopt. Het hoofdstuk geldt voor alle medewerkers in Nederland met een vast contract of een jaarcontract. Voor de vestigingen in Duisburg, Lyon en Valencia gelden eigen afspraken per land; die vind je in de bijlagen.

6.1 Persoonlijk opleidingsbudget
Iedere medewerker met een dienstverband van minimaal 24 uur per week heeft een persoonlijk opleidingsbudget van 1.200 euro per kalenderjaar. Werk je minder uren, dan krijg je naar verhouding minder. Het budget is bedoeld voor cursussen, trainingen, vakliteratuur en examengeld die je helpen in je huidige functie of bij een volgende stap binnen Groenhaven. Wat je in een jaar niet gebruikt, schuift één keer door naar het jaar erna; meer dan twee jaarbudgetten tegelijk kun je dus nooit opsparen.

6.2 Opleidingen in opdracht van je afdeling
Soms vraagt je leidinggevende je om een opleiding te volgen, omdat je functie verandert of omdat er nieuwe systemen komen. Zo'n opleiding betaalt de afdeling uit haar eigen opleidingsbudget en die telt dus niet mee voor je persoonlijke budget. Je volgt die in werktijd. Een voorbeeld: toen in het voorjaar van 2026 het nieuwe magazijnbeheersysteem werd ingevoerd, kregen alle teamleiders in Nieuwegein een tweedaagse training, betaald door de afdeling Logistiek.

6.3 Een opleiding aanvragen
Een opleiding vraag je aan met het aanvraagformulier OPL-01 in het HR-portaal, onder Ontwikkeling. Vul de naam van de opleiding, het opleidingsinstituut, de kosten en de verwachte studietijd in, en schrijf in een paar zinnen waarom de opleiding je verder helpt. Dien de aanvraag minstens zes weken voor de startdatum in, zodat er tijd is om je aanvraag te beoordelen en je in te schrijven. Je leidinggevende beslist binnen tien werkdagen. Kost een opleiding meer dan 2.500 euro of duurt ze langer dan een half jaar, dan beslist HR mee; Anna de Wit neemt die aanvragen in behandeling. Na goedkeuring schrijft HR je in en gaat de factuur rechtstreeks naar Groenhaven, zodat je zelf niets hoeft voor te schieten.

6.4 Studieverlof
Voor een opleiding die Groenhaven heeft goedgekeurd, krijg je studieverlof met behoud van loon: de examendagen zelf en daarnaast maximaal vier studiedagen per kalenderjaar om je op examens voor te bereiden. Vallen lessen onder werktijd, dan mag je ze volgen als het rooster dat toelaat; in het magazijn spreek je dat af met je planner, op kantoor met je leidinggevende. Studieverlof vraag je aan in het HR-portaal, onder het verloftype Studie. Studiedagen die je in een jaar niet opneemt, kun je niet meenemen naar het volgende jaar; ze worden ook niet uitbetaald.

6.5 Terugbetalen bij vertrek
Kost een opleiding meer dan 1.500 euro, dan teken je vooraf een studieovereenkomst. Neem je binnen twee jaar na het afronden van de opleiding zelf ontslag, dan betaal je een deel van de kosten terug: 75 procent als je binnen het eerste jaar vertrekt en 25 procent als je in het tweede jaar vertrekt. Hetzelfde geldt als je de opleiding zonder goede reden afbreekt. Je betaalt niets terug als Groenhaven het dienstverband beëindigt, als je contract niet wordt verlengd of als het om een verplichte training ging. Vakliteratuur en examengeld uit je persoonlijke budget hoef je nooit terug te betalen.

6.6 Verplichte trainingen
Sommige trainingen zijn verplicht, omdat de wet of je functie dat eist. Je volgt ze in werktijd, Groenhaven betaalt ze en ze gaan niet van je persoonlijke budget af. Iedereen volgt in de eerste maand de e-learning Informatiebeveiliging (module IB-101) en daarna elk jaar de korte herhalingsmodule. Wie in het magazijn op een heftruck of reachtruck werkt, volgt de praktijktraining bij een erkend opleider; die training en de herhalingen daarvan plant HR in overleg met de vestiging in.

6.7 Bedrijfshulpverlening
Op elke vestiging in Nederland zijn genoeg bedrijfshulpverleners nodig: in Utrecht minstens vier per werkdag, in Nieuwegein minstens één per ploeg in elke hal. Wie BHV'er wordt, volgt eerst een basiscursus van twee dagen en daarna elk jaar een herhalingstraining van een dagdeel, inclusief een ontruimingsoefening. Mis je de herhalingstraining twee jaar achter elkaar, dan moet je de basiscursus opnieuw doen. BHV'ers krijgen een toelage van 180 euro bruto per jaar, die in juni wordt uitbetaald. Wil je BHV'er worden, meld je dan bij de preventiemedewerker van je vestiging; in Nieuwegein is dat Ilse Kramer.

6.8 Het jaarlijkse ontwikkelgesprek
Eén keer per jaar heb je een ontwikkelgesprek met je leidinggevende. Dat staat los van de beoordeling en gaat niet over je salaris, maar over wat je wilt leren, wat goed gaat en waar je over twee à drie jaar wilt staan. Op kantoor worden de gesprekken in februari gevoerd. In de magazijnen gebeurt dat in september en oktober, als de voorjaarspiek en de zomerdrukte voorbij zijn. Ter voorbereiding vul je het formulier Mijn ontwikkeling (OPL-04) in, dat je leidinggevende je twee weken van tevoren stuurt. Spreek je in het gesprek een opleiding af, dan leg je die ook in dat formulier vast.

6.9 Interne doorgroei
Een vacature zetten we eerst tien werkdagen intern op het intranet, voordat we buiten Groenhaven gaan zoeken. Bij gelijke geschiktheid gaat een interne kandidaat voor. Je kunt op een interne vacature reageren als je minstens een jaar in je huidige functie zit. Daarvoor heb je geen toestemming van je leidinggevende nodig, maar we vragen je wel om het hem of haar zelf te vertellen. Voor magazijnmedewerkers die teamleider willen worden, is er het programma Doorgroeien in de logistiek (DIL). Het start elk jaar in november, met hoogstens acht deelnemers uit Nieuwegein en Duisburg; aanmelden kan tot 1 oktober bij je planner.`,
  },
  {
    key: "nl-handboek-retouren",
    language: "nl",
    readers: { team: "planning" },
    text: `Magazijnhandboek Nieuwegein · Hoofdstuk 7 Retouren en beschadigde goederen

Dit hoofdstuk beschrijft hoe het magazijn in Nieuwegein retouren en beschadigde goederen afhandelt, van de aanmelding tot de afvoer. Het geldt voor iedereen die werkt in de goederenontvangst, op de retourafdeling of in de planning. Laatst bijgewerkt in oktober 2026 door Ruud Hoogland, hoofd magazijn.

7.1 Geen retour zonder retournummer
Elke retourzending heeft een retournummer nodig. Dat begint met RMA en wordt aangemaakt door de verkoopbinnendienst in Utrecht of, voor webwinkels, door het retourportaal. Het nummer staat op de pakbon en op een label op elk collo of elke pallet. Komt er een zending binnen zonder retournummer, dan nemen we die niet in ontvangst en neemt de chauffeur die weer mee. Lukt dat niet, bijvoorbeeld omdat de pakketbezorger al weg is, dan zet je de zending in het quarantainevak bij dock 1 en meld je die bij de verkoopbinnendienst.

7.2 Retouren van tuincentra
Tuincentra melden een retour aan bij hun accountmanager, die het retournummer aanvraagt met retourformulier RET-02. Een tuincentrum mag ongeschonden goederen tot dertig dagen na levering terugsturen; daarna alleen met toestemming van verkoop. Retouren van tuincentra halen we zelf op met onze eigen vrachtwagen, op de eerstvolgende vaste rit naar dat tuincentrum. Ze worden bij dock 2 ontvangen en per pallet gecontroleerd aan de hand van de pakbon. Retouren van tuincentra worden binnen drie werkdagen na ontvangst beoordeeld; de verkoopbinnendienst maakt de creditnota pas als wij de beoordeling hebben afgerond.

7.3 Retouren van webwinkels
Webwinkels melden een retour aan in het retourportaal, waar ze per artikel de reden kiezen; het portaal maakt het retournummer aan en zet het op retourformulier RET-05. Een webwinkel mag ongeschonden goederen tot zestig dagen na levering terugsturen, omdat de klanten van de webwinkel zelf een bedenktijd hebben. Retouren van webwinkels komen als losse pakketten binnen, met de pakketdienst die de webwinkel zelf kiest. Ze worden bij dock 9 ontvangen en per pakket gescand. Retouren van webwinkels worden binnen vijf werkdagen na ontvangst beoordeeld; in november en december, als de webwinkels veel terugkrijgen, is dat tien werkdagen.

7.4 Beoordelen
De retourmedewerker bekijkt elk artikel en geeft het in het magazijnbeheersysteem een beoordelingscode. R1: het artikel is ongeschonden en compleet en gaat terug in de voorraad. R2: het artikel is in orde, maar de verpakking niet. R3: het artikel is beschadigd of incompleet en wordt afgekeurd. Twijfel je tussen R2 en R3, bijvoorbeeld bij krassen op een aluminium tafelblad, vraag dan de teamleider retouren om een oordeel. Maak bij R3 altijd minstens twee foto's en voeg die toe aan de retourregel in het systeem.

7.5 Transportschade
Ontdek je de schade pas bij het uitpakken, dan meld je die binnen zeven dagen bij de vervoerder; daarna is hij niet meer aansprakelijk. Dat geldt zowel voor inkooporders als voor retouren. Leg de schade vast in een ticket met de categorie Transportschade, met foto's van de buitenverpakking en van het artikel zelf. Verkoop stelt de vervoerder aansprakelijk; jij zorgt alleen dat het ticket compleet is.

7.6 Herverpakken
Het herverpakstation staat in hal 1, naast de retourafdeling. Artikelen met code R2 krijgen daar een nieuwe doos uit de voorraad verpakkingsmateriaal en een nieuw artikeletiket. Voor loungesets en parasols in een eigen bedrukte doos bestellen we geen losse dozen bij: die gaan in een neutrale doos en worden als B-keuze verkocht met 15 procent korting. Tuinkussens die vochtig zijn geweest, verpakken we nooit opnieuw, ook niet als ze weer droog zijn; die worden altijd afgekeurd. Het herverpakstation verwerkt gemiddeld veertig artikelen per dag. Ligt er meer dan drie dagen werk, dan meldt de teamleider retouren dat in het planningsoverleg.

7.7 Afkeur en afvoer
Afgekeurde artikelen gaan naar de afkeurkooi in hal 4. Is een artikel nog te repareren, bijvoorbeeld een barbecue waar een knop aan ontbreekt, dan bestelt de retourafdeling het onderdeel bij de leverancier en gaat het artikel daarna als R2 verder. Kan het niet worden gerepareerd, dan voeren we het af. Afkeur met een inkoopwaarde van meer dan 750 euro per retour voer je pas af als het hoofd magazijn dat heeft goedgekeurd. Hout en metaal gaan in de containers op het buitenterrein; textiel, kussens en kunststof haalt Vaartse Recycling elke tweede dinsdag van de maand op. Gasflessen en onderdelen van gasbarbecues gooi je nooit in een container: die zet je in de afgesloten gaskast bij dock 12 en je meldt ze bij de preventiemedewerker.

7.8 Weekoverzicht
Elke maandag maakt de teamleider retouren een overzicht van de retouren van de week ervoor: het aantal per klanttype, de verdeling over R1, R2 en R3, en de doorlooptijd. Het overzicht gaat naar Daan Bakker voor de planning en naar de verkoopbinnendienst. Wordt bij één leverancier meer dan tien procent van de retouren afgekeurd, dan krijgt Inkoop daarvan bericht.`,
  },
  {
    key: "nl-inkoopbeleid",
    language: "nl",
    readers: { team: "everyone" },
    text: `Inkoopbeleid Groenhaven

Versie 3.0, vastgesteld door de directie op 2 oktober 2026 en geldig vanaf 1 november 2026. Eigenaar: afdeling Inkoop, Utrecht.

Artikel 1 Doel en reikwijdte
Dit beleid geldt voor alle inkoop door Groenhaven en haar vestigingen in Nederland, Duitsland, Frankrijk en Spanje. Het regelt wie mag bestellen, wie moet goedkeuren en hoe we leveranciers kiezen en beoordelen. Het doel is dat we eerlijk en controleerbaar inkopen en niet meer betalen dan nodig. Hoe een nieuwe leverancier in het systeem wordt aangemaakt en hoe facturen worden betaald, staat niet in dit beleid maar in de procedures van Finance.

Artikel 2 Begrippen
Handelsgoederen zijn producten die we inkopen om ze door te verkopen, zoals tuinmeubelen, parasols, barbecues en tuingereedschap. Indirecte inkoop is al het andere: diensten, kantoorartikelen, onderhoud van gebouwen en installaties, verpakkingsmateriaal, IT-apparatuur en uitzendkrachten. Een bestelaanvraag is het verzoek in het inkoopsysteem om iets te mogen bestellen; een inkooporder is de bestelling die daarna naar de leverancier gaat.

Artikel 3 Inkoop van handelsgoederen
Handelsgoederen worden alleen besteld door de category managers van de afdeling Inkoop, op basis van de voorraadplanning. Voor handelsgoederen geldt per inkooporder: tot 50.000 euro keurt de category manager zelf goed, van 50.000 tot 250.000 euro keurt het hoofd Inkoop goed, en boven 250.000 euro is ook de handtekening van de operations director nodig. Bestellingen voor het voorjaarsseizoen worden vóór 1 december vastgelegd als seizoensbestelling en in één keer door het hoofd Inkoop goedgekeurd, ook als ze in delen worden geleverd. Luidt een inkooporder in een andere valuta dan de euro, dan rekent het inkoopsysteem het bedrag om tegen de koers van de besteldag.

Artikel 4 Indirecte inkoop
Indirecte inkoop wordt besteld door de budgethouder van de afdeling of vestiging die de kosten draagt, met een bestelaanvraag in het inkoopsysteem. Voor indirecte inkoop geldt per bestelaanvraag: tot 5.000 euro keurt de budgethouder zelf goed, van 5.000 tot 25.000 euro keurt het afdelingshoofd of de vestigingsmanager goed, en boven 25.000 euro is ook de handtekening van de financieel directeur nodig. Kantoorartikelen bestel je alleen uit de catalogus van de vaste kantoorleverancier in het inkoopsysteem; daarvoor zijn geen offertes nodig.

Artikel 5 Offertes
Voor elke aankoop boven 10.000 euro vraag je minstens drie schriftelijke offertes op, bij leveranciers die niets met elkaar te maken hebben. Boven 100.000 euro organiseert Inkoop een aanbesteding met een vast programma van eisen en een vaste sluitingsdatum. Je vergelijkt offertes niet alleen op prijs, maar ook op levertijd, kwaliteit, duurzaamheid en service. Die afweging leg je vast in het offertevergelijkingsformulier INK-07, dat je bij de bestelaanvraag opslaat. Kies je niet de goedkoopste aanbieder, dan licht je in hetzelfde formulier toe waarom.

Artikel 6 Leveranciersbeoordeling
Inkoop beoordeelt elke leverancier van handelsgoederen bij wie we meer dan 100.000 euro per jaar inkopen, twee keer per jaar, in maart en in september. We kijken naar leverbetrouwbaarheid, kwaliteit, prijsontwikkeling en samenwerking, elk met een cijfer van 1 tot 10; de cijfers over kwaliteit komen uit de afkeur- en retourgegevens van de magazijnen. Een leverancier die gemiddeld lager dan een 6 scoort, krijgt een verbeterplan met een termijn van zes maanden. Blijft het gemiddelde daarna onder de 6, dan zoekt Inkoop een andere leverancier.

Artikel 7 Belangenverstrengeling en geschenken
Je koopt niet in bij een bedrijf waarin jij, je partner of een familielid een belang heeft of waar een van hen werkt, tenzij je dat vooraf bij je leidinggevende hebt gemeld en iemand anders de beslissing neemt. Geschenken en uitnodigingen van leveranciers mag je aannemen tot een waarde van 50 euro per keer, maar nooit tijdens een lopende offerteronde. Alles boven die waarde meld je in het geschenkenregister op het intranet; Inkoop besluit dan of je het mag houden, of dat het wordt teruggestuurd of onder het personeel verloot. Uitnodigingen voor reizen of evenementen van meer dan één dag sla je altijd af, en contant geld of cadeaubonnen neem je nooit aan.

Artikel 8 Raamcontracten
Wat we regelmatig afnemen, kopen we in via een raamcontract met vaste prijzen voor de hele looptijd. Een raamcontract loopt hoogstens drie jaar, met één optie om het met een jaar te verlengen. Zes maanden voor het einde beslist Inkoop samen met de gebruikers of het contract opnieuw wordt aanbesteed. Lopende raamcontracten staan met een eigen nummer in het contractregister op het intranet; zo valt de schoonmaak in Utrecht en Nieuwegein onder RAC-2025-04 en het onderhoud van de heftrucks in Nieuwegein onder RAC-2026-11. Bestaat er voor iets een raamcontract, dan bestel je via dat contract, ook als een andere leverancier een keer goedkoper is.

Artikel 9 Afwijkingen
Wie van dit beleid wil afwijken, bijvoorbeeld bij een spoedreparatie of omdat maar één leverancier het product kan leveren, vult vooraf het afwijkingsformulier INK-09 in. Het hoofd Inkoop beslist binnen twee werkdagen. Bij spoed buiten kantoortijd mag de vestigingsmanager beslissen en vul je het formulier achteraf in. Een bestelling opknippen om onder een goedkeuringsgrens te blijven, is nooit toegestaan en geldt als overtreding van dit beleid. Inkoop rapporteert elk kwartaal aan de directie hoeveel afwijkingen er waren en waarom.`,
  },
  {
    key: "nl-hr-beloning-2027",
    language: "nl",
    readers: { team: "hr" },
    text: `Vertrouwelijk · Salarisronde en beloningsbeleid 2027

Van: Anna de Wit, HR
Aan: Eva, operations director
Datum: 9 november 2026
Niet doorsturen. Tot 1 december blijft deze memo binnen HR en de directie.

1. Aanleiding
Elk najaar leggen we vast hoe de salarissen per 1 januari worden aangepast. In deze memo staat het voorstel voor 2027 voor alle vestigingen, met de bonusregeling, een blijfregeling voor sleutelfuncties en het tijdpad tot en met de loonstroken van januari. Het voorstel past binnen de personeelsbegroting die Finance voor 2027 opstelt. Over de cijfers is nog niet met de medewerkers of leidinggevenden gesproken.

2. Budget voor de salarisronde
Voor de salarisronde 2027 is in totaal 3,1 procent van de loonsom beschikbaar, ongeveer 412.000 euro. Daarvan gaat 1,8 procent naar een algemene verhoging voor iedereen en 1,3 procent naar individuele verhogingen op basis van functioneren. Valt een wettelijke of collectieve verhoging in een land hoger uit dan de algemene verhoging, dan volgen we die en halen we het verschil uit het individuele deel van dat land. In Duitsland, Frankrijk en Spanje zetten de lokale HR-contactpersonen de verdeling om naar de eigen schalen, binnen hetzelfde totaalbudget.

3. Verdeling van de individuele verhogingen
De individuele verhoging hangt af van de beoordeling over 2026 en van de plaats in de schaal. Wie de beoordeling ‘goed’ heeft gekregen en onder het midden van de schaal zit, krijgt 2 procent extra; boven het midden is dat 1 procent. Bij ‘zeer goed’ is het 3 procent onder het midden en 2 procent erboven. Bij ‘voldoende’ is er geen individuele verhoging, alleen de algemene. Wie al op het maximum van de schaal zit, krijgt het individuele deel als eenmalige uitkering in plaats van structureel. Leidinggevenden mogen binnen hun afdeling schuiven, maar niet over het budget van hun afdeling heen.

4. Teambonus magazijnen
De bonusregeling voor het kantoorpersoneel blijft in 2027 zoals ze is. Voor de magazijnen stellen we een nieuwe teambonus voor: haalt een vestiging in het voorjaarsseizoen, van maart tot en met juni, een leverbetrouwbaarheid van minstens 97 procent, dan krijgt iedere medewerker van dat magazijn in juli een bonus van 350 euro bruto. Uitzendkrachten die het hele seizoen hebben gewerkt, krijgen hetzelfde bedrag via het uitzendbureau. De teambonus geldt voor Nieuwegein, Duisburg en Valencia. Lyon heeft geen magazijn; de verkopers daar hebben een eigen variabele beloning.

5. Blijfregeling voor sleutelfuncties
Voor een klein aantal functies waarvoor we moeilijk vervanging vinden, stellen we een blijfregeling voor. Het gaat om de planners van de drie magazijnen en om twee functies bij IT. Wie op 1 januari 2028 nog in dienst is en niet zelf heeft opgezegd, krijgt een blijfpremie van een half maandsalaris, die met het salaris van januari 2028 wordt uitbetaald. De premie wordt per persoon schriftelijk toegezegd, in een brief die Eva ondertekent. We noemen de regeling niet in algemene berichten, zodat collega's in andere functies zich niet achtergesteld voelen.

6. Marktcorrecties
Naast de salarisronde is 60.000 euro gereserveerd voor marktcorrecties: functies waarvan het salaris duidelijk achterloopt bij wat andere werkgevers betalen. Volgens het salarisonderzoek van september gaat het in 2027 vooral om de heftruckchauffeurs in Nieuwegein en Duisburg en om de medewerkers crediteurenadministratie in Utrecht. Een marktcorrectie gaat in per 1 april en staat los van de jaarlijkse verhoging.

7. Tijdpad
Op 18 november krijgen de leidinggevenden in het HR-portaal hun budget en de beoordelingen van hun mensen te zien. Zij verdelen de individuele verhogingen vóór 2 december en lichten afwijkingen van de percentages in paragraaf 3 schriftelijk toe. HR controleert de verdeling per afdeling, en op 9 december keurt de directie het geheel goed. Daarna verwerkt de salarisadministratie de nieuwe salarissen uiterlijk 15 december, zodat ze op de loonstrook van januari staan.

8. Wat we wanneer vertellen
Eva kondigt de algemene verhoging op 1 december aan in het personeelsbericht, zonder iets over de individuele verhogingen te zeggen. Iedere medewerker krijgt in de week van 14 december een persoonlijke brief met het nieuwe salaris in het HR-portaal, en de leidinggevende licht die vóór 23 december in een kort gesprek toe. De teambonus maken we in februari op de vestigingen bekend, ruim voordat het voorjaarsseizoen begint. De marktcorrecties bespreken leidinggevenden in maart met de medewerkers om wie het gaat. Vragen van medewerkers over de salarisronde gaan naar HR, niet naar de salarisadministratie.

9. Open punten
Twee punten wil ik nog met je bespreken. Ten eerste: wie in 2026 korter dan zes maanden in dienst was, heeft geen beoordeling. Ik stel voor dat die medewerkers alleen de algemene verhoging krijgen en dat we in juli opnieuw naar hun salaris kijken. Ten tweede vraagt de ondernemingsraad elk jaar om een toelichting op de salarisronde. Ik stel voor dat we die op 3 december geven, na de aankondiging in het personeelsbericht en voordat de persoonlijke brieven uitgaan.`,
  },
];

export const nlLongHandbookQuestions: readonly BrainEvalQuestion[] = [
  // Personeelshandboek: opleiding en ontwikkeling.
  {
    id: "nl-long-opleidingsbudget",
    language: "nl",
    question: "Hoeveel persoonlijk opleidingsbudget heb ik per kalenderjaar?",
    expects: answer(
      "words",
      "nl-handboek-opleiding",
      "persoonlijk opleidingsbudget van 1.200 euro per kalenderjaar"
    ),
  },
  {
    id: "nl-long-ontwikkelgesprekken-magazijn",
    language: "nl",
    question: "Wanneer zijn in het magazijn de ontwikkelgesprekken?",
    expects: answer(
      "forms",
      "nl-handboek-opleiding",
      "In de magazijnen gebeurt dat in september en oktober"
    ),
  },
  {
    id: "nl-long-opl-01",
    language: "nl",
    question: "Waarvoor gebruik ik OPL-01?",
    expects: answer(
      "exact",
      "nl-handboek-opleiding",
      "aanvraagformulier OPL-01 in het HR-portaal"
    ),
  },
  {
    id: "nl-long-blokken-tentamen",
    language: "nl",
    question: "Mag ik vrijnemen om te blokken voor een tentamen?",
    expects: answer(
      "paraphrase",
      "nl-handboek-opleiding",
      "maximaal vier studiedagen per kalenderjaar"
    ),
  },
  // Magazijnhandboek Nieuwegein: retouren.
  {
    id: "nl-long-dock-webwinkels",
    language: "nl",
    question: "Bij welk dock worden retouren van webwinkels ontvangen?",
    expects: answer(
      "words",
      "nl-handboek-retouren",
      "Ze worden bij dock 9 ontvangen",
      "Ze worden bij dock 2 ontvangen"
    ),
  },
  {
    id: "nl-long-beoordeling-tuincentrum",
    language: "nl",
    question:
      "Binnen hoeveel werkdagen beoordelen jullie de retour van een tuincentrum?",
    expects: answer(
      "forms",
      "nl-handboek-retouren",
      "binnen drie werkdagen na ontvangst beoordeeld",
      "binnen vijf werkdagen na ontvangst beoordeeld"
    ),
  },
  {
    id: "nl-long-code-r2",
    language: "nl",
    question: "Wat betekent R2 bij een retour?",
    expects: answer(
      "exact",
      "nl-handboek-retouren",
      "R2: het artikel is in orde, maar de verpakking niet"
    ),
  },
  {
    id: "nl-long-later-stuk",
    language: "nl",
    question:
      "Ik merk pas na het openmaken dat er iets kapot is. Hoe lang heb ik dan nog om de transporteur daarop aan te spreken?",
    expects: answer(
      "paraphrase",
      "nl-handboek-retouren",
      "binnen zeven dagen bij de vervoerder"
    ),
  },
  // Inkoopbeleid.
  {
    id: "nl-long-handtekening-indirect",
    language: "nl",
    question:
      "Boven welk bedrag is bij indirecte inkoop ook een handtekening nodig?",
    expects: answer(
      "words",
      "nl-inkoopbeleid",
      "boven 25.000 euro is ook de handtekening van de financieel directeur nodig",
      "boven 250.000 euro is ook de handtekening van de operations director nodig"
    ),
  },
  {
    id: "nl-long-slecht-scorende-leverancier",
    language: "nl",
    question: "Wat gebeurt er met een slecht scorende leverancier?",
    expects: answer(
      "forms",
      "nl-inkoopbeleid",
      "krijgt een verbeterplan met een termijn van zes maanden"
    ),
  },
  {
    id: "nl-long-ink-07",
    language: "nl",
    question: "Waarvoor dient INK-07?",
    expects: answer(
      "exact",
      "nl-inkoopbeleid",
      "offertevergelijkingsformulier INK-07"
    ),
  },
  {
    id: "nl-long-kist-wijn",
    language: "nl",
    question:
      "Een fabrikant heeft me een kist wijn gestuurd. Is dat toegestaan?",
    expects: answer(
      "paraphrase",
      "nl-inkoopbeleid",
      "tot een waarde van 50 euro per keer"
    ),
  },
  // Salarisronde en beloningsbeleid 2027 (vertrouwelijk, HR).
  {
    id: "nl-long-marktcorrecties",
    language: "nl",
    asker: "anna",
    question: "Hoeveel is er gereserveerd voor marktcorrecties?",
    expects: answer(
      "words",
      "nl-hr-beloning-2027",
      "60.000 euro gereserveerd voor marktcorrecties"
    ),
  },
  {
    id: "nl-long-verhoging-verdeeld",
    language: "nl",
    asker: "anna",
    question:
      "Wanneer moeten de leidinggevenden de individuele verhogingen verdeeld hebben?",
    expects: answer(
      "forms",
      "nl-hr-beloning-2027",
      "verdelen de individuele verhogingen vóór 2 december"
    ),
  },
  {
    id: "nl-long-hoogste-loon",
    language: "nl",
    asker: "anna",
    question:
      "Wat krijgt iemand die al het hoogstmogelijke loon voor zijn functie verdient?",
    expects: answer(
      "paraphrase",
      "nl-hr-beloning-2027",
      "als eenmalige uitkering in plaats van structureel"
    ),
  },
  {
    id: "nl-long-bonus-magazijn",
    language: "nl",
    asker: "daan",
    question:
      "Krijgen we in het magazijn een bonus als het voorjaar goed loopt?",
    expects: hidden(
      "nl-hr-beloning-2027",
      "bonus van 350 euro bruto",
      "minstens 97 procent",
      "nieuwe teambonus",
      "De teambonus maken we in februari"
    ),
  },
  {
    id: "nl-long-blijfpremie-planners",
    language: "nl",
    asker: "lukas",
    question: "Komt er een blijfpremie voor de planners?",
    expects: hidden(
      "nl-hr-beloning-2027",
      "blijfpremie van een half maandsalaris",
      "op 1 januari 2028 nog in dienst",
      "de planners van de drie magazijnen",
      "blijfregeling voor sleutelfuncties"
    ),
  },
  // Antwoord nergens te vinden.
  {
    id: "nl-long-pensioen",
    language: "nl",
    question: "Hoeveel draagt Groenhaven bij aan mijn pensioen?",
    expects: absent,
  },
];
