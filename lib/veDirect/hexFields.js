'use strict';

/**
 * Whitelisted VE.Direct HEX register identifiers. The keys are the stable names
 * accepted by encodeRaw() and decodeRaw(); no arbitrary numeric IDs are accepted.
 */
const REGISTER_IDS = Object.freeze({
    capabilities: 0x0140,
    deviceMode: 0x0200,
    deviceState: 0x0201,
    remoteControlUsed: 0x0202,
    networkMode: 0x200e,
    chargeCurrentLimit: 0x2015,
    maxBatteryCurrent: 0xedf0,
    chargeVoltageSetpoint: 0x2001,
});

const CAPABILITY_BITS = Object.freeze({ externalControl: 15 });
const DEVICE_MODE_VALUES = Object.freeze({ offLegacy: 0, on: 1, off: 4 });
const NETWORK_MODES = Object.freeze({ standalone: 0, slave: 3, external: 5, bms: 9, chargeMaster: 0x21 });
const REGISTER_ERROR_FLAGS = Object.freeze({ unknownId: 0x01, notSupported: 0x02, parameterError: 0x04 });

/**
 * @typedef {object} HexField
 * @property {string} name Stable public register name.
 * @property {number} id VE.Direct register identifier.
 * @property {'un8'|'un16'|'un32'} type Unsigned protocol type.
 * @property {1|2|4} bytes Exact payload width in bytes.
 * @property {false} signed Protocol signedness.
 * @property {number} scale Engineering-unit multiplier for one raw count.
 * @property {1|10|100} scaleDivisor Exact decimal divisor used by the codec.
 * @property {string} unit Engineering unit, or an empty string.
 * @property {boolean} readable Whether this expansion stage exposes reads.
 * @property {boolean} writable Whether this expansion stage permits controls.
 * @property {boolean} readOnly Adapter-level read-only guard.
 * @property {string} description Protocol and adapter access documentation.
 * @property {object} [values] Documented enum or bit values.
 * @property {readonly number[]} [writableValues] Raw enum values allowed for control.
 * @property {number} [min] Minimum engineering value accepted for control.
 * @property {number} [max] Maximum engineering value accepted for control.
 */

/**
 * @param {HexField} field Field metadata.
 * @returns {Readonly<HexField>} Immutable field metadata.
 */
function defineField(field) {
    return Object.freeze(field);
}

/** @type {Readonly<Record<string, Readonly<HexField>>>} */
const HEX_FIELDS = Object.freeze(
    Object.assign(Object.create(null), {
        capabilities: defineField({
            name: 'capabilities',
            id: REGISTER_IDS.capabilities,
            type: 'un32',
            bytes: 4,
            signed: false,
            scale: 1,
            scaleDivisor: 1,
            unit: '',
            readable: true,
            writable: false,
            readOnly: true,
            description: 'Capability bit mask; bit 15 indicates external-control support.',
            values: CAPABILITY_BITS,
        }),
        deviceMode: defineField({
            name: 'deviceMode',
            id: REGISTER_IDS.deviceMode,
            type: 'un8',
            bytes: 1,
            signed: false,
            scale: 1,
            scaleDivisor: 1,
            unit: '',
            readable: true,
            writable: true,
            readOnly: false,
            description:
                'Boolean charger control: on is 1; off is encoded as 4. Devices report off as 0 through firmware 1.16 and as 4 from firmware 1.17.',
            values: DEVICE_MODE_VALUES,
        }),
        deviceState: defineField({
            name: 'deviceState',
            id: REGISTER_IDS.deviceState,
            type: 'un8',
            bytes: 1,
            signed: false,
            scale: 1,
            scaleDivisor: 1,
            unit: '',
            readable: true,
            writable: false,
            readOnly: true,
            description: 'Read-only device operating state; the raw un8 state is preserved.',
        }),
        remoteControlUsed: defineField({
            name: 'remoteControlUsed',
            id: REGISTER_IDS.remoteControlUsed,
            type: 'un32',
            bytes: 4,
            signed: false,
            scale: 1,
            scaleDivisor: 1,
            unit: '',
            readable: true,
            writable: false,
            readOnly: true,
            description:
                'Remote-control bit mask. The protocol also defines set semantics, but writes are deliberately not an adapter control in this expansion stage.',
        }),
        networkMode: defineField({
            name: 'networkMode',
            id: REGISTER_IDS.networkMode,
            type: 'un8',
            bytes: 1,
            signed: false,
            scale: 1,
            scaleDivisor: 1,
            unit: '',
            readable: true,
            writable: true,
            readOnly: false,
            description:
                'Network mode. All documented modes decode, including read-only Charge Master (0x21); adapter control is restricted to standalone (0) and external (5).',
            values: NETWORK_MODES,
            writableValues: Object.freeze([NETWORK_MODES.standalone, NETWORK_MODES.external]),
        }),
        chargeCurrentLimit: defineField({
            name: 'chargeCurrentLimit',
            id: REGISTER_IDS.chargeCurrentLimit,
            type: 'un16',
            bytes: 2,
            signed: false,
            scale: 0.1,
            scaleDivisor: 10,
            unit: 'A',
            readable: true,
            writable: true,
            readOnly: false,
            description: 'Non-negative charge current limit in exact 0.1 A steps; 0xFFFF is an unset sentinel.',
            min: 0,
            max: 6553.4,
        }),
        maxBatteryCurrent: defineField({
            name: 'maxBatteryCurrent',
            id: REGISTER_IDS.maxBatteryCurrent,
            type: 'un16',
            bytes: 2,
            signed: false,
            scale: 0.1,
            scaleDivisor: 10,
            unit: 'A',
            readable: true,
            writable: false,
            readOnly: true,
            description: 'Maximum battery current setting in 0.1 A steps; read-only in the adapter.',
            min: 0,
            max: 6553.5,
        }),
        chargeVoltageSetpoint: defineField({
            name: 'chargeVoltageSetpoint',
            id: REGISTER_IDS.chargeVoltageSetpoint,
            type: 'un16',
            bytes: 2,
            signed: false,
            scale: 0.01,
            scaleDivisor: 100,
            unit: 'V',
            readable: true,
            writable: false,
            readOnly: true,
            description:
                'Charge voltage set-point in exact 0.01 V steps; 0xFFFF is an unset sentinel; read-only in this expansion stage.',
            min: 0,
            max: 655.34,
        }),
    }),
);

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

/**
 * @param {string} name Stable register name.
 * @returns {Readonly<HexField>} Field metadata.
 */
function getField(name) {
    if (typeof name !== 'string' || !hasOwn(HEX_FIELDS, name)) {
        throw new RangeError(`Unknown VE.Direct HEX register: ${String(name)}`);
    }
    return HEX_FIELDS[name];
}

/**
 * @param {string} label Value description.
 * @param {unknown} value Candidate number.
 * @returns {number} The validated number.
 */
function finiteNumber(label, value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError(`${label} must be a finite number`);
    }
    return value;
}

/**
 * @param {string} label Value description.
 * @param {unknown} value Candidate unsigned integer.
 * @param {number} maximum Inclusive maximum.
 * @returns {number} The validated integer.
 */
function unsignedInteger(label, value, maximum) {
    const numericValue = finiteNumber(label, value);
    if (!Number.isInteger(numericValue) || numericValue < 0 || numericValue > maximum) {
        throw new RangeError(`${label} must be an unsigned integer in the range 0..${maximum}`);
    }
    return numericValue;
}

/**
 * Convert a finite decimal number to an exact integer number of raw counts.
 * Using its canonical decimal representation avoids both binary floating-point
 * false negatives (for example 2.3 / 0.1) and silent rounding of finer values.
 *
 * @param {string} name Register name.
 * @param {unknown} value Engineering value.
 * @param {Readonly<HexField>} field Field metadata.
 * @returns {number} Exact raw unsigned integer.
 */
function engineeringToRaw(name, value, field) {
    finiteNumber(name, value);
    const numericValue = /** @type {number} */ (value);
    if (numericValue < (field.min ?? 0) || numericValue > (field.max ?? Number.MAX_SAFE_INTEGER)) {
        throw new RangeError(`${name} is outside the range ${field.min ?? 0}..${field.max}`);
    }

    if (field.scaleDivisor === 1) {
        if (!Number.isInteger(numericValue)) {
            throw new RangeError(`${name} must be an integer raw value`);
        }
        return numericValue;
    }

    const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(String(numericValue));
    if (!match) {
        throw new TypeError(`${name} must have a decimal numeric representation`);
    }

    const fraction = match[3] || '';
    const decimalPlaces = field.scaleDivisor === 10 ? 1 : 2;
    const exponent = Number(match[4] || 0) - fraction.length + decimalPlaces;
    const digits = BigInt(`${match[2]}${fraction}`);
    const sign = match[1] === '-' ? -1n : 1n;
    let raw;

    if (exponent >= 0) {
        raw = sign * digits * 10n ** BigInt(exponent);
    } else {
        const divisor = 10n ** BigInt(-exponent);
        if (digits % divisor !== 0n) {
            throw new RangeError(`${name} is not representable in ${field.scale} ${field.unit} steps`);
        }
        raw = (sign * digits) / divisor;
    }

    const maximumRaw = 2 ** (field.bytes * 8) - 1;
    if (raw < 0n || raw > BigInt(maximumRaw)) {
        throw new RangeError(`${name} exceeds its ${field.type} payload`);
    }
    return Number(raw);
}

/**
 * Encode one whitelisted adapter control into its exact little-endian payload.
 * Read-only registers, unknown names, coercion and lossy scaling are rejected.
 *
 * @param {string} name Stable register name.
 * @param {unknown} value Logical value: boolean for deviceMode, raw 0/5 for
 * networkMode, or amperes for chargeCurrentLimit.
 * @returns {Buffer} Exact register value payload, without a HEX frame.
 */
function encodeRaw(name, value) {
    const field = getField(name);
    if (!field.writable) {
        throw new RangeError(`${name} is read-only in this expansion stage`);
    }

    let raw;
    if (name === 'deviceMode') {
        if (typeof value !== 'boolean') {
            throw new TypeError('deviceMode must be a boolean');
        }
        raw = value ? DEVICE_MODE_VALUES.on : DEVICE_MODE_VALUES.off;
    } else if (name === 'networkMode') {
        finiteNumber(name, value);
        if (value !== NETWORK_MODES.standalone && value !== NETWORK_MODES.external) {
            throw new RangeError('networkMode control permits only standalone (0) or external (5)');
        }
        raw = /** @type {number} */ (value);
    } else {
        raw = engineeringToRaw(name, value, field);
    }

    const buffer = Buffer.alloc(field.bytes);
    if (field.type === 'un8') {
        buffer.writeUInt8(raw, 0);
    } else if (field.type === 'un16') {
        buffer.writeUInt16LE(raw, 0);
    } else {
        buffer.writeUInt32LE(raw, 0);
    }
    return buffer;
}

/**
 * @param {number} raw Raw device-mode byte.
 * @returns {boolean} True for on, false for either documented off value.
 */
function decodeDeviceMode(raw) {
    if (raw === DEVICE_MODE_VALUES.on) {
        return true;
    }
    if (raw === DEVICE_MODE_VALUES.offLegacy || raw === DEVICE_MODE_VALUES.off) {
        return false;
    }
    throw new RangeError(`Unknown deviceMode value: ${String(raw)}`);
}

/**
 * @param {number} raw Raw network-mode byte.
 * @returns {'standalone'|'slave'|'external'|'bms'|'chargeMaster'} Stable decoded enum name.
 */
function decodeNetworkMode(raw) {
    switch (raw) {
        case NETWORK_MODES.standalone:
            return 'standalone';
        case NETWORK_MODES.slave:
            return 'slave';
        case NETWORK_MODES.external:
            return 'external';
        case NETWORK_MODES.bms:
            return 'bms';
        case NETWORK_MODES.chargeMaster:
            return 'chargeMaster';
        default:
            throw new RangeError(`Unknown networkMode value: ${String(raw)}`);
    }
}

/**
 * Decode an exact-width little-endian payload for a whitelisted register.
 *
 * @param {string} name Stable register name.
 * @param {Buffer} buffer Register value payload, without frame bytes or flags.
 * @returns {number|boolean|string|null} Raw integer, scaled A/V value, boolean device
 * mode, symbolic network mode, or null for an unset remote setpoint sentinel.
 */
function decodeRaw(name, buffer) {
    const field = getField(name);
    if (!Buffer.isBuffer(buffer)) {
        throw new TypeError(`${name} payload must be a Buffer`);
    }
    if (buffer.length !== field.bytes) {
        throw new RangeError(`${name} payload must be exactly ${field.bytes} bytes, got ${buffer.length}`);
    }

    let raw;
    if (field.type === 'un8') {
        raw = buffer.readUInt8(0);
    } else if (field.type === 'un16') {
        raw = buffer.readUInt16LE(0);
    } else {
        raw = buffer.readUInt32LE(0);
    }

    if (name === 'deviceMode') {
        return decodeDeviceMode(raw);
    }
    if (name === 'networkMode') {
        return decodeNetworkMode(raw);
    }
    if ((name === 'chargeCurrentLimit' || name === 'chargeVoltageSetpoint') && raw === 0xffff) {
        return null;
    }
    return field.scaleDivisor === 1 ? raw : raw / field.scaleDivisor;
}

/**
 * Test the response flags without accepting reserved non-zero flags as success.
 *
 * @param {number} flags Response flag byte.
 * @returns {boolean} True for any non-zero response flags.
 */
function isRegisterError(flags) {
    unsignedInteger('flags', flags, 0xff);
    return flags !== 0;
}

/**
 * @param {number} decodedCapabilities Decoded un32 capability mask.
 * @param {number} bit Zero-based bit index (0..31).
 * @returns {boolean} Whether the selected capability bit is set.
 */
function hasCapability(decodedCapabilities, bit) {
    unsignedInteger('decodedCapabilities', decodedCapabilities, 0xffffffff);
    unsignedInteger('capability bit', bit, 31);
    // Division avoids signed 32-bit bitwise overflow for capability bit 31.
    return Math.floor(decodedCapabilities / 2 ** bit) % 2 === 1;
}

module.exports = {
    REGISTER_IDS,
    HEX_FIELDS,
    CAPABILITY_BITS,
    DEVICE_MODE_VALUES,
    NETWORK_MODES,
    REGISTER_ERROR_FLAGS,
    encodeRaw,
    decodeRaw,
    isRegisterError,
    decodeDeviceMode,
    decodeNetworkMode,
    hasCapability,
};
