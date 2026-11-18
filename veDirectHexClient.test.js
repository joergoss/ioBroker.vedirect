'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const { VeDirectHexClient } = require('./lib/veDirectHexClient');
const { encodeRequest, encodeGet, encodeSet, decodeFrame } = require('./lib/veDirect/hexProtocol');
const { REGISTER_IDS, encodeRaw } = require('./lib/veDirect/hexFields');

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function immediate() {
    return new Promise(resolve => setImmediate(resolve));
}

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

class FakeCom {
    constructor() {
        this.sessionId = 1;
        this.writes = [];
        this.closeCalls = 0;
        this.writeHook = undefined;
        this.closeHook = undefined;
        this.onHexMessage = undefined;
        this.onPortClosed = undefined;
    }

    writeAndDrain(buffer) {
        const bytes = Buffer.from(buffer);
        this.writes.push(bytes);
        return this.writeHook ? this.writeHook(bytes, this.writes.length, this) : Promise.resolve();
    }

    close() {
        this.closeCalls++;
        return this.closeHook ? this.closeHook(this) : Promise.resolve();
    }

    emit(frame) {
        expect(this.onHexMessage, 'HEX callback installed').to.be.a('function');
        this.onHexMessage(Buffer.from(frame));
    }

    portClosed(error = new Error('fake port closed')) {
        this.sessionId++;
        expect(this.onPortClosed, 'close callback installed').to.be.a('function');
        this.onPortClosed(error);
    }
}

function registerFrame(command, name, rawValue, flags = 0, registerId = REGISTER_IDS[name]) {
    const raw = Buffer.from(rawValue);
    const payload = Buffer.concat([Buffer.from([registerId & 0xff, registerId >>> 8, flags]), raw]);
    return encodeRequest(command, payload);
}

function getResponse(name, rawValue, flags = 0, registerId = REGISTER_IDS[name]) {
    return registerFrame(0x7, name, rawValue, flags, registerId);
}

function setResponse(name, rawValue, flags = 0, registerId = REGISTER_IDS[name]) {
    return registerFrame(0x8, name, rawValue, flags, registerId);
}

function invalidChecksum(frame) {
    const result = Buffer.from(frame);
    const offset = result.length - 2;
    result[offset] = result[offset] === 0x30 ? 0x31 : 0x30;
    return result;
}

async function rejection(promise, pattern) {
    try {
        await promise;
    } catch (error) {
        expect(error).to.be.instanceOf(Error);
        if (pattern) {
            expect(error.message).to.match(pattern);
        }
        return error;
    }
    throw new Error('Expected promise to reject');
}

describe('VeDirectHexClient', () => {
    const clients = [];

    function createClient(com, options) {
        const client = new VeDirectHexClient(com, options);
        clients.push(client);
        return client;
    }

    afterEach(() => {
        for (const client of clients.splice(0)) {
            client.cancel(new Error('test cleanup'));
        }
    });

    describe('field validation and successful codec round trips', () => {
        it('writes the exact Get bytes and returns a scaled decodeRaw value', async () => {
            const com = new FakeCom();
            const client = createClient(com);
            const pending = client.getField('chargeCurrentLimit');
            await immediate();

            expect(com.writes).to.have.lengthOf(1);
            expect(com.writes[0]).to.deep.equal(encodeGet(REGISTER_IDS.chargeCurrentLimit));
            expect(com.writes[0].toString('ascii')).to.equal(':715200019\n');
            com.emit(getResponse('chargeCurrentLimit', [123, 0]));

            expect(await pending).to.equal(12.3);
            expect(com.closeCalls).to.equal(0);
        });

        it('decodes boolean, enum, un8 and un32 fields through the real codec', async () => {
            const fixtures = [
                ['deviceMode', Buffer.from([1]), true],
                ['networkMode', Buffer.from([5]), 'external'],
                ['deviceState', Buffer.from([0xfc]), 252],
                ['capabilities', Buffer.from([0x00, 0x80, 0x01, 0x00]), 0x00018000],
            ];
            for (const [name, raw, expected] of fixtures) {
                const com = new FakeCom();
                const client = createClient(com);
                const pending = client.getField(name);
                await immediate();
                com.emit(getResponse(name, raw));
                expect(await pending, name).to.equal(expected);
                expect(com.writes[0]).to.deep.equal(encodeGet(REGISTER_IDS[name]));
            }
        });

        it('verifies Set echo, performs Get readback and returns the actual readback value', async () => {
            const com = new FakeCom();
            const client = createClient(com);
            const raw = encodeRaw('chargeCurrentLimit', 1.2);
            const pending = client.setField('chargeCurrentLimit', 1.2);
            await immediate();

            expect(com.writes).to.have.lengthOf(1);
            expect(com.writes[0]).to.deep.equal(encodeSet(REGISTER_IDS.chargeCurrentLimit, raw));
            com.emit(setResponse('chargeCurrentLimit', raw));
            await immediate();

            expect(com.writes).to.have.lengthOf(2);
            expect(com.writes[1]).to.deep.equal(encodeGet(REGISTER_IDS.chargeCurrentLimit));
            // A device may clamp or otherwise alter a setting; return readback,
            // not merely the requested value or the Set acknowledgement.
            com.emit(getResponse('chargeCurrentLimit', [11, 0]));
            expect(await pending).to.equal(1.1);
            expect(com.closeCalls).to.equal(0);
        });

        it('accepts a legacy deviceMode off readback after writing the newer off encoding', async () => {
            const com = new FakeCom();
            const client = createClient(com);
            const pending = client.setField('deviceMode', false);
            await immediate();
            com.emit(setResponse('deviceMode', [4]));
            await immediate();
            com.emit(getResponse('deviceMode', [0]));
            expect(await pending).to.equal(false);
        });

        it('rejects unknown names and invalid/read-only controls without writing', async () => {
            const com = new FakeCom();
            const client = createClient(com);
            await rejection(client.getField('missing'), /Unknown VE.Direct HEX register/);
            await rejection(client.getField('__proto__'), /Unknown VE.Direct HEX register/);
            await rejection(client.setField('deviceState', 1), /read-only/);
            await rejection(client.setField('deviceMode', 1), /must be a boolean/);
            await rejection(client.setField('networkMode', 3), /permits only/);
            expect(com.writes).to.have.lengthOf(0);
            expect(com.closeCalls).to.equal(0);
        });

        it('validates constructor deadlines and queue capacities', () => {
            for (const responseTimeoutMs of [-1, NaN, Infinity, '10']) {
                expect(() => new VeDirectHexClient(new FakeCom(), { responseTimeoutMs })).to.throw(RangeError);
            }
            for (const maxQueueSize of [-1, 0.5, NaN, Infinity, '1']) {
                expect(() => new VeDirectHexClient(new FakeCom(), { maxQueueSize })).to.throw(RangeError);
            }
            expect(
                () => new VeDirectHexClient(new FakeCom(), { responseTimeoutMs: 0, maxQueueSize: 0 }),
            ).not.to.throw();
        });
    });

    describe('strict serialization and response selection', () => {
        it('holds a response received before drain and never overlaps a queued write', async () => {
            const com = new FakeCom();
            const drain = deferred();
            com.writeHook = (_bytes, index) => (index === 1 ? drain.promise : Promise.resolve());
            const client = createClient(com);
            const first = client.getField('chargeCurrentLimit');
            const second = client.getField('deviceState');
            let firstSettled = false;
            void first.then(
                () => (firstSettled = true),
                () => (firstSettled = true),
            );

            com.emit(getResponse('chargeCurrentLimit', [10, 0]));
            await immediate();
            expect(firstSettled).to.equal(false);
            expect(com.writes).to.have.lengthOf(1);

            drain.resolve();
            await immediate();
            expect(await first).to.equal(1);
            expect(com.writes).to.have.lengthOf(2);
            com.emit(getResponse('deviceState', [5]));
            expect(await second).to.equal(5);
        });

        it('ignores wrong IDs, wrong commands, async frames, garbage and invalid checksums', async () => {
            const com = new FakeCom();
            const client = createClient(com);
            const pending = client.getField('chargeCurrentLimit');
            let settled = false;
            void pending.then(
                () => (settled = true),
                () => (settled = true),
            );
            await immediate();

            com.emit(getResponse('chargeCurrentLimit', [10, 0], 0, REGISTER_IDS.deviceState));
            com.emit(setResponse('chargeCurrentLimit', [10, 0]));
            com.emit(registerFrame(0x0a, 'chargeCurrentLimit', [99, 99]));
            com.emit(Buffer.from('garbage'));
            com.emit(invalidChecksum(getResponse('chargeCurrentLimit', [10, 0])));
            com.emit(encodeRequest(0x1));
            com.emit(encodeRequest(0x5));
            await immediate();
            expect(settled).to.equal(false);
            expect(com.closeCalls).to.equal(0);

            com.emit(getResponse('chargeCurrentLimit', [10, 0]));
            expect(await pending).to.equal(1);
        });

        it('does not start Get readback until both Set response and drain complete', async () => {
            const com = new FakeCom();
            const drain = deferred();
            com.writeHook = (_bytes, index) => (index === 1 ? drain.promise : Promise.resolve());
            const client = createClient(com);
            const pending = client.setField('networkMode', 5);

            com.emit(setResponse('networkMode', [5]));
            await immediate();
            expect(com.writes).to.have.lengthOf(1);

            drain.resolve();
            await immediate();
            expect(com.writes).to.have.lengthOf(2);
            expect(decodeFrame(com.writes[1]).command).to.equal(0x7);
            com.emit(getResponse('networkMode', [5]));
            expect(await pending).to.equal('external');
        });

        it('waits for drain even when the selected response is an error', async () => {
            const com = new FakeCom();
            const drain = deferred();
            com.writeHook = () => drain.promise;
            const client = createClient(com);
            const pending = client.getField('deviceState');
            const assertion = rejection(pending, /general error/);
            com.emit(encodeRequest(0x4, Buffer.from([0xaa])));
            await immediate();
            expect(com.closeCalls).to.equal(0);

            drain.resolve();
            await assertion;
            expect(com.closeCalls).to.equal(0);
        });
    });

    describe('nonfatal protocol and register failures', () => {
        for (const [command, responseType] of [
            [0x4, 'error'],
            [0x3, 'unknown'],
        ]) {
            it(`rejects only the active operation for general ${responseType}`, async () => {
                const com = new FakeCom();
                const client = createClient(com);
                const first = client.getField('deviceState');
                const second = client.getField('deviceState');
                const assertion = rejection(first, new RegExp(`general ${responseType}`));
                await immediate();
                com.emit(encodeRequest(command, Buffer.from([0x02, 0x00])));

                const error = await assertion;
                expect(error.name).to.equal('VeDirectHexGeneralError');
                expect(error.responseType).to.equal(responseType);
                expect(error.payload).to.deep.equal(Buffer.from([2, 0]));
                await immediate();
                expect(com.writes).to.have.lengthOf(2);
                com.emit(getResponse('deviceState', [7]));
                expect(await second).to.equal(7);
                expect(com.closeCalls).to.equal(0);
            });
        }

        it('structures every known, combined and reserved nonzero flag', async () => {
            const com = new FakeCom();
            const client = createClient(com);
            for (const flags of [1, 2, 4, 3, 5, 6, 7, 8, 16, 32, 64, 128, 255]) {
                const pending = client.getField('chargeCurrentLimit');
                const assertion = rejection(pending, /returned flags/);
                await immediate();
                com.emit(getResponse('chargeCurrentLimit', [10, 0], flags));
                const error = await assertion;
                expect(error.name).to.equal('VeDirectHexRegisterError');
                expect(error.field).to.equal('chargeCurrentLimit');
                expect(error.registerId).to.equal(REGISTER_IDS.chargeCurrentLimit);
                expect(error.flags).to.equal(flags);
                expect(error.errors).to.deep.equal({
                    unknownId: (flags & 1) !== 0,
                    notSupported: (flags & 2) !== 0,
                    parameterError: (flags & 4) !== 0,
                });
                expect(error.unknownFlagBits).to.equal(flags & 0xf8);
                expect(error.rawValue).to.deep.equal(Buffer.from([10, 0]));
            }
            expect(com.closeCalls).to.equal(0);
        });

        it('uses decodeRaw exact-width validation for short, empty and wide Get values', async () => {
            const com = new FakeCom();
            const client = createClient(com);
            for (const raw of [[], [1], [1, 0, 0], [1, 0, 0, 0]]) {
                const pending = client.getField('chargeCurrentLimit');
                const assertion = rejection(pending, /exactly 2 bytes/);
                await immediate();
                com.emit(getResponse('chargeCurrentLimit', raw));
                await assertion;
            }
            expect(com.closeCalls).to.equal(0);
        });

        it('rejects an exact-width but unknown enum without accepting a number', async () => {
            const com = new FakeCom();
            const client = createClient(com);
            const pending = client.getField('networkMode');
            const assertion = rejection(pending, /Unknown networkMode/);
            await immediate();
            com.emit(getResponse('networkMode', [4]));
            await assertion;
            expect(com.closeCalls).to.equal(0);
        });

        it('rejects Set echo mismatch without issuing a Get or closing', async () => {
            const com = new FakeCom();
            const client = createClient(com);
            const pending = client.setField('chargeCurrentLimit', 1.2);
            const assertion = rejection(pending, /Set echo mismatch/);
            await immediate();
            com.emit(setResponse('chargeCurrentLimit', [13, 0]));

            const error = await assertion;
            expect(error.name).to.equal('VeDirectHexEchoError');
            expect(error.expected).to.deep.equal(Buffer.from([12, 0]));
            expect(error.actual).to.deep.equal(Buffer.from([13, 0]));
            await immediate();
            expect(com.writes).to.have.lengthOf(1);
            expect(com.closeCalls).to.equal(0);
        });

        it('rejects malformed Set echo width through decodeRaw without issuing Get', async () => {
            const com = new FakeCom();
            const client = createClient(com);
            const pending = client.setField('chargeCurrentLimit', 1.2);
            const assertion = rejection(pending, /exactly 2 bytes/);
            await immediate();
            com.emit(setResponse('chargeCurrentLimit', [12]));
            await assertion;
            expect(com.writes).to.have.lengthOf(1);
            expect(com.closeCalls).to.equal(0);
        });

        it('rejects flagged Set acknowledgements structurally without issuing Get', async () => {
            const com = new FakeCom();
            const client = createClient(com);
            const pending = client.setField('deviceMode', true);
            const assertion = rejection(pending, /returned flags/);
            await immediate();
            com.emit(setResponse('deviceMode', [1], 4));
            const error = await assertion;
            expect(error.errors.parameterError).to.equal(true);
            expect(com.writes).to.have.lengthOf(1);
            expect(com.closeCalls).to.equal(0);
        });
    });

    describe('fatal deadline and ambiguous write failures', () => {
        it('rejects active and queued calls on response timeout without retry and ignores late response', async () => {
            const com = new FakeCom();
            const client = createClient(com, { responseTimeoutMs: 15 });
            const first = client.getField('deviceState');
            const second = client.getField('deviceState');
            const settled = Promise.allSettled([first, second]);
            await immediate();

            const results = await settled;
            expect(results.map(result => result.status)).to.deep.equal(['rejected', 'rejected']);
            expect(results[0].reason.message).to.match(/timed out after 15 ms/);
            expect(results[1].reason).to.equal(results[0].reason);
            expect(com.closeCalls).to.equal(1);
            expect(com.writes).to.have.lengthOf(1);

            com.emit(getResponse('deviceState', [5]));
            await delay(25);
            expect(com.writes).to.have.lengthOf(1);
            await rejection(client.getField('deviceState'), /session is invalid/);
            expect(com.writes).to.have.lengthOf(1);
        });

        it('counts pending write/drain against the deadline even after a valid response', async () => {
            const com = new FakeCom();
            const hangingWrite = deferred();
            com.writeHook = () => hangingWrite.promise;
            const client = createClient(com, { responseTimeoutMs: 15 });
            const pending = client.getField('deviceState');
            const assertion = rejection(pending, /timed out/);
            com.emit(getResponse('deviceState', [5]));

            await assertion;
            expect(com.closeCalls).to.equal(1);
            hangingWrite.resolve();
            await immediate();
            expect(com.writes).to.have.lengthOf(1);
        });

        it('treats write failure after an early valid response as fatal and flushes the queue', async () => {
            const com = new FakeCom();
            const writing = deferred();
            com.writeHook = () => writing.promise;
            const client = createClient(com);
            const first = client.getField('deviceState');
            const second = client.getField('deviceState');
            const settled = Promise.allSettled([first, second]);
            com.emit(getResponse('deviceState', [5]));
            const expected = new Error('ambiguous drain failure');
            writing.reject(expected);

            const results = await settled;
            expect(results[0].status).to.equal('rejected');
            expect(results[0].reason).to.equal(expected);
            expect(results[1].reason).to.equal(expected);
            expect(com.closeCalls).to.equal(1);
            expect(com.writes).to.have.lengthOf(1);
        });

        it('invalidates on a synchronous write throw and never retries', async () => {
            const com = new FakeCom();
            const expected = new Error('synchronous write failure');
            com.writeHook = () => {
                throw expected;
            };
            const client = createClient(com);
            const pending = client.getField('deviceState');
            const error = await rejection(pending);
            expect(error).to.equal(expected);
            expect(com.closeCalls).to.equal(1);
            expect(com.writes).to.have.lengthOf(1);
            await rejection(client.getField('deviceState'), /session is invalid/);
            expect(com.writes).to.have.lengthOf(1);
        });

        it('observes close rejection and reports it through optional onError', async () => {
            const com = new FakeCom();
            const writeError = new Error('write failed');
            const closeError = new Error('close failed');
            com.writeHook = () => Promise.reject(writeError);
            com.closeHook = () => Promise.reject(closeError);
            const client = createClient(com);
            const reported = [];
            client.onError = error => reported.push(error);

            await rejection(client.getField('deviceState'), /write failed/);
            await immediate();
            expect(reported).to.deep.equal([closeError]);
            expect(com.closeCalls).to.equal(1);
        });

        it('also observes a synchronous close throw', async () => {
            const com = new FakeCom();
            const closeError = new Error('synchronous close failed');
            com.writeHook = () => Promise.reject(new Error('write failed'));
            com.closeHook = () => {
                throw closeError;
            };
            const client = createClient(com);
            const reported = [];
            client.onError = error => reported.push(error);
            await rejection(client.getField('deviceState'), /write failed/);
            expect(reported).to.deep.equal([closeError]);
        });
    });

    describe('port close, cancellation, capacity and reconnect', () => {
        it('aborts active and queued operations immediately when the port closes during response wait', async () => {
            const com = new FakeCom();
            const client = createClient(com);
            const first = client.getField('deviceState');
            const second = client.getField('deviceState');
            const settled = Promise.allSettled([first, second]);
            const expected = new Error('device unplugged');
            await immediate();
            com.portClosed(expected);

            const results = await settled;
            expect(results[0].reason).to.equal(expected);
            expect(results[1].reason).to.equal(expected);
            expect(com.closeCalls).to.equal(0);
            com.emit(getResponse('deviceState', [5]));
            expect(com.writes).to.have.lengthOf(1);
        });

        it('aborts while write is pending and ignores its late completion', async () => {
            const com = new FakeCom();
            const writing = deferred();
            com.writeHook = () => writing.promise;
            const client = createClient(com);
            const first = client.getField('deviceState');
            const second = client.getField('deviceState');
            const settled = Promise.allSettled([first, second]);
            com.portClosed();
            const results = await settled;
            expect(results.every(result => result.status === 'rejected')).to.equal(true);

            writing.resolve();
            com.emit(getResponse('deviceState', [5]));
            await immediate();
            expect(com.writes).to.have.lengthOf(1);
            expect(com.closeCalls).to.equal(0);
        });

        it('enforces a bounded waiting queue without disturbing active work', async () => {
            const com = new FakeCom();
            const writing = deferred();
            com.writeHook = () => writing.promise;
            const client = createClient(com, { maxQueueSize: 1 });
            const first = client.getField('deviceState');
            const second = client.getField('deviceState');
            await rejection(client.getField('deviceState'), /queue is full/);
            expect(com.writes).to.have.lengthOf(1);

            const settled = Promise.allSettled([first, second]);
            client.cancel(new Error('stop queue'));
            const results = await settled;
            expect(results.map(result => result.status)).to.deep.equal(['rejected', 'rejected']);
            writing.resolve();
            await immediate();
            expect(com.writes).to.have.lengthOf(1);
            expect(com.closeCalls).to.equal(0);
        });

        it('supports maxQueueSize zero for no waiting requests', async () => {
            const com = new FakeCom();
            const writing = deferred();
            com.writeHook = () => writing.promise;
            const client = createClient(com, { maxQueueSize: 0 });
            const first = client.getField('deviceState');
            const assertion = rejection(first, /cancelled by test/);
            await rejection(client.getField('deviceState'), /queue is full/);
            client.cancel(new Error('cancelled by test'));
            await assertion;
            writing.resolve();
        });

        it('cancel clears timers, rejects active and queued work and ignores late frames', async () => {
            const clock = sinon.useFakeTimers();
            try {
                const com = new FakeCom();
                const client = createClient(com, { responseTimeoutMs: 100 });
                const first = client.getField('deviceState');
                const second = client.getField('deviceState');
                const settled = Promise.allSettled([first, second]);
                const expected = new Error('unload now');
                client.cancel(expected);
                const results = await settled;
                expect(results[0].reason).to.equal(expected);
                expect(results[1].reason).to.equal(expected);
                expect(clock.countTimers()).to.equal(0);

                com.emit(getResponse('deviceState', [5]));
                await clock.tickAsync(200);
                expect(com.writes).to.have.lengthOf(1);
                expect(com.closeCalls).to.equal(0);
            } finally {
                clock.restore();
            }
        });

        it('permits a new session after invalidation and does not write before reconnect', async () => {
            const com = new FakeCom();
            com.closeHook = fake => {
                fake.portClosed(new Error('invalidating close'));
                return Promise.resolve();
            };
            const client = createClient(com, { responseTimeoutMs: 10 });
            await rejection(client.getField('deviceState'), /timed out/);
            expect(com.closeCalls).to.equal(1);
            await rejection(client.getField('deviceState'), /session is invalid/);

            com.emit(getResponse('deviceState', [99]));
            com.sessionId++;
            const pending = client.getField('deviceState');
            await immediate();
            expect(com.writes).to.have.lengthOf(2);
            com.emit(getResponse('deviceState', [7]));
            expect(await pending).to.equal(7);
            expect(com.closeCalls).to.equal(1);
        });

        it('detects a changed session even if an old response arrives without a close callback', async () => {
            const com = new FakeCom();
            const client = createClient(com);
            const first = client.getField('deviceState');
            const queued = client.getField('deviceState');
            const settled = Promise.allSettled([first, queued]);
            await immediate();
            com.sessionId++;
            com.emit(getResponse('deviceState', [5]));
            const results = await settled;
            expect(results[0].reason.message).to.match(/session changed/);
            expect(results[1].reason.message).to.match(/session changed/);
            expect(com.closeCalls).to.equal(0);

            const current = client.getField('deviceState');
            await immediate();
            com.emit(getResponse('deviceState', [8]));
            expect(await current).to.equal(8);
        });

        it('keeps two clients and their queues and close paths completely independent', async () => {
            const firstCom = new FakeCom();
            const secondCom = new FakeCom();
            const firstClient = createClient(firstCom, { responseTimeoutMs: 10 });
            const secondClient = createClient(secondCom);
            const timedOut = rejection(firstClient.getField('deviceState'), /timed out/);
            const healthy = secondClient.getField('deviceState');
            await immediate();
            secondCom.emit(getResponse('deviceState', [9]));

            expect(await healthy).to.equal(9);
            await timedOut;
            expect(firstCom.closeCalls).to.equal(1);
            expect(secondCom.closeCalls).to.equal(0);
            expect(secondCom.writes).to.have.lengthOf(1);
        });
    });
});
