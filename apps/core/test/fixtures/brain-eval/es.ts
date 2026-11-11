import { absent, answer, hidden } from "./company.ts";
import type { BrainEvalQuestion, BrainEvalSource } from "./company.ts";

// Groenhaven in Spanish: the distribution centre in Valencia
// (company.ts). Written in Spanish, never translated.

export const esSources: readonly BrainEvalSource[] = [
  {
    key: "es-turnos",
    language: "es",
    kind: "handbook",
    readers: { team: "planning" },
    text: `Turnos del centro de Valencia

El turno de mañana va de 6:00 a 14:00 y el turno de tarde de 14:00 a 22:00. Los cambios de turno se solicitan al jefe de turno con 48 horas de antelación como mínimo.`,
  },
  {
    key: "es-vacaciones",
    language: "es",
    kind: "handbook",
    readers: { team: "everyone" },
    text: `Vacaciones en España

La plantilla en España tiene 23 días laborables de vacaciones al año. Las solicitudes para el verano se presentan antes del 31 de marzo.

En agosto el almacén de Valencia funciona a medio gas: solo trabaja el turno de mañana.`,
  },
  {
    key: "es-prevencion",
    language: "es",
    kind: "handbook",
    readers: { team: "everyone" },
    text: `Prevención de riesgos laborales

En el muelle es obligatorio llevar chaleco reflectante. Las carretillas elevadoras se revisan cada tres meses. Cualquier accidente se comunica al responsable de prevención en menos de una hora.`,
  },
  {
    key: "es-impresora",
    language: "es",
    kind: "ticket",
    readers: { team: "planning" },
    text: `Incidencia VLC-0934 · Muelle 2 · Abierta

La impresora de etiquetas del muelle 2 imprime códigos de barras ilegibles que los lectores no reconocen. Se ha pedido un cabezal nuevo. Mientras tanto, imprimid las etiquetas en la impresora del muelle 1.`,
  },
  {
    key: "es-reunion-murcia",
    language: "es",
    kind: "meeting",
    readers: { team: "planning" },
    text: `Acta de la reunión del 5 de noviembre

1. Nuevo cliente en Murcia: tres camiones a la semana a partir de enero.
2. Contratamos dos mozos de almacén más para el turno de tarde.
3. Javier prepara la ruta y la presenta en la próxima reunión.`,
  },
  {
    key: "es-curso-javier",
    language: "es",
    kind: "email",
    readers: { owner: "javier" },
    text: `De: Recursos Humanos
Para: Javier Moreno
Asunto: Tu curso de carretillero

Hola Javier:

Tu curso de carretillero avanzado es el 12 de enero en Paterna, de 8:00 a 15:00. Trae tu calzado de seguridad.

Un saludo`,
  },
  {
    key: "es-recogida-portugal",
    language: "es",
    kind: "email",
    readers: { team: "planning" },
    text: `De: Javier Moreno
Para: equipo de planificación
Asunto: Nueva hora de recogida Hermanos Gil

Hola a todos:

Desde el lunes, Transportes Hermanos Gil recoge los pedidos para Portugal a las 16:30. Los pedidos a Portugal tienen que estar preparados antes de las 15:00.

Javier`,
  },
  {
    key: "es-dietas",
    language: "es",
    kind: "handbook",
    readers: { team: "everyone" },
    text: `Dietas y kilometraje

Si usas tu propio vehículo para un viaje de trabajo, se pagan 0,26 € por kilómetro. Cuando el viaje incluye pernoctar fuera, la dieta es de 53,34 € por día.`,
  },
  {
    key: "es-turno-tarde",
    language: "es",
    kind: "meeting",
    readers: { team: "hr" },
    text: `Confidencial · Recursos Humanos, 7 de noviembre

Se estudia cerrar el turno de tarde en Valencia durante el verano. Afectaría a 9 trabajadores temporales, cuyos contratos no se renovarían en junio.`,
  },
];

export const esQuestions: readonly BrainEvalQuestion[] = [
  {
    id: "es-turno-manana",
    language: "es",
    question: "¿A qué hora empieza el turno de mañana?",
    expects: answer(
      "words",
      "es-turnos",
      "El turno de mañana va de 6:00 a 14:00"
    ),
  },
  {
    id: "es-dias-vacaciones",
    language: "es",
    question: "¿Cuántos días de vacaciones tengo al año en España?",
    expects: answer(
      "words",
      "es-vacaciones",
      "23 días laborables de vacaciones"
    ),
  },
  {
    id: "es-carretillas",
    language: "es",
    question: "¿Cada cuánto se revisan las carretillas elevadoras?",
    expects: answer("words", "es-prevencion", "se revisan cada tres meses"),
  },
  {
    id: "es-kilometro",
    language: "es",
    question: "¿Cuánto se paga por kilómetro con vehículo propio?",
    expects: answer("words", "es-dietas", "0,26 € por kilómetro"),
  },
  {
    id: "es-camiones-murcia",
    language: "es",
    question: "¿Cuántos camiones necesita el nuevo cliente de Murcia?",
    expects: answer("words", "es-reunion-murcia", "tres camiones a la semana"),
  },
  {
    id: "es-solicito-cambio",
    language: "es",
    question: "¿Con cuánta antelación solicito cambiar mi turno?",
    expects: answer("forms", "es-turnos", "con 48 horas de antelación"),
  },
  {
    id: "es-chalecos",
    language: "es",
    question: "¿Son obligatorios los chalecos en los muelles?",
    expects: answer(
      "forms",
      "es-prevencion",
      "obligatorio llevar chaleco reflectante"
    ),
  },
  {
    id: "es-accidentes",
    language: "es",
    question: "¿A quién comunico un accidente?",
    expects: answer("words", "es-prevencion", "al responsable de prevención"),
  },
  {
    id: "es-vlc-0934",
    language: "es",
    question: "¿Qué pasa con VLC-0934?",
    expects: answer("exact", "es-impresora", "Se ha pedido un cabezal nuevo"),
  },
  {
    id: "es-mi-curso",
    language: "es",
    asker: "javier",
    question: "¿Cuándo es mi curso de carretillero?",
    expects: answer("words", "es-curso-javier", "el 12 de enero en Paterna"),
  },
  {
    id: "es-verano-almacen",
    language: "es",
    question: "¿Se trabaja por la tarde en el almacén durante agosto?",
    expects: answer(
      "paraphrase",
      "es-vacaciones",
      "solo trabaja el turno de mañana"
    ),
  },
  {
    id: "es-etiquetas-escanear",
    language: "es",
    question: "Las pegatinas no se pueden escanear, ¿qué hago?",
    expects: answer(
      "paraphrase",
      "es-impresora",
      "imprimid las etiquetas en la impresora del muelle 1"
    ),
  },
  {
    id: "es-mercancia-lisboa",
    language: "es",
    question: "¿A qué hora pasan a buscar la mercancía que va a Lisboa?",
    expects: answer("paraphrase", "es-recogida-portugal", "a las 16:30"),
  },
  {
    id: "es-dormir-fuera",
    language: "es",
    question: "¿Cuánto me pagan al día si duermo fuera de casa por trabajo?",
    expects: answer("paraphrase", "es-dietas", "53,34 € por día"),
  },
  {
    id: "es-guarderia",
    language: "es",
    question: "¿Hay plazas de guardería para los hijos de los empleados?",
    expects: absent,
  },
  {
    id: "es-comedor",
    language: "es",
    question: "¿Cuál es el horario del comedor?",
    expects: absent,
  },
  {
    id: "es-turno-tarde-verano",
    language: "es",
    asker: "javier",
    question: "¿Van a cerrar el turno de tarde en verano?",
    expects: hidden(
      "es-turno-tarde",
      "9 trabajadores temporales",
      "no se renovarían"
    ),
  },
  {
    id: "es-curso-javier",
    language: "es",
    asker: "camille",
    question: "¿Cuándo es el curso de carretillero de Javier Moreno?",
    expects: hidden("es-curso-javier", "12 de enero", "Paterna"),
  },
];
