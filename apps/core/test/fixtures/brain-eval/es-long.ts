import { absent, answer, hidden } from "./company.ts";
import type { BrainEvalQuestion, BrainEvalSource } from "./company.ts";

// Groenhaven's long Spanish documents, from the distribution centre in
// Valencia: a chapter of the centre's handbook on goods receipt and the
// planner's review of the 2026 summer peak. Written in Spanish, never
// translated.

export const esLongSources: readonly BrainEvalSource[] = [
  {
    key: "es-manual-recepcion",
    language: "es",
    readers: { team: "everyone" },
    text: `Manual del centro de distribución de Valencia. Capítulo 3: recepción de mercancía

Este capítulo explica cómo se recibe la mercancía que entra en el centro de distribución de Valencia, desde que el proveedor pide cita hasta que los palés quedan ubicados en el SGA. Lo aplican los jefes de muelle, los carretilleros y el personal de administración de entradas. Versión 4, revisada en octubre de 2026 por Javier Moreno. Si algo de lo que se describe aquí no encaja con lo que veis en el muelle, avisad a planificación antes de improvisar.

3.1 Cita previa
En Valencia no se descarga ningún vehículo sin cita. El proveedor, o el transportista en su nombre, reserva la franja en el portal de citas de Groenhaven con el número de pedido de compra (empieza siempre por PC-VLC). Las franjas son de 45 minutos y el portal no deja reservar dos franjas seguidas para el mismo pedido. Administración de entradas revisa las reservas cada mañana y anula las que no traen número de pedido válido. Un camión que llega más de 30 minutos tarde pierde su franja y espera al primer hueco libre del día; si no lo hay, se le da cita para el día siguiente. Al tercer retraso de un mismo transportista en un mes, administración de entradas lo comunica por escrito al comprador responsable del proveedor.

3.2 Recepción de camiones paletizados
El aviso de llegada de un camión paletizado se envía por el portal con 24 horas de antelación como mínimo, indicando el número de palés y la matrícula. Los camiones paletizados se descargan en los muelles 3, 4, 5 y 6. La descarga de un tráiler completo de 33 palés no debe pasar de 50 minutos; si se alarga, el jefe de muelle anota el motivo en la hoja de descarga. Documentos que hay que recoger: el albarán del proveedor y la carta de porte CMR, los dos firmados por el chófer. Comprobaciones: contar los palés contra el albarán, revisar que el film y los cantoneros estén enteros y que los palés europeos estén en condiciones de intercambio. Los palés europeos que entregamos a cambio se apuntan en el vale de intercambio, con copia para el chófer.

3.3 Recepción de contenedores marítimos
El aviso de llegada de un contenedor marítimo lo envía el transitario por el portal con 72 horas de antelación como mínimo, junto con el número de contenedor y el de precinto. Los contenedores marítimos se descargan únicamente en el muelle 8, el único con rampa niveladora larga. La descarga de un contenedor de 40 pies con la carga suelta, sin paletizar, se planifica en tres horas con cuatro personas; uno de 20 pies, en hora y media. Documentos que hay que recoger: la lista de bultos (packing list), la copia del conocimiento de embarque y el DUA de importación con el levante concedido. Comprobaciones: que el número de precinto coincida con el del aviso, fotografiar el precinto antes de cortarlo y revisar si hay condensación en el techo o cajas húmedas antes de empezar a sacar mercancía. Sin DUA levantado el contenedor no se abre.

3.4 Diferencias e incidencias
Cualquier diferencia de cantidad entre lo que llega y lo que dice el albarán o la lista de bultos se registra en el parte de recepción REC-07 antes de que el chófer se marche. Si faltan bultos o sobran, se anota la cantidad real en el albarán con la mención «con reservas» y se firma así; nunca se firma «conforme» con una diferencia pendiente. En los contenedores, las cajas que salen mojadas, aplastadas o con el embalaje abierto se apartan en la zona de cuarentena Q1, al fondo del pasillo 14, y no se ubican hasta que compras decida qué hacer con ellas. Administración de entradas envía el REC-07 con las fotos al proveedor en un plazo de 24 horas; pasado ese plazo, la mayoría de proveedores ya no aceptan la reclamación.

3.5 Ubicación
Una vez cerrada la recepción en el SGA, cada palé recibe su etiqueta SSCC y el sistema propone una ubicación. El carretillero escanea la etiqueta y la ubicación al dejar el palé; si la ubicación propuesta está ocupada, elige otra libre del mismo pasillo y la confirma en el lector. Todo lo recibido debe estar ubicado en las cuatro horas siguientes al cierre de la recepción. Los muebles de jardín voluminosos van a las estanterías de altura de los pasillos 20 a 28. Las herramientas de jardín con batería de litio se guardan aparte, en la zona B, separada del resto de la nave por un muro cortafuegos, y nunca se dejan en el pasillo de espera junto a los muelles.

3.6 Devoluciones a proveedor
La mercancía que compras decide no aceptar se devuelve al proveedor con el formulario DEV-03, en el que debe figurar el número de autorización de devolución que da el propio proveedor. Sin ese número no sale nada del centro. El proveedor tiene diez días laborables para recoger la devolución desde que recibe el DEV-03; a partir del undécimo día se le factura almacenaje a razón de 4 € por palé y semana. Las devoluciones se cargan siempre en el muelle 7, para que no se mezclen con la mercancía que entra por los muelles de recepción.

3.7 Registro
Cada recepción queda registrada en el SGA con la hora de llegada, la hora de fin de descarga, el muelle y el nombre del jefe de muelle que la cierra. Los albaranes y los CMR firmados se escanean el mismo día y se adjuntan a la recepción; el papel se guarda en el archivo de administración durante seis años. Los partes REC-07 y los formularios DEV-03 se archivan junto con la recepción a la que pertenecen, para que cualquier reclamación posterior se pueda seguir desde un solo sitio. Los indicadores de recepción (tiempo medio de descarga por muelle y porcentaje de llegadas con cita) se revisan todos los lunes por la mañana en la reunión de planificación.`,
  },
  {
    key: "es-balance-campana",
    language: "es",
    readers: { team: "planning" },
    text: `Balance de la campaña de verano 2026

Autor: Javier Moreno, planificador del centro de distribución de Valencia. Fecha: 3 de noviembre de 2026. Distribución: equipo de planificación. Este documento recoge lo que pasó en la campaña de verano de 2026 en Valencia, con los datos cerrados a 31 de octubre, para que lo tengamos delante cuando preparemos la de 2027.

1. Contexto
La campaña de verano va, para nosotros, del 4 de mayo al 17 de julio: once semanas en las que los centros de jardinería y las grandes superficies del Levante y de Andalucía reponen muebles de jardín, sombrillas y barbacoas casi a diario. Este año arrancamos con dos novedades: la colección de muebles de exterior Marina, que se vendía por primera vez en España, y el cliente Ferreterías Segura, que empezó a pedirnos en abril y que no estaba en la previsión de ventas. A eso se sumó que el proveedor de sombrillas cambió de puerto de salida en marzo y los contenedores empezaron a llegar con una semana de retraso respecto al calendario acordado.

2. Cifras
En las once semanas de la campaña de verano de 2026 en Valencia preparamos 41.300 líneas de pedido, un 22 % más que en la campaña de 2025. La semana más fuerte fue la 23, con 5.480 líneas. Expedimos 2.960 palés y recibimos 61 contenedores marítimos. El porcentaje de pedidos servidos completos y a tiempo se quedó en el 96,1 %, por debajo del objetivo del 97,5 % que nos habíamos marcado. La productividad media en preparación fue de 92 líneas por persona y turno, frente a 85 el año pasado. Las roturas de stock en barbacoas de gas nos costaron, según ventas, unos 190 pedidos que se sirvieron incompletos.

3. Qué funcionó
La preparación por oleadas, que probamos desde la semana 20, fue lo mejor de la campaña: agrupar los pedidos por ruta de transporte y lanzarlos en bloques de una hora redujo los desplazamientos de los preparadores y nos permitió cerrar los camiones antes. También dio buen resultado mover a la zona de picking delantera las 120 referencias con más salida, cosa que hicimos el 11 de mayo con la ayuda del equipo de Nieuwegein, que nos pasó su método de clasificación ABC. La comunicación diaria con Transportes Ribera, por teléfono a primera hora, evitó casi todos los malentendidos con las rutas de Andalucía.

4. Qué falló
Lo que más nos penalizó fue la previsión. Ventas nos pasó la previsión de la colección Marina en abril, cuando ya teníamos cerrada la plantilla de refuerzo, y se quedó corta en casi un 40 %. Además, no dábamos abasto para ubicar en altura los palés de muebles: en la semana 23 llegamos a tener 46 palés esperando en el pasillo junto a los muelles durante más de un día, lo que entorpecía la carga. Por último, los lectores de mano nuevos llegaron tarde, el 1 de junio, y los primeros días hubo que formar a la gente sobre la marcha, en plena punta de trabajo. Y en julio Transportes Ribera no tuvo camiones suficientes para las rutas de Andalucía, de modo que parte de esos pedidos salieron con uno o dos días de retraso.

5. Incidencias
La incidencia VLC-1102 fue la caída del SGA el 9 de junio: el sistema estuvo caído de 10:15 a 13:30, y durante ese tiempo solo pudimos seguir cargando lo que ya estaba preparado. La incidencia VLC-1147, del 24 de junio, fue un contenedor de sombrillas con condensación: 38 sombrillas llegaron con moho en la lona y el proveedor las abonó tras ver las fotos. La incidencia VLC-1163 fue el accidente sin baja del 30 de junio, cuando un palé mal flejado se abrió al bajarlo de la estantería; se revisó el procedimiento de flejado con el proveedor afectado.

6. Lo que nos costó con los clientes
Huertomar Centros de Jardín nos aplicó por contrato una penalización de 6.750 € por los pedidos que les llegaron tarde en las semanas 23 y 24. Para no perder la renovación del acuerdo anual, dirección comercial aceptó además subir dos puntos el rappel de 2026. Ninguno de los dos importes aparece en el informe de ventas por cliente, porque se contabiliza como ajuste de fin de año, así que conviene tenerlo en cuenta al comparar márgenes.

7. Lecciones
La primera lección es que la campaña no se juega en mayo, sino en febrero y marzo, cuando se cierran la plantilla, los lectores y el calendario de contenedores. La segunda es que una referencia nueva sin historial de ventas necesita un margen de seguridad propio. La tercera es que el pasillo de espera junto a los muelles se llena en cuanto la ubicación en altura se retrasa medio día, y que eso frena la carga más que cualquier otra cosa. La cuarta es que ninguna novedad técnica, sean lectores, impresoras o una versión nueva del SGA, debe estrenarse entre mayo y julio: o entra antes de abril o espera a septiembre.

8. Propuestas para 2027
Propongo, primero, que ventas entregue la previsión de las colecciones nuevas antes del 15 de febrero de 2027, con una revisión a mediados de abril. Segundo, reservar con el proveedor de sombrillas los contenedores de abril y mayo con dos semanas de colchón respecto a la fecha en que los necesitamos. Tercero, alquilar una carretilla trilateral adicional de abril a julio solo para ubicar en altura, con presupuesto estimado de 9.800 €. Y cuarto, repetir la preparación por oleadas desde el primer día de campaña. Estas propuestas las presentaré en la reunión de planificación del 1 de diciembre.`,
  },
];

export const esLongQuestions: readonly BrainEvalQuestion[] = [
  {
    id: "es-long-aviso-contenedor",
    language: "es",
    question:
      "¿Con cuánta antelación hay que enviar el aviso de llegada de un contenedor marítimo?",
    expects: answer(
      "words",
      "es-manual-recepcion",
      "por el portal con 72 horas de antelación",
      "por el portal con 24 horas de antelación"
    ),
  },
  {
    id: "es-long-reservar-franjas",
    language: "es",
    question: "¿Cuánto dura cada franja que reservan los proveedores?",
    expects: answer(
      "forms",
      "es-manual-recepcion",
      "Las franjas son de 45 minutos"
    ),
  },
  {
    id: "es-long-dev-03",
    language: "es",
    question: "¿Qué tiene que figurar en el DEV-03?",
    expects: answer(
      "exact",
      "es-manual-recepcion",
      "el número de autorización de devolución"
    ),
  },
  {
    id: "es-long-desbrozadoras",
    language: "es",
    question:
      "¿Dónde se almacenan en Valencia los cortacéspedes y desbrozadoras recargables?",
    expects: answer(
      "paraphrase",
      "es-manual-recepcion",
      "se guardan aparte, en la zona B"
    ),
  },
  {
    id: "es-long-lineas-campana",
    language: "es",
    question:
      "¿Cuántas líneas de pedido preparamos en Valencia en la campaña de verano?",
    expects: answer(
      "words",
      "es-balance-campana",
      "preparamos 41.300 líneas de pedido"
    ),
  },
  {
    id: "es-long-sga-caido",
    language: "es",
    question: "¿Cuánto tiempo estuvo caído el SGA en junio?",
    expects: answer(
      "words",
      "es-balance-campana",
      "el sistema estuvo caído de 10:15 a 13:30"
    ),
  },
  {
    id: "es-long-vlc-1147",
    language: "es",
    question: "¿Qué pasó con la incidencia VLC-1147?",
    expects: answer(
      "exact",
      "es-balance-campana",
      "38 sombrillas llegaron con moho en la lona"
    ),
  },
  {
    id: "es-long-que-salio-bien",
    language: "es",
    question:
      "En el pico del verano, ¿qué cambio en la forma de trabajar le vino mejor al almacén de Valencia?",
    expects: answer(
      "paraphrase",
      "es-balance-campana",
      "agrupar los pedidos por ruta de transporte"
    ),
  },
  {
    id: "es-long-penalizacion-cliente",
    language: "es",
    asker: "camille",
    question:
      "¿Nos penalizó algún cliente por los retrasos de la campaña de verano en Valencia?",
    expects: hidden(
      "es-balance-campana",
      "penalización de 6.750 €",
      "subir dos puntos el rappel"
    ),
  },
  {
    id: "es-long-horas-extra",
    language: "es",
    question: "¿A cuánto se paga la hora extra en el centro de Valencia?",
    expects: absent,
  },
];
