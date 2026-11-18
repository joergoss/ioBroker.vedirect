'use strict';

const COLON = 0x3a;
const LF = 0x0a;
const CR = 0x0d;
const CHECKSUM_TARGET = 0x55;

const ERROR_FLAGS = Object.freeze({
    UNKNOWN_ID: 0x01,
    NOT_SUPPORTED: 0x02,
    PARAMETER_ERROR: 0x04,
});
const KNOWN_ERROR_MASK = ERROR_FLAGS.UNKNOWN_ID | ERROR_FLAGS.NOT_SUPPORTED | ERROR_FLAGS.PARAMETER_ERROR;

/** @type {Readonly<Record<number, 'done'|'unknown'|'error'|'ping'>>} */
const RESPONSE_TYPES = Object.freeze({
    0x1: 'done',
    0x3: 'unknown',
    0x4: 'error',
    0x5: 'ping',
});

/**
 * @typedef {object} DecodedFrame
 * @property {number} command Command/response nibble.
 * @property {Buffer} payload Payload without command or checksum.
 * @property {number} checksum Received checksum byte.
 * @property {'get'|'set'|'async'|'general'} type Syntactic frame category.
 * @property {'done'|'unknown'|'error'|'ping'|null} responseType Response opcode name, if defined.
 * @property {number} [registerId] Decoded little-endian uint16 register ID.
 * @property {number} [flags] Raw register flags byte.
 * @property {Buffer} [rawValue] Uninterpreted register value bytes.
 * @property {{unknownId: boolean, notSupported: boolean, parameterError: boolean}} [errors] Decoded error bits.
 * @property {number} [unknownFlagBits] Reserved/non-error flag bits.
 */

function invalidFrame(message) {
    return new Error(`Invalid VE.Direct HEX frame: ${message}`);
}

function assertCommand(command) {
    if (!Number.isInteger(command) || command < 0 || command > 0x0f) {
        throw new RangeError('VE.Direct HEX command must be an integer nibble (0x0..0xF)');
    }
}

function assertRegisterId(registerId) {
    if (!Number.isInteger(registerId) || registerId < 0 || registerId > 0xffff) {
        throw new RangeError('VE.Direct HEX registerId must be an integer uint16 (0x0000..0xFFFF)');
    }
}

function calculateChecksum(command, payload) {
    let sum = command;
    for (const byte of payload) {
        // Keep the accumulator bounded even for large history/string payloads.
        sum = (sum + byte) & 0xff;
    }
    return (CHECKSUM_TARGET - sum) & 0xff;
}

/**
 * Encode a complete VE.Direct HEX frame. The command occupies one ASCII hex
 * nibble; payload and checksum bytes occupy two uppercase hex digits each.
 * Command-specific payload semantics belong to the caller or a helper below.
 *
 * @param {number} command Command/response nibble (0x0..0xF).
 * @param {Buffer} [payloadBuffer] Already byte-encoded payload.
 * @returns {Buffer} Complete `:...[Checksum]\n` frame.
 */
function encodeRequest(command, payloadBuffer = Buffer.alloc(0)) {
    assertCommand(command);
    if (!Buffer.isBuffer(payloadBuffer)) {
        throw new TypeError('VE.Direct HEX payload must be a Buffer');
    }

    const checksum = calculateChecksum(command, payloadBuffer);
    const commandHex = command.toString(16).toUpperCase();
    const payloadHex = payloadBuffer.toString('hex').toUpperCase();
    const checksumHex = checksum.toString(16).padStart(2, '0').toUpperCase();
    return Buffer.from(`:${commandHex}${payloadHex}${checksumHex}\n`, 'ascii');
}

/**
 * Encode a Get request (`uint16 id` little-endian, zero flags).
 *
 * @param {number} registerId Register ID (0x0000..0xFFFF).
 * @returns {Buffer} Complete Get request frame.
 */
function encodeGet(registerId) {
    assertRegisterId(registerId);
    return encodeRequest(0x7, Buffer.from([registerId & 0xff, registerId >>> 8, 0]));
}

/**
 * Encode a scalar Set request. The caller supplies the raw little-endian value;
 * this helper deliberately accepts only the common scalar widths of 1..4 bytes.
 * Wider command-specific structures can be passed to encodeRequest directly.
 *
 * @param {number} registerId Register ID (0x0000..0xFFFF).
 * @param {Buffer} rawValueBuffer Raw, already little-endian scalar value.
 * @returns {Buffer} Complete Set request frame.
 */
function encodeSet(registerId, rawValueBuffer) {
    assertRegisterId(registerId);
    if (!Buffer.isBuffer(rawValueBuffer)) {
        throw new TypeError('VE.Direct HEX raw value must be a Buffer');
    }
    if (rawValueBuffer.length < 1 || rawValueBuffer.length > 4) {
        throw new RangeError('VE.Direct HEX scalar Set value must contain 1..4 bytes');
    }

    const payload = Buffer.concat([Buffer.from([registerId & 0xff, registerId >>> 8, 0]), rawValueBuffer]);
    return encodeRequest(0x8, payload);
}

function hexNibble(byte) {
    if (byte >= 0x30 && byte <= 0x39) {
        return byte - 0x30;
    }
    if (byte >= 0x41 && byte <= 0x46) {
        return byte - 0x41 + 10;
    }
    return -1;
}

/**
 * Decode and validate one complete VE.Direct HEX frame.
 *
 * The returned `type` is `get`, `set`, `async`, or `general`. For Get/Set/Async,
 * `registerId`, `flags`, `rawValue`, decoded `errors`, and `unknownFlagBits` are
 * present. `responseType` names response opcodes Done/Unknown/Error/Ping and is
 * otherwise null. Request and response opcodes overlap (and Set requests and
 * responses have the same layout), so no unsupported direction guess is made.
 *
 * Register values remain byte strings. Although scalar Set encoding is limited
 * to 1..4 bytes, decoding permits empty and wider values as required for error
 * indications, strings, and the specification's 19/34-byte history records.
 *
 * @param {Buffer} buffer One complete frame, including colon and final LF.
 * @returns {DecodedFrame} Structured decoded frame.
 */
function decodeFrame(buffer) {
    if (!Buffer.isBuffer(buffer)) {
        throw new TypeError('VE.Direct HEX frame must be a Buffer');
    }
    if (buffer.length < 5) {
        throw invalidFrame('minimum length is five bytes');
    }
    if (buffer[0] !== COLON) {
        throw invalidFrame('frame must start with a colon');
    }

    const firstLf = buffer.indexOf(LF);
    if (buffer[buffer.length - 1] !== LF || firstLf !== buffer.length - 1) {
        throw invalidFrame('LF must occur exactly once, at the end');
    }
    if (buffer.indexOf(CR) !== -1) {
        throw invalidFrame('CR and other whitespace are not allowed');
    }

    // One command nibble plus complete payload/checksum bytes means an odd
    // number of hex characters overall. The data after the command is even.
    const bodyLength = buffer.length - 2;
    if (bodyLength < 3) {
        throw invalidFrame('command nibble and checksum byte are required');
    }
    if ((bodyLength - 1) % 2 !== 0) {
        throw invalidFrame('hex data after the command must contain complete bytes');
    }

    for (let index = 1; index <= bodyLength; index++) {
        if (hexNibble(buffer[index]) === -1) {
            throw invalidFrame('only uppercase ASCII hexadecimal characters and no whitespace are allowed');
        }
    }

    const command = hexNibble(buffer[1]);
    const dataLength = (bodyLength - 1) / 2;
    const dataWithChecksum = Buffer.alloc(dataLength);
    for (let index = 0; index < dataLength; index++) {
        const offset = 2 + index * 2;
        const high = hexNibble(buffer[offset]);
        const low = hexNibble(buffer[offset + 1]);
        dataWithChecksum[index] = (high << 4) | low;
    }

    let sum = command;
    for (const byte of dataWithChecksum) {
        sum = (sum + byte) & 0xff;
    }
    if (sum !== CHECKSUM_TARGET) {
        throw invalidFrame(`checksum sum is 0x${sum.toString(16).padStart(2, '0').toUpperCase()}, expected 0x55`);
    }

    const checksum = dataWithChecksum[dataWithChecksum.length - 1];
    const payload = Buffer.from(dataWithChecksum.subarray(0, dataWithChecksum.length - 1));
    /** @type {DecodedFrame} */
    const result = {
        command,
        payload,
        checksum,
        type: 'general',
        responseType: RESPONSE_TYPES[command] || null,
    };

    if (command !== 0x7 && command !== 0x8 && command !== 0x0a) {
        return result;
    }
    if (payload.length < 3) {
        throw invalidFrame('Get/Set/Async payload requires uint16 register ID and one flags byte');
    }

    const flags = payload[2];
    result.type = command === 0x7 ? 'get' : command === 0x8 ? 'set' : 'async';
    result.registerId = payload[0] | (payload[1] << 8);
    result.flags = flags;
    result.rawValue = Buffer.from(payload.subarray(3));
    result.errors = {
        unknownId: (flags & ERROR_FLAGS.UNKNOWN_ID) !== 0,
        notSupported: (flags & ERROR_FLAGS.NOT_SUPPORTED) !== 0,
        parameterError: (flags & ERROR_FLAGS.PARAMETER_ERROR) !== 0,
    };
    result.unknownFlagBits = flags & ~KNOWN_ERROR_MASK & 0xff;
    return result;
}

module.exports = {
    ERROR_FLAGS,
    encodeRequest,
    encodeGet,
    encodeSet,
    decodeFrame,
};
