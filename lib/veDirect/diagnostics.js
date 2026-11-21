'use strict';

const DIAGNOSTIC_FRAME_PUBLISH_MS = 30000;

/**
 * @typedef {object} DiagnosticStateDefinition
 * @property {string} id Existing info-channel state ID.
 * @property {ioBroker.StringOrTranslated} name Translated object name.
 * @property {ioBroker.StateCommon['type']} type ioBroker value type.
 * @property {string} role Current ioBroker state role.
 * @property {string|number} def Value representing no event since adapter start.
 * @property {string} [unit] Optional value unit.
 * @property {number} [min] Optional numeric lower bound.
 */

/** @type {ReadonlyArray<DiagnosticStateDefinition>} */
const DIAGNOSTIC_STATES = [
    {
        id: 'info.transport',
        name: {
            en: 'Transport type',
            de: 'Transporttyp',
            ru: 'Тип транспорта',
            pt: 'Tipo de transporte',
            nl: 'Transporttype',
            fr: 'Type de transport',
            it: 'Tipo di trasporto',
            es: 'Tipo de transporte',
            pl: 'Typ transportu',
            uk: 'Тип транспорту',
            'zh-cn': '传输类型',
        },
        type: 'string',
        role: 'text',
        def: '',
    },
    {
        id: 'info.lastValidFrameAt',
        name: {
            en: 'Last valid frame received',
            de: 'Letzter gültiger Frameempfang',
            ru: 'Время последнего допустимого кадра',
            pt: 'Último quadro válido recebido',
            nl: 'Laatste geldige frame ontvangen',
            fr: 'Dernière trame valide reçue',
            it: 'Ultimo frame valido ricevuto',
            es: 'Última trama válida recibida',
            pl: 'Ostatnia prawidłowa ramka',
            uk: 'Час останнього дійсного кадру',
            'zh-cn': '最后有效帧时间',
        },
        type: 'number',
        role: 'value.time',
        def: 0,
        unit: 'ms',
        min: 0,
    },
    {
        id: 'info.reconnectCount',
        name: {
            en: 'Successful reconnects since adapter start',
            de: 'Erfolgreiche Wiederverbindungen seit Adapterstart',
            ru: 'Успешные переподключения с момента запуска адаптера',
            pt: 'Reconexões bem-sucedidas desde o início do adaptador',
            nl: 'Geslaagde herverbindingen sinds adapterstart',
            fr: "Reconnexions réussies depuis le démarrage de l'adaptateur",
            it: "Riconnessioni riuscite dall'avvio dell'adattatore",
            es: 'Reconexiones correctas desde el inicio del adaptador',
            pl: 'Udane ponowne połączenia od uruchomienia adaptera',
            uk: 'Успішні повторні підключення від запуску адаптера',
            'zh-cn': '自适配器启动以来的成功重连次数',
        },
        type: 'number',
        role: 'value',
        def: 0,
        min: 0,
    },
    {
        id: 'info.checksumErrors',
        name: {
            en: 'Checksum errors since adapter start',
            de: 'Prüfsummenfehler seit Adapterstart',
            ru: 'Ошибки контрольной суммы с момента запуска адаптера',
            pt: 'Erros de checksum desde o início do adaptador',
            nl: 'Checksumfouten sinds adapterstart',
            fr: "Erreurs de somme de contrôle depuis le démarrage de l'adaptateur",
            it: "Errori di checksum dall'avvio dell'adattatore",
            es: 'Errores de suma de comprobación desde el inicio del adaptador',
            pl: 'Błędy sum kontrolnych od uruchomienia adaptera',
            uk: 'Помилки контрольної суми від запуску адаптера',
            'zh-cn': '自适配器启动以来的校验和错误数',
        },
        type: 'number',
        role: 'value',
        def: 0,
        min: 0,
    },
    {
        id: 'info.parserErrors',
        name: {
            en: 'Parser errors since adapter start',
            de: 'Parserfehler seit Adapterstart',
            ru: 'Ошибки парсера с момента запуска адаптера',
            pt: 'Erros do analisador desde o início do adaptador',
            nl: 'Parserfouten sinds adapterstart',
            fr: "Erreurs de l'analyseur depuis le démarrage de l'adaptateur",
            it: "Errori del parser dall'avvio dell'adattatore",
            es: 'Errores del analizador desde el inicio del adaptador',
            pl: 'Błędy parsera od uruchomienia adaptera',
            uk: 'Помилки парсера від запуску адаптера',
            'zh-cn': '自适配器启动以来的解析器错误数',
        },
        type: 'number',
        role: 'value',
        def: 0,
        min: 0,
    },
    {
        id: 'info.lastTransportError',
        name: {
            en: 'Last transport error',
            de: 'Letzter Transportfehler',
            ru: 'Последняя ошибка транспорта',
            pt: 'Último erro de transporte',
            nl: 'Laatste transportfout',
            fr: 'Dernière erreur de transport',
            it: 'Ultimo errore di trasporto',
            es: 'Último error de transporte',
            pl: 'Ostatni błąd transportu',
            uk: 'Остання помилка транспорту',
            'zh-cn': '最近传输错误',
        },
        type: 'string',
        role: 'text',
        def: '',
    },
];

module.exports = { DIAGNOSTIC_FRAME_PUBLISH_MS, DIAGNOSTIC_STATES };
