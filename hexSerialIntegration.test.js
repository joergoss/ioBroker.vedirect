'use strict';

const { EventEmitter } = require('node:events');
const { expect } = require('chai');
const { VeDirectParser } = require('./lib/veDirect/veDirectParser');
const { VeDirectCom } = require('./lib/veDirectCom');
const { VeDirectHexClient } = require('./lib/veDirectHexClient');
const { encodeRequest, encodeGet, encodeSet, decodeFrame } = require('./lib/veDirect/hexProtocol');
const {
    REGISTER_IDS,
    REGISTER_ERROR_FLAGS,
    CAPABILITY_BITS,
    encodeRaw,
    decodeRaw,
    hasCapability,
} = require('./lib/veDirect/hexFields');

function immediate() {
    return new Promise(resolve => setImmediate(resolve));
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

function makeTextFrame(fields) {
    const body = Buffer.from(
        `\r\n${fields.map(([label, value]) => `${label}\t${value}\r\n`).join('')}Checksum\t`,
        'ascii',
    );
    let sum = 0;
    for (const byte of body) {
        sum = (sum + byte) & 0xff;
    }
    return Buffer.concat([body, Buffer.from([(256 - sum) & 0xff])]);
}

function registerResponse(command, name, rawValue, flags = 0) {
    const registerId = REGISTER_IDS[name];
    return encodeRequest(
        command,
        Buffer.concat([Buffer.from([registerId & 0xff, registerId >>> 8, flags]), Buffer.from(rawValue)]),
    );
}

function byteChunks(buffer) {
    return [...buffer].map(byte => Buffer.from([byte]));
}

/**
 * A serial endpoint only. Protocol parsing and register semantics live in
 * FakeSmartSolar, so every production component above this endpoint is real.
 */
class FakeSerialPort extends EventEmitter {
    constructor(device, path) {
        super();
        this.device = device;
        this.path = path;
        this.isOpen = false;
        this.setCalls = 0;
        this.writeCalls = 0;
        this.drainCalls = 0;
        this.closeCalls = 0;
        this.writes = [];
        this.pendingDrains = [];
        this.autoDrain = true;
    }

    write(data, callback) {
        this.writeCalls++;
        const bytes = Buffer.from(data);
        this.writes.push(bytes);
        let error;
        try {
            this.device.receiveWrite(this, bytes);
        } catch (caught) {
            error = caught;
        }
        queueMicrotask(() => callback(error ?? null));
    }

    drain(callback) {
        this.drainCalls++;
        if (this.autoDrain) {
            queueMicrotask(() => callback(null));
        } else {
            this.pendingDrains.push(callback);
        }
    }

    releaseDrain() {
        expect(this.pendingDrains, 'a pending drain callback').to.have.length.greaterThan(0);
        this.pendingDrains.shift()(null);
    }

    set(_options, callback) {
        this.setCalls++;
        queueMicrotask(() => callback(null));
    }

    close(callback) {
        this.closeCalls++;
        this.isOpen = false;
        this.emit('close');
        callback(null);
    }
}

/** Two instances of this class own completely separate raw register maps. */
class FakeSmartSolar {
    constructor(name, initialRegisters) {
        this.name = name;
        this.registers = new Map();
        for (const [fieldName, rawValue] of Object.entries(initialRegisters)) {
            this.setRaw(fieldName, rawValue);
        }
        this.requests = [];
        this.responses = [];
        this.droppedResponses = [];
        this.prefixes = [];
        this.suffixes = [];
        this.chunker = buffer => [buffer];
        this.onRequest = undefined;
        this.dropNextResponse = false;
        this.nextFlags = 0;
        this.nextSetEcho = undefined;
    }

    setRaw(name, rawValue) {
        const raw = Buffer.from(rawValue);
        // Validate fixture width and enum values through the production codec.
        decodeRaw(name, raw);
        this.registers.set(REGISTER_IDS[name], raw);
    }

    raw(name) {
        const value = this.registers.get(REGISTER_IDS[name]);
        expect(value, `${this.name}.${name} fixture`).to.be.instanceOf(Buffer);
        return Buffer.from(value);
    }

    queueInbound(...buffers) {
        this.prefixes.push(...buffers.map(buffer => Buffer.from(buffer)));
    }

    queueSuffix(...buffers) {
        this.suffixes.push(...buffers.map(buffer => Buffer.from(buffer)));
    }

    receiveWrite(port, bytes) {
        const request = decodeFrame(bytes);
        this.requests.push({ port, bytes: Buffer.from(bytes), frame: request });
        if (this.onRequest) {
            this.onRequest(request, port, this);
        }

        expect([0x7, 0x8], `${this.name} request command`).to.include(request.command);
        const registerId = request.registerId;
        const storedValue = this.registers.get(registerId);
        const flags = storedValue ? this.nextFlags : REGISTER_ERROR_FLAGS.unknownId;
        this.nextFlags = 0;

        let responseValue;
        if (request.command === 0x8) {
            responseValue = this.nextSetEcho ? Buffer.from(this.nextSetEcho) : Buffer.from(request.rawValue);
            if (storedValue && flags === 0 && !this.nextSetEcho) {
                this.registers.set(registerId, Buffer.from(request.rawValue));
            }
            this.nextSetEcho = undefined;
        } else {
            responseValue = storedValue ? Buffer.from(storedValue) : Buffer.alloc(0);
        }

        const response = encodeRequest(
            request.command,
            Buffer.concat([Buffer.from([registerId & 0xff, registerId >>> 8, flags]), responseValue]),
        );
        this.responses.push({ port, request, frame: response });

        if (this.dropNextResponse) {
            this.dropNextResponse = false;
            this.droppedResponses.push(response);
            return;
        }

        const stream = Buffer.concat([...this.prefixes.splice(0), response, ...this.suffixes.splice(0)]);
        for (const chunk of this.chunker(stream)) {
            expect(Buffer.isBuffer(chunk), `${this.name} emits binary chunks`).to.equal(true);
            port.emit('data', chunk);
        }
    }
}

const bankA = () => ({
    capabilities: Buffer.from([0x00, 0x80, 0x01, 0x00]),
    deviceMode: encodeRaw('deviceMode', true),
    deviceState: Buffer.from([3]),
    remoteControlUsed: Buffer.from([0, 0, 0, 0]),
    networkMode: encodeRaw('networkMode', 0),
    chargeCurrentLimit: encodeRaw('chargeCurrentLimit', 12.3),
    maxBatteryCurrent: Buffer.from([0x96, 0x00]), // Official 15.0 A example.
    chargeVoltageSetpoint: Buffer.from([0xa0, 0x05]), // 14.40 V.
});

const bankB = () => ({
    capabilities: Buffer.from([0x00, 0x80, 0x00, 0x00]),
    deviceMode: encodeRaw('deviceMode', false),
    deviceState: Buffer.from([4]),
    remoteControlUsed: Buffer.from([1, 0, 0, 0]),
    networkMode: encodeRaw('networkMode', 0),
    chargeCurrentLimit: encodeRaw('chargeCurrentLimit', 7.5),
    maxBatteryCurrent: Buffer.from([0x2c, 0x01]), // 30.0 A.
    chargeVoltageSetpoint: Buffer.from([0x3a, 0x05]), // 13.38 V.
});

const rigs = [];

function createRig(name, initialRegisters, options = {}) {
    const device = new FakeSmartSolar(name, initialRegisters);
    const ports = [];
    const textFrames = [];
    let validTextFrames = 0;
    const com = new VeDirectCom(
        (path, _options, callback) => {
            const port = new FakeSerialPort(device, path);
            ports.push(port);
            process.nextTick(() => {
                port.isOpen = true;
                callback();
            });
            return port;
        },
        {
            openTimeoutMs: 100,
            closeTimeoutMs: 100,
            writeTimeoutMs: 100,
            drainTimeoutMs: 100,
            ...options.com,
        },
    );
    com.onFrame = frame => textFrames.push(frame);
    com.onValidFrame = () => validTextFrames++;
    const client = new VeDirectHexClient(com, { responseTimeoutMs: options.responseTimeoutMs ?? 150 });
    const rig = {
        name,
        device,
        ports,
        textFrames,
        get validTextFrames() {
            return validTextFrames;
        },
        com,
        client,
        async open() {
            await com.open(`fake/${name}/${ports.length}`);
            return ports[ports.length - 1];
        },
    };
    rigs.push(rig);
    return rig;
}

async function closeRig(rig) {
    rig.client.cancel(new Error(`${rig.name} test cleanup`));
    await rig.com.close();
}

describe('HEX over fake serial byte streams (real parser/com/client/codecs)', () => {
    afterEach(async () => {
        for (const rig of rigs.splice(0).reverse()) {
            await closeRig(rig);
        }
    });

    it('reads real codec values concurrently from two independent SmartSolar banks', async () => {
        const a = createRig('A', bankA());
        const b = createRig('B', bankB());
        await Promise.all([a.open(), b.open()]);
        a.device.chunker = byteChunks;
        b.device.chunker = byteChunks;

        expect(a.com.parser).to.be.instanceOf(VeDirectParser);
        expect(b.com.parser).to.be.instanceOf(VeDirectParser);
        expect(a.device.registers).not.to.equal(b.device.registers);

        const [aCurrent, aMaximum, aVoltage, bCurrent, bMaximum, bVoltage] = await Promise.all([
            a.client.getField('chargeCurrentLimit'),
            a.client.getField('maxBatteryCurrent'),
            a.client.getField('chargeVoltageSetpoint'),
            b.client.getField('chargeCurrentLimit'),
            b.client.getField('maxBatteryCurrent'),
            b.client.getField('chargeVoltageSetpoint'),
        ]);

        expect([aCurrent, aMaximum, aVoltage]).to.deep.equal([12.3, 15, 14.4]);
        expect([bCurrent, bMaximum, bVoltage]).to.deep.equal([7.5, 30, 13.38]);
        expect(a.ports[0].writes[0]).to.deep.equal(encodeGet(REGISTER_IDS.chargeCurrentLimit));
        expect(b.ports[0].writes[0]).to.deep.equal(encodeGet(REGISTER_IDS.chargeCurrentLimit));
        expect(decodeRaw('maxBatteryCurrent', a.device.raw('maxBatteryCurrent'))).to.equal(15);
        expect(decodeRaw('maxBatteryCurrent', b.device.raw('maxBatteryCurrent'))).to.equal(30);
        expect(a.com.parser.checksumErrors).to.equal(0);
        expect(b.com.parser.checksumErrors).to.equal(0);
    });

    it('writes Charger off with an exact Set acknowledgement and a real Get readback', async () => {
        const rig = createRig('charger', bankA());
        await rig.open();

        expect(await rig.client.setField('deviceMode', false)).to.equal(false);

        expect(rig.device.raw('deviceMode')).to.deep.equal(encodeRaw('deviceMode', false));
        expect(rig.device.requests.map(entry => entry.frame.command)).to.deep.equal([0x8, 0x7]);
        expect(rig.ports[0].writes[0]).to.deep.equal(
            encodeSet(REGISTER_IDS.deviceMode, encodeRaw('deviceMode', false)),
        );
        expect(rig.ports[0].writes[1]).to.deep.equal(encodeGet(REGISTER_IDS.deviceMode));
        expect(decodeFrame(rig.device.responses[0].frame).rawValue).to.deep.equal(Buffer.from([4]));
        expect(decodeFrame(rig.device.responses[1].frame).rawValue).to.deep.equal(Buffer.from([4]));
    });

    it('checks capability and performs External Mode plus Current Set with readbacks', async () => {
        const rig = createRig('external', bankB());
        await rig.open();

        const capabilities = await rig.client.getField('capabilities');
        expect(hasCapability(capabilities, CAPABILITY_BITS.externalControl)).to.equal(true);
        expect(await rig.client.setField('networkMode', 5)).to.equal('external');
        expect(await rig.client.setField('chargeCurrentLimit', 23.7)).to.equal(23.7);

        expect(rig.device.raw('networkMode')).to.deep.equal(encodeRaw('networkMode', 5));
        expect(rig.device.raw('chargeCurrentLimit')).to.deep.equal(encodeRaw('chargeCurrentLimit', 23.7));
        expect(rig.device.requests.map(entry => entry.frame.command)).to.deep.equal([0x7, 0x8, 0x7, 0x8, 0x7]);
        expect(decodeRaw('networkMode', rig.device.raw('networkMode'))).to.equal('external');
        expect(decodeRaw('chargeCurrentLimit', rig.device.raw('chargeCurrentLimit'))).to.equal(23.7);
    });

    it('holds a response received before drain and releases no queued write early', async () => {
        const rig = createRig('early-response', bankA());
        const port = await rig.open();
        port.autoDrain = false;
        const first = rig.client.getField('chargeCurrentLimit');
        const second = rig.client.getField('deviceState');
        let firstSettled = false;
        void first.then(
            () => (firstSettled = true),
            () => (firstSettled = true),
        );
        await immediate();

        expect(rig.device.responses).to.have.length(1);
        expect(rig.com.parser.hexMessages).to.equal(1);
        expect(port.pendingDrains).to.have.length(1);
        expect(rig.device.requests).to.have.length(1);
        expect(firstSettled).to.equal(false);

        port.releaseDrain();
        expect(await first).to.equal(12.3);
        await immediate();
        expect(rig.device.requests).to.have.length(2);
        expect(rig.com.parser.hexMessages).to.equal(2);
        expect(port.pendingDrains).to.have.length(1);
        port.releaseDrain();
        expect(await second).to.equal(3);
    });

    it('handles every chunk boundary of a TEXT/Get/TEXT byte stream', async () => {
        const before = makeTextFrame([
            ['FW', '0153'],
            ['V', '13118'],
        ]);
        const after = makeTextFrame([['I', '-1000']]);
        const response = registerResponse(0x7, 'chargeCurrentLimit', encodeRaw('chargeCurrentLimit', 12.3));
        const expectedStream = Buffer.concat([before, response, after]);

        for (let split = 0; split <= expectedStream.length; split++) {
            const rig = createRig(`get-split-${split}`, bankA());
            rig.device.queueInbound(before);
            rig.device.queueSuffix(after);
            rig.device.chunker = stream => {
                expect(stream).to.deep.equal(expectedStream);
                return [stream.subarray(0, split), stream.subarray(split)];
            };
            await rig.open();

            expect(await rig.client.getField('chargeCurrentLimit'), `split ${split}`).to.equal(12.3);
            expect(rig.textFrames, `TEXT frames at split ${split}`).to.deep.equal([
                { FW: '0153', V: 13.118 },
                { I: -1 },
            ]);
            expect(rig.com.parser.checksumErrors).to.equal(0);
            await closeRig(rig);
        }
    });

    it('handles every chunk boundary of a TEXT/Set acknowledgement stream', async () => {
        const before = makeTextFrame([
            ['FW', '0153'],
            ['I', '2500'],
        ]);
        const response = registerResponse(0x8, 'networkMode', encodeRaw('networkMode', 5));
        const expectedStream = Buffer.concat([before, response]);

        for (let split = 0; split <= expectedStream.length; split++) {
            const rig = createRig(`set-split-${split}`, bankB());
            rig.device.queueInbound(before);
            let responseIndex = 0;
            rig.device.chunker = stream => {
                responseIndex++;
                if (responseIndex === 1) {
                    expect(stream).to.deep.equal(expectedStream);
                    return [stream.subarray(0, split), stream.subarray(split)];
                }
                return byteChunks(stream);
            };
            await rig.open();

            expect(await rig.client.setField('networkMode', 5), `split ${split}`).to.equal('external');
            expect(rig.textFrames, `TEXT frame at split ${split}`).to.deep.equal([{ FW: '0153', I: 2.5 }]);
            expect(rig.device.requests.map(entry => entry.frame.command)).to.deep.equal([0x8, 0x7]);
            expect(rig.com.parser.checksumErrors).to.equal(0);
            await closeRig(rig);
        }
    });

    it('keeps FW>=1.53 checksum-valid TEXT before and between HEX exchanges nonfatal', async () => {
        const rig = createRig('mixed-text', bankA());
        const textFrames = [
            makeTextFrame([
                ['FW', '0153'],
                ['V', '13118'],
            ]),
            makeTextFrame([
                ['FW', '0153'],
                ['I', '1200'],
            ]),
            makeTextFrame([
                ['FW', '0153'],
                ['I', '0'],
            ]),
        ];
        rig.device.onRequest = (_request, _port, device) => {
            device.queueInbound(textFrames[device.requests.length - 1]);
        };
        rig.device.chunker = byteChunks;
        await rig.open();

        expect(await rig.client.getField('maxBatteryCurrent')).to.equal(15);
        expect(await rig.client.setField('chargeCurrentLimit', 4.2)).to.equal(4.2);
        expect(rig.textFrames).to.deep.equal([
            { FW: '0153', V: 13.118 },
            { FW: '0153', I: 1.2 },
            { FW: '0153', I: 0 },
        ]);
        expect(rig.validTextFrames).to.equal(3);
        expect(rig.com.parser.hexMessages).to.equal(3);
        expect(rig.com.parser.checksumErrors).to.equal(0);
        expect(rig.com.parser.invalidFrames).to.equal(0);
        expect(rig.com.isOpen()).to.equal(true);
    });

    it('ignores asynchronous notifications, malformed HEX and binary garbage on the wire', async () => {
        const rig = createRig('async-garbage', bankA());
        const asyncState = registerResponse(0x0a, 'deviceState', Buffer.from([99]));
        const malformedHex = Buffer.from(':7THIS-IS-NOT-A-RESPONSE\n', 'ascii');
        rig.device.queueInbound(
            Buffer.from('garbage-without-newline', 'ascii'),
            asyncState,
            Buffer.from([0x00, 0xff, 0x80]),
            malformedHex,
            Buffer.from([0x7f, 0x01]),
        );
        rig.device.chunker = byteChunks;
        await rig.open();

        expect(await rig.client.getField('deviceState')).to.equal(3);
        expect(rig.com.parser.hexMessages).to.equal(3);
        expect(rig.com.isOpen()).to.equal(true);
        expect(rig.device.requests).to.have.length(1);
    });

    it('returns a structured register error flag without poisoning later reads', async () => {
        const rig = createRig('register-error', bankA());
        await rig.open();
        rig.device.nextFlags = REGISTER_ERROR_FLAGS.parameterError;

        const error = await rejection(rig.client.getField('chargeCurrentLimit'), /returned flags 0x04/);
        expect(error.name).to.equal('VeDirectHexRegisterError');
        expect(error.field).to.equal('chargeCurrentLimit');
        expect(error.flags).to.equal(4);
        expect(error.errors).to.deep.equal({ unknownId: false, notSupported: false, parameterError: true });
        expect(error.rawValue).to.deep.equal(encodeRaw('chargeCurrentLimit', 12.3));
        expect(rig.com.isOpen()).to.equal(true);

        expect(await rig.client.getField('chargeCurrentLimit')).to.equal(12.3);
        expect(rig.ports[0].closeCalls).to.equal(0);
    });

    it('rejects a Set echo mismatch over serial without issuing its Get readback', async () => {
        const rig = createRig('echo-mismatch', bankA());
        await rig.open();
        rig.device.nextSetEcho = encodeRaw('chargeCurrentLimit', 12.4);

        const error = await rejection(rig.client.setField('chargeCurrentLimit', 12.3), /Set echo mismatch/);
        expect(error.name).to.equal('VeDirectHexEchoError');
        expect(error.expected).to.deep.equal(encodeRaw('chargeCurrentLimit', 12.3));
        expect(error.actual).to.deep.equal(encodeRaw('chargeCurrentLimit', 12.4));
        await immediate();
        expect(rig.device.requests.map(entry => entry.frame.command)).to.deep.equal([0x8]);
        expect(rig.device.raw('chargeCurrentLimit')).to.deep.equal(encodeRaw('chargeCurrentLimit', 12.3));
        expect(rig.com.isOpen()).to.equal(true);
        expect(await rig.client.getField('chargeCurrentLimit')).to.equal(12.3);
    });

    it('times out, closes Com, reopens and never assigns an old-port response to the new session', async () => {
        const rig = createRig('reopen', bankA(), { responseTimeoutMs: 25 });
        const oldPort = await rig.open();
        rig.device.dropNextResponse = true;
        const timedOut = rejection(rig.client.getField('deviceState'), /timed out after 25 ms/);

        await timedOut;
        await immediate();
        expect(oldPort.closeCalls).to.equal(1);
        expect(oldPort.isOpen).to.equal(false);
        expect(rig.com.isOpen()).to.equal(false);
        expect(oldPort.listenerCount('data')).to.equal(0);
        expect(rig.device.droppedResponses).to.have.length(1);
        const oldResponse = rig.device.droppedResponses[0];
        expect(decodeFrame(oldResponse).rawValue).to.deep.equal(Buffer.from([3]));

        await rejection(rig.client.getField('deviceState'), /session is invalid/);
        rig.device.setRaw('deviceState', Buffer.from([9]));
        const newPort = await rig.open();
        expect(newPort).not.to.equal(oldPort);
        rig.device.onRequest = () => {
            // Bytes from the closed native handle arrive while the replacement
            // request is active. VeDirectCom must not route them to its parser.
            oldPort.emit('data', oldResponse);
        };

        expect(await rig.client.getField('deviceState')).to.equal(9);
        expect(newPort.isOpen).to.equal(true);
        expect(rig.ports).to.have.length(2);
        expect(rig.device.requests).to.have.length(2);
    });

    it('lets a healthy instance work while another instance has a hanging response', async () => {
        const hanging = createRig('hanging', bankA());
        const healthy = createRig('healthy', bankB());
        await Promise.all([hanging.open(), healthy.open()]);
        hanging.device.dropNextResponse = true;
        const pending = hanging.client.getField('chargeCurrentLimit');
        const pendingAssertion = rejection(pending, /finish hanging test/);
        await immediate();

        expect(await healthy.client.setField('chargeCurrentLimit', 8.8)).to.equal(8.8);
        expect(await healthy.client.setField('networkMode', 5)).to.equal('external');
        expect(healthy.com.isOpen()).to.equal(true);
        expect(hanging.device.requests).to.have.length(1);
        expect(hanging.ports[0].closeCalls).to.equal(0);

        hanging.client.cancel(new Error('finish hanging test'));
        await pendingAssertion;
        expect(await healthy.client.getField('chargeCurrentLimit')).to.equal(8.8);
        expect(healthy.ports[0].closeCalls).to.equal(0);
    });

    it('cancels and closes A on unload while B remains fully operational', async () => {
        const a = createRig('unload-A', bankA());
        const b = createRig('continue-B', bankB());
        await Promise.all([a.open(), b.open()]);
        a.device.dropNextResponse = true;
        const active = a.client.getField('deviceState');
        const queued = a.client.getField('chargeCurrentLimit');
        const settled = Promise.allSettled([active, queued]);
        await immediate();
        const unloadError = new Error('adapter A unloaded');

        a.client.cancel(unloadError);
        await a.com.close();
        const results = await settled;
        expect(results.map(result => result.status)).to.deep.equal(['rejected', 'rejected']);
        expect(results[0].reason).to.equal(unloadError);
        expect(results[1].reason).to.equal(unloadError);
        expect(a.com.isOpen()).to.equal(false);
        expect(a.ports[0].closeCalls).to.equal(1);

        expect(await b.client.setField('deviceMode', true)).to.equal(true);
        expect(await b.client.getField('chargeVoltageSetpoint')).to.equal(13.38);
        expect(b.com.isOpen()).to.equal(true);
        expect(b.ports[0].closeCalls).to.equal(0);
    });
});
