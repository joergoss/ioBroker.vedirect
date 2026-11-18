'use strict';

const { expect } = require('chai');
const { ERROR_FLAGS, encodeRequest, encodeGet, encodeSet, decodeFrame } = require('./lib/veDirect/hexProtocol.js');

// Independent test-side reference. Official examples below are fixed literals;
// this helper is used only to construct additional valid and malformed vectors.
function referenceFrame(command, payload = []) {
    const payloadBuffer = Buffer.from(payload);
    let sum = command;
    for (const byte of payloadBuffer) {
        sum = (sum + byte) & 0xff;
    }
    const checksum = (0x55 - sum) & 0xff;
    return Buffer.from(
        `:${command.toString(16).toUpperCase()}${payloadBuffer.toString('hex').toUpperCase()}${checksum
            .toString(16)
            .padStart(2, '0')
            .toUpperCase()}\n`,
        'ascii',
    );
}

function registerPayload(registerId, flags, rawValue = []) {
    return [registerId & 0xff, registerId >>> 8, flags, ...rawValue];
}

let randomState = 0x00c0ffee;
function randomUint32() {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState;
}

function randomBuffer(length) {
    const result = Buffer.alloc(length);
    for (let index = 0; index < length; index++) {
        result[index] = randomUint32() & 0xff;
    }
    return result;
}

const officialFixtures = [
    { name: 'Ping request', command: 0x1, payload: [], ascii: ':154\n' },
    { name: 'Ping response', command: 0x5, payload: [0x16, 0x41], ascii: ':51641F9\n' },
    { name: 'Application version request', command: 0x3, payload: [], ascii: ':352\n' },
    { name: 'Application version Done', command: 0x1, payload: [0x16, 0x41], ascii: ':11641FD\n' },
    { name: 'Product ID request', command: 0x4, payload: [], ascii: ':451\n' },
    { name: 'Product ID Done', command: 0x1, payload: [0x00, 0x03], ascii: ':1000351\n' },
    { name: 'Restart request', command: 0x6, payload: [], ascii: ':64F\n' },
    {
        name: 'Get Battery Maximum Current request',
        command: 0x7,
        payload: [0xf0, 0xed, 0x00],
        ascii: ':7F0ED0071\n',
    },
    {
        name: 'Get Battery Maximum Current response',
        command: 0x7,
        payload: [0xf0, 0xed, 0x00, 0x96, 0x00],
        ascii: ':7F0ED009600DB\n',
    },
    {
        name: 'Set Battery Maximum Current request and acknowledgement',
        command: 0x8,
        payload: [0xf0, 0xed, 0x00, 0x64, 0x00],
        ascii: ':8F0ED0064000C\n',
    },
    { name: 'Unsupported command request', command: 0x2, payload: [], ascii: ':253\n' },
    { name: 'Unknown response', command: 0x3, payload: [0x02, 0x00], ascii: ':3020050\n' },
    { name: 'Error response', command: 0x4, payload: [0xaa, 0xaa], ascii: ':4AAAAFD\n' },
    {
        name: 'Async device state',
        command: 0xa,
        payload: [0x01, 0x02, 0x00, 0x05],
        ascii: ':A0102000543\n',
    },
];

describe('VE.Direct HEX protocol codec (BlueSolar/SmartSolar Rev18)', () => {
    describe('official independent fixtures', () => {
        for (const fixture of officialFixtures) {
            it(`reproduces and decodes ${fixture.name}`, () => {
                const expected = Buffer.from(fixture.ascii, 'ascii');
                const payload = Buffer.from(fixture.payload);
                const encoded = encodeRequest(fixture.command, payload);
                expect(encoded).to.deep.equal(expected);
                expect(encoded.toString('ascii')).to.match(/^:[0-9A-F]+\n$/);

                const decoded = decodeFrame(expected);
                const expectedChecksum = Number.parseInt(fixture.ascii.slice(-3, -1), 16);
                expect(decoded.command).to.equal(fixture.command);
                expect(decoded.payload).to.deep.equal(payload);
                expect(decoded.checksum).to.equal(expectedChecksum);
                const sum = [fixture.command, ...fixture.payload, decoded.checksum].reduce(
                    (total, byte) => (total + byte) & 0xff,
                    0,
                );
                expect(sum).to.equal(0x55);
            });
        }

        it("rejects the specification's deliberately invalid checksum frame :452", () => {
            expect(() => decodeFrame(Buffer.from(':452\n', 'ascii'))).to.throw(/checksum sum/);
        });

        it('uses the exact official Get request and 15.0 A response bytes', () => {
            expect(encodeGet(0xedf0)).to.deep.equal(Buffer.from(':7F0ED0071\n', 'ascii'));
            const decoded = decodeFrame(Buffer.from(':7F0ED009600DB\n', 'ascii'));
            expect(decoded).to.include({ command: 0x7, type: 'get', registerId: 0xedf0, flags: 0 });
            expect(decoded.rawValue).to.deep.equal(Buffer.from([0x96, 0x00]));
            expect(decoded.rawValue.readUInt16LE(0)).to.equal(150);
        });

        it('uses the exact official scalar Set request/acknowledgement bytes', () => {
            const frame = encodeSet(0xedf0, Buffer.from([0x64, 0x00]));
            expect(frame).to.deep.equal(Buffer.from(':8F0ED0064000C\n', 'ascii'));
            const decoded = decodeFrame(frame);
            expect(decoded).to.include({ command: 0x8, type: 'set', registerId: 0xedf0, flags: 0 });
            expect(decoded.rawValue).to.deep.equal(Buffer.from([0x64, 0x00]));
        });
    });

    describe('encoding', () => {
        it('encodes an omitted payload exactly like an empty Buffer', () => {
            expect(encodeRequest(0x1)).to.deep.equal(Buffer.from(':154\n', 'ascii'));
            expect(encodeRequest(0x1, Buffer.alloc(0))).to.deep.equal(encodeRequest(0x1));
        });

        it('encodes register IDs little-endian at uint16 boundaries', () => {
            for (const registerId of [0x0000, 0x0001, 0x00ff, 0x0100, 0x1234, 0xabcd, 0xfffe, 0xffff]) {
                const get = encodeGet(registerId);
                expect(get).to.deep.equal(referenceFrame(0x7, registerPayload(registerId, 0)));
                expect(decodeFrame(get).registerId).to.equal(registerId);

                const set = encodeSet(registerId, Buffer.from([0xa5]));
                expect(set).to.deep.equal(referenceFrame(0x8, registerPayload(registerId, 0, [0xa5])));
                expect(decodeFrame(set).registerId).to.equal(registerId);
            }
        });

        it('preserves caller-encoded little-endian values of every scalar width', () => {
            const values = [[0x80], [0x78, 0x56], [0x56, 0x34, 0x12], [0x78, 0x56, 0x34, 0x12]];
            for (const value of values) {
                const frame = encodeSet(0x1234, Buffer.from(value));
                expect(frame).to.deep.equal(referenceFrame(0x8, [0x34, 0x12, 0x00, ...value]));
                expect(decodeFrame(frame).rawValue).to.deep.equal(Buffer.from(value));
            }
        });

        it('does not mutate or retain the caller payload', () => {
            const payload = Buffer.from([0x01, 0x02, 0x03]);
            const original = Buffer.from(payload);
            const frame = encodeRequest(0x2, payload);
            expect(payload).to.deep.equal(original);
            payload.fill(0xff);
            expect(decodeFrame(frame).payload).to.deep.equal(original);
        });

        it('rejects every invalid command nibble without truncation or coercion', () => {
            const invalidCommands = [
                -1,
                16,
                255,
                1.5,
                Number.NaN,
                Number.POSITIVE_INFINITY,
                Number.NEGATIVE_INFINITY,
                Number.MAX_SAFE_INTEGER,
                '7',
                null,
                undefined,
                true,
                7n,
                {},
            ];
            for (const command of invalidCommands) {
                expect(() => encodeRequest(command, Buffer.alloc(0)), String(command)).to.throw(RangeError);
            }
        });

        it('rejects non-Buffer generic payloads', () => {
            for (const payload of ['00', [0], new Uint8Array([0]), null, 0, {}, true]) {
                expect(() => encodeRequest(0x2, payload)).to.throw(TypeError, /payload must be a Buffer/);
            }
        });

        it('rejects invalid register IDs in both Get and Set without wrapping', () => {
            const invalidIds = [
                -1,
                0x10000,
                0xffffffff,
                1.5,
                Number.NaN,
                Number.POSITIVE_INFINITY,
                Number.NEGATIVE_INFINITY,
                Number.MAX_SAFE_INTEGER,
                '0xEDF0',
                null,
                undefined,
                false,
                1n,
                {},
            ];
            for (const registerId of invalidIds) {
                expect(() => encodeGet(registerId), String(registerId)).to.throw(RangeError);
                expect(() => encodeSet(registerId, Buffer.from([0])), String(registerId)).to.throw(RangeError);
            }
        });

        it('rejects non-Buffer Set values', () => {
            for (const value of ['01', [1], new Uint8Array([1]), null, undefined, 1, {}, false]) {
                expect(() => encodeSet(0x1234, value)).to.throw(TypeError, /raw value must be a Buffer/);
            }
        });

        it('limits the scalar Set helper to exactly 1..4 value bytes', () => {
            for (const length of [0, 5, 6, 19, 34, 255]) {
                expect(() => encodeSet(0x1234, Buffer.alloc(length)), `length ${length}`).to.throw(
                    RangeError,
                    /1\.\.4 bytes/,
                );
            }
            for (const length of [1, 2, 3, 4]) {
                expect(() => encodeSet(0x1234, Buffer.alloc(length))).not.to.throw();
            }
        });
    });

    describe('decoded structure and response distinctions', () => {
        it('classifies Done, Unknown, Error and Ping as general responses', () => {
            const responses = [
                { ascii: ':11641FD\n', command: 0x1, responseType: 'done', payload: [0x16, 0x41] },
                { ascii: ':1000351\n', command: 0x1, responseType: 'done', payload: [0x00, 0x03] },
                { ascii: ':3020050\n', command: 0x3, responseType: 'unknown', payload: [0x02, 0x00] },
                { ascii: ':4AAAAFD\n', command: 0x4, responseType: 'error', payload: [0xaa, 0xaa] },
                { ascii: ':51641F9\n', command: 0x5, responseType: 'ping', payload: [0x16, 0x41] },
            ];
            for (const response of responses) {
                const decoded = decodeFrame(Buffer.from(response.ascii, 'ascii'));
                expect(decoded).to.include({
                    command: response.command,
                    type: 'general',
                    responseType: response.responseType,
                });
                expect(decoded.payload).to.deep.equal(Buffer.from(response.payload));
                expect(decoded).not.to.have.ownProperty('registerId');
                expect(decoded).not.to.have.ownProperty('flags');
                expect(decoded).not.to.have.ownProperty('rawValue');
                expect(decoded).not.to.have.ownProperty('errors');
            }
        });

        it('does not reinterpret a general Done payload resembling a register header', () => {
            const decoded = decodeFrame(referenceFrame(0x1, [0x01, 0x02, 0x00, 0x05]));
            expect(decoded).to.include({ type: 'general', responseType: 'done' });
            expect(decoded).not.to.have.ownProperty('registerId');
            expect(decoded).not.to.have.ownProperty('rawValue');
        });

        it('distinguishes :A asynchronous data from Get, Set and general responses', () => {
            const decoded = decodeFrame(Buffer.from(':A0102000543\n', 'ascii'));
            expect(decoded).to.include({
                command: 0x0a,
                type: 'async',
                responseType: null,
                registerId: 0x0201,
                flags: 0,
                unknownFlagBits: 0,
            });
            expect(decoded.rawValue).to.deep.equal(Buffer.from([0x05]));
            expect(decoded.errors).to.deep.equal({
                unknownId: false,
                notSupported: false,
                parameterError: false,
            });
        });

        it('leaves reserved and request-only opcodes general without inventing response names', () => {
            for (const command of [0x0, 0x2, 0x6, 0x9, 0xb, 0xc, 0xd, 0xe, 0xf]) {
                const decoded = decodeFrame(referenceFrame(command));
                expect(decoded).to.include({ command, type: 'general', responseType: null });
                expect(decoded.payload).to.have.length(0);
            }
        });

        it('exports stable error bit constants', () => {
            expect(ERROR_FLAGS).to.deep.equal({
                UNKNOWN_ID: 0x01,
                NOT_SUPPORTED: 0x02,
                PARAMETER_ERROR: 0x04,
            });
            expect(Object.isFrozen(ERROR_FLAGS)).to.equal(true);
        });
    });

    describe('register values and flags', () => {
        it('decodes every combination of all eight flags bits for Get, Set and Async', () => {
            for (const command of [0x7, 0x8, 0xa]) {
                for (let flags = 0; flags <= 0xff; flags++) {
                    const decoded = decodeFrame(referenceFrame(command, registerPayload(0xbeef, flags, [0x5a])));
                    expect(decoded.flags, `command ${command}, flags ${flags}`).to.equal(flags);
                    expect(decoded.errors).to.deep.equal({
                        unknownId: (flags & 0x01) !== 0,
                        notSupported: (flags & 0x02) !== 0,
                        parameterError: (flags & 0x04) !== 0,
                    });
                    expect(decoded.unknownFlagBits).to.equal(flags & 0xf8);
                    expect(decoded.registerId).to.equal(0xbeef);
                    expect(decoded.rawValue).to.deep.equal(Buffer.from([0x5a]));
                }
            }
        });

        it('exposes each named error independently and in combination', () => {
            const cases = [
                [0x01, { unknownId: true, notSupported: false, parameterError: false }],
                [0x02, { unknownId: false, notSupported: true, parameterError: false }],
                [0x04, { unknownId: false, notSupported: false, parameterError: true }],
                [0x07, { unknownId: true, notSupported: true, parameterError: true }],
            ];
            for (const [flags, errors] of cases) {
                const decoded = decodeFrame(referenceFrame(0x7, registerPayload(0x1000, flags, [0xff])));
                expect(decoded.errors).to.deep.equal(errors);
                expect(decoded.unknownFlagBits).to.equal(0);
            }
        });

        it('retains undefined high flag bits separately from known errors', () => {
            for (const flags of [0x08, 0x10, 0x20, 0x40, 0x80, 0xf8, 0xff]) {
                const decoded = decodeFrame(referenceFrame(0x8, registerPayload(0x1234, flags, [0x01])));
                expect(decoded.unknownFlagBits).to.equal(flags & 0xf8);
            }
        });

        it('accepts empty register values where framing alone cannot exclude them', () => {
            for (const command of [0x7, 0x8, 0xa]) {
                for (const flags of [0x00, 0x01, 0x02, 0x04, 0xff]) {
                    const decoded = decodeFrame(referenceFrame(command, registerPayload(0x1050, flags)));
                    expect(decoded.registerId).to.equal(0x1050);
                    expect(decoded.flags).to.equal(flags);
                    expect(decoded.rawValue).to.deep.equal(Buffer.alloc(0));
                    expect(decoded.payload).to.have.length(3);
                }
            }
        });

        it('accepts variable values including 19/34-byte history records and wider strings', () => {
            for (const command of [0x7, 0x8, 0xa]) {
                for (const length of [0, 1, 2, 3, 4, 5, 16, 19, 34, 64, 255]) {
                    const rawValue = randomBuffer(length);
                    const decoded = decodeFrame(referenceFrame(command, registerPayload(0x104f, 0, rawValue)));
                    expect(decoded.rawValue, `command ${command}, length ${length}`).to.deep.equal(rawValue);
                    expect(decoded.payload).to.have.length(length + 3);
                }
            }
        });

        it('consumes the complete value without numeric conversion or partial parsing', () => {
            const rawValue = Buffer.from([0x00, 0xff, 0x80, 0x7f, 0xde, 0xad, 0xbe, 0xef, 0x00]);
            const decoded = decodeFrame(referenceFrame(0x7, registerPayload(0xffff, 0, rawValue)));
            expect(decoded.registerId).to.equal(0xffff);
            expect(decoded.rawValue).to.deep.equal(rawValue);
            expect(decoded.rawValue).to.have.length(rawValue.length);
        });

        it('returns owned payload/value buffers rather than aliases into the input', () => {
            const frame = referenceFrame(0x7, registerPayload(0x1234, 0, [0x78, 0x56]));
            const decoded = decodeFrame(frame);
            frame.fill(0x30);
            expect(decoded.payload).to.deep.equal(Buffer.from([0x34, 0x12, 0x00, 0x78, 0x56]));
            expect(decoded.rawValue).to.deep.equal(Buffer.from([0x78, 0x56]));

            decoded.rawValue[0] = 0;
            expect(decoded.payload[3]).to.equal(0x78);
        });
    });

    describe('strict complete-frame validation', () => {
        it('requires a real Buffer, not a string, array or Uint8Array', () => {
            for (const input of [':154\n', [0x3a], new Uint8Array([0x3a]), null, undefined, 0, {}, true]) {
                expect(() => decodeFrame(input)).to.throw(TypeError, /frame must be a Buffer/);
            }
        });

        it('rejects empty and undersized buffers', () => {
            for (const input of ['', ':', ':\n', ':1\n', ':15\n']) {
                expect(() => decodeFrame(Buffer.from(input, 'ascii')), JSON.stringify(input)).to.throw(
                    /minimum length|command nibble/,
                );
            }
        });

        it('requires a colon at byte zero', () => {
            for (const input of ['X154\n', '1540\n', ';154\n', ' 154\n', '\t154\n']) {
                expect(() => decodeFrame(Buffer.from(input, 'ascii'))).to.throw(/start with a colon/);
            }
        });

        it('requires LF exactly once and at the final byte', () => {
            const malformed = [
                ':154X',
                ':154\r',
                ':154\nX',
                ':154\n\n',
                ':15\n4\n',
                ':154\n:451\n',
                Buffer.concat([Buffer.from(':154\n', 'ascii'), Buffer.alloc(1)]),
            ];
            for (const input of malformed) {
                expect(() => decodeFrame(Buffer.isBuffer(input) ? input : Buffer.from(input, 'binary'))).to.throw(
                    /LF must occur exactly once/,
                );
            }
        });

        it('rejects CR, spaces, tabs and all other whitespace rather than trimming', () => {
            const malformed = [
                ':154\r\n',
                ':\r154\n',
                ':1 4\n',
                ':1\t4\n',
                ':1\v4\n',
                ':1\f4\n',
                ':154 \n',
                ': 154\n',
                ':154\u00a0\n',
            ];
            for (const input of malformed) {
                expect(() => decodeFrame(Buffer.from(input, 'utf8')), JSON.stringify(input)).to.throw(
                    /whitespace|uppercase ASCII|complete bytes/,
                );
            }
        });

        it('rejects lowercase command, payload and checksum characters', () => {
            const malformed = [':a0102000543\n', ':7f0ED0071\n', ':7F0eD0071\n', ':7F0ED009600Db\n'];
            for (const input of malformed) {
                expect(() => decodeFrame(Buffer.from(input, 'ascii')), input).to.throw(/uppercase ASCII/);
            }
        });

        it('rejects non-hex, non-ASCII, embedded colon and NUL characters', () => {
            const malformed = [
                Buffer.from(':1G4\n', 'ascii'),
                Buffer.from(':1?4\n', 'ascii'),
                Buffer.from(':1:4\n', 'ascii'),
                Buffer.from([0x3a, 0x31, 0xc1, 0x34, 0x0a]),
                Buffer.from([0x3a, 0x31, 0x00, 0x34, 0x0a]),
                Buffer.from([0x3a, 0x31, 0xff, 0x34, 0x0a]),
            ];
            for (const input of malformed) {
                expect(() => decodeFrame(input)).to.throw(/uppercase ASCII/);
            }
        });

        it('requires an even number of hex digits after the one-nibble command', () => {
            for (const input of [':7000\n', ':7ABC00\n', ':A000\n', ':1000\n']) {
                expect(() => decodeFrame(Buffer.from(input, 'ascii')), input).to.throw(/complete bytes/);
            }
        });

        it('rejects checksum mismatch even when all characters and lengths are valid', () => {
            for (const input of [':155\n', ':452\n', ':7F0ED0070\n', ':A0102000542\n']) {
                expect(() => decodeFrame(Buffer.from(input, 'ascii')), input).to.throw(/checksum sum/);
            }
        });

        it('rejects short Get, Set and Async register headers after checksum validation', () => {
            for (const command of [0x7, 0x8, 0xa]) {
                for (const payload of [[], [0x01], [0x01, 0x02]]) {
                    expect(() => decodeFrame(referenceFrame(command, payload))).to.throw(/requires uint16 register ID/);
                }
            }
        });

        it('never returns a partial result for valid prefixes or concatenated frames', () => {
            const valid = Buffer.from(':7F0ED009600DB\n', 'ascii');
            for (let length = 0; length < valid.length; length++) {
                expect(() => decodeFrame(valid.subarray(0, length)), `prefix ${length}`).to.throw();
            }
            expect(() => decodeFrame(Buffer.concat([valid, valid]))).to.throw(/LF must occur exactly once/);
            expect(() => decodeFrame(Buffer.concat([valid, Buffer.from('junk')]))).to.throw(
                /LF must occur exactly once/,
            );
        });
    });

    describe('checksum and randomized round trips', () => {
        it('generates and verifies every possible checksum byte exactly once', () => {
            const checksums = new Set();
            for (let payload = 0; payload <= 0xff; payload++) {
                const decoded = decodeFrame(encodeRequest(0x2, Buffer.from([payload])));
                checksums.add(decoded.checksum);
                expect(decoded.checksum).to.be.within(0, 255);
                expect((0x2 + payload + decoded.checksum) & 0xff).to.equal(0x55);
            }
            expect(checksums.size).to.equal(256);
            for (let checksum = 0; checksum <= 0xff; checksum++) {
                expect(checksums.has(checksum)).to.equal(true);
            }
        });

        it('round-trips 1,000 deterministic random generic payloads against the reference', () => {
            const commands = [0x2, 0x9, 0xb, 0xc, 0xd, 0xe, 0xf];
            for (let iteration = 0; iteration < 1000; iteration++) {
                const command = commands[randomUint32() % commands.length];
                const payload = randomBuffer(randomUint32() % 65);
                const frame = encodeRequest(command, payload);
                expect(frame).to.deep.equal(referenceFrame(command, payload));
                expect(frame.toString('ascii')).to.match(/^:[0-9A-F]+\n$/);
                expect((frame.length - 3) % 2).to.equal(0);

                const decoded = decodeFrame(frame);
                expect(decoded.command).to.equal(command);
                expect(decoded.payload).to.deep.equal(payload);
                expect(decoded.type).to.equal('general');
                expect(decoded.responseType).to.equal(null);
                expect(Number.isInteger(decoded.command)).to.equal(true);
                expect(Number.isInteger(decoded.checksum)).to.equal(true);
            }
        });

        it('round-trips random IDs, flags and variable values for Get, Set and Async', () => {
            for (const command of [0x7, 0x8, 0xa]) {
                for (let iteration = 0; iteration < 400; iteration++) {
                    const registerId = randomUint32() & 0xffff;
                    const flags = randomUint32() & 0xff;
                    const rawValue = randomBuffer(randomUint32() % 49);
                    const payload = Buffer.from(registerPayload(registerId, flags, rawValue));
                    const decoded = decodeFrame(referenceFrame(command, payload));
                    expect(decoded.command).to.equal(command);
                    expect(decoded.registerId).to.equal(registerId);
                    expect(decoded.flags).to.equal(flags);
                    expect(decoded.payload).to.deep.equal(payload);
                    expect(decoded.rawValue).to.deep.equal(rawValue);
                    expect(Number.isSafeInteger(decoded.registerId)).to.equal(true);
                    expect(decoded.registerId).to.be.within(0, 0xffff);
                    expect(decoded.flags).to.be.within(0, 0xff);
                    expect(Number.isFinite(decoded.checksum)).to.equal(true);
                }
            }
        });

        it('keeps checksum arithmetic bounded and exact for a 64 KiB payload', () => {
            const payload = Buffer.allocUnsafe(0x10000);
            for (let index = 0; index < payload.length; index++) {
                payload[index] = index & 0xff;
            }
            const frame = encodeRequest(0x2, payload);
            const decoded = decodeFrame(frame);
            expect(decoded.payload).to.deep.equal(payload);
            expect(decoded.checksum).to.be.within(0, 255);
            expect(
                (0x2 + decoded.payload.reduce((sum, byte) => (sum + byte) & 0xff, 0) + decoded.checksum) & 0xff,
            ).to.equal(0x55);
        });

        it('accepts payloads containing every byte value without escaping', () => {
            const payload = Buffer.from(Array.from({ length: 256 }, (_unused, index) => index));
            const frame = encodeRequest(0x2, payload);
            expect(frame.toString('ascii')).to.match(/^:[0-9A-F]+\n$/);
            expect(decodeFrame(frame).payload).to.deep.equal(payload);
        });
    });
});
