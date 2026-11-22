'use strict';

const { EventEmitter } = require('events');
const { expect } = require('chai');
const proxyquire = require('proxyquire');
const sinon = require('sinon');
const { VeDirectParser } = require('./lib/veDirect/veDirectParser');
const { VeDirectCom } = require('./lib/veDirectCom');

class Adapter extends EventEmitter {}
const { Vedirect } = proxyquire.noCallThru()('./main', {
    '@iobroker/adapter-core': { Adapter },
});

function harness() {
    const adapter = new Vedirect();
    adapter.com = {
        isOpen: sinon.stub().returns(false),
        open: sinon.stub().resolves(),
        close: sinon.stub().resolves(),
        onFrame: undefined,
        onValidFrame: undefined,
        onError: undefined,
        onPortClosed: undefined,
    };
    adapter.config = { USBDevice: '/dev/fake', expireTime: 0, messageBuffer: 0 };
    adapter.serialPortPath = '/dev/fake';
    adapter.connectionTarget = '/dev/fake';
    adapter.namespace = 'vedirect.0';
    adapter.log = { debug: sinon.stub(), info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() };
    adapter.setObjectNotExistsAsync = sinon.stub().resolves();
    adapter.extendObjectAsync = sinon.stub().resolves();
    adapter.setStateAsync = sinon.stub().resolves();
    adapter.setStateChangedAsync = sinon.stub().resolves();
    adapter.subscribeStatesAsync = sinon.stub().resolves();
    return adapter;
}

function makeFrame(fields) {
    const body = Buffer.from(`\r\n${fields.map(([label, value]) => `${label}\t${value}\r\n`).join('')}Checksum\t`);
    let sum = 0;
    for (const byte of body) {
        sum = (sum + byte) & 0xff;
    }
    return Buffer.concat([body, Buffer.from([(256 - sum) & 0xff])]);
}

class FakeSerialPort extends EventEmitter {
    constructor() {
        super();
        this.isOpen = false;
        this.closeCalls = 0;
    }

    set(_options, callback) {
        callback(null);
    }

    close(callback) {
        this.closeCalls++;
        this.isOpen = false;
        this.emit('close');
        callback(null);
    }
}

/** Adapter wired to the real VeDirectCom and parser, with replaceable fake serial ports. */
function serialHarness() {
    const adapter = harness();
    const ports = [];
    adapter.com = new VeDirectCom((_path, _options, callback) => {
        const port = new FakeSerialPort();
        ports.push(port);
        process.nextTick(() => {
            port.isOpen = true;
            callback();
        });
        return port;
    });
    return { adapter, ports };
}

function hexHarness(options = {}) {
    const adapter = harness();
    adapter.hexReadEnabled = true;
    adapter.chargerControlEnabled = options.chargerControlEnabled ?? true;
    adapter.currentLimitControlEnabled = options.currentLimitControlEnabled ?? true;
    adapter.currentLimitMax = options.currentLimitMax ?? 50;
    adapter.currentLimitRefreshSeconds = options.currentLimitRefreshSeconds ?? 20;
    adapter.externalControlSupported = options.externalControlSupported ?? true;
    adapter.com.isOpen.returns(true);
    adapter.hexClient = {
        getField: sinon.stub(),
        setField: sinon.stub(),
        cancel: sinon.stub(),
    };
    adapter.lastFrameTime = Date.now();
    adapter.lastFrameMonotonic = adapter.monotonicNow();
    return adapter;
}

function flush() {
    return new Promise(resolve => setImmediate(resolve));
}

function publishedStateValues(adapter) {
    return Object.fromEntries(
        [...adapter.setStateAsync.getCalls(), ...adapter.setStateChangedAsync.getCalls()].map(call => [
            call.args[0],
            call.args[1].val,
        ]),
    );
}

describe('VE.Direct adapter state handling', () => {
    it('creates and migrates objects before publishing values', async () => {
        const adapter = harness();
        let releaseExtend;
        adapter.extendObjectAsync.returns(new Promise(resolve => (releaseExtend = resolve)));
        const publishing = adapter.publishFrame({ V: 13.29 });
        await new Promise(resolve => setImmediate(resolve));
        expect(adapter.setStateChangedAsync.calledWith('V')).to.equal(false);
        releaseExtend();
        await publishing;
        expect(adapter.setObjectNotExistsAsync.calledWith('V')).to.equal(true);
        expect(adapter.extendObjectAsync.calledWith('V')).to.equal(true);
        expect(adapter.setStateChangedAsync.calledWith('V', { val: 13.29, ack: true })).to.equal(true);
        const common = adapter.extendObjectAsync.firstCall.args[1].common;
        expect(common).to.include({ type: 'number', role: 'value.voltage', unit: 'V', read: true, write: false });
        expect(common.desc).to.be.a('string').and.not.equal('');
    });

    it('publishes unavailable values as null rather than NaN', async () => {
        const adapter = harness();
        await adapter.publishFrame({ T: null, TTG: null, TTGInfinite: true });
        expect(adapter.setStateChangedAsync.calledWith('T', { val: null, ack: true })).to.equal(true);
        expect(adapter.setStateChangedAsync.calledWith('TTG', { val: null, ack: true })).to.equal(true);
        for (const call of adapter.setStateChangedAsync.getCalls()) {
            expect(Number.isNaN(call.args[1].val)).to.equal(false);
        }
    });

    it('uses changed writes without expire property when TTL is disabled', async () => {
        const adapter = harness();
        await adapter.publishFrame({ V: 13.29, H21: 53 });
        expect(adapter.setStateChangedAsync.calledTwice).to.equal(true);
        expect(adapter.setStateAsync.calledWith('V')).to.equal(false);
        for (const call of adapter.setStateChangedAsync.getCalls()) {
            expect(call.args[1]).not.to.have.property('expire');
        }
    });

    it('renews positive TTL only for expiring fields', async () => {
        const adapter = harness();
        adapter.expireSeconds = 30;
        await adapter.publishFrame({ V: 13.29, PID: 'SmartSolar MPPT 100|50' });
        expect(adapter.setStateAsync.calledWith('V', { val: 13.29, ack: true, expire: 30 })).to.equal(true);
        expect(adapter.setStateChangedAsync.calledWith('PID', { val: 'SmartSolar MPPT 100|50', ack: true })).to.equal(
            true,
        );
    });

    it('retries object creation after a rejected database operation', async () => {
        const adapter = harness();
        adapter.setObjectNotExistsAsync.onFirstCall().rejects(new Error('database unavailable'));
        await adapter.publishFrame({ V: 13.1 });
        await adapter.publishFrame({ V: 13.1 });
        expect(adapter.setObjectNotExistsAsync.callCount).to.equal(2);
        expect(adapter.log.error.called).to.equal(true);
        const publishErrors = adapter.log.error
            .getCalls()
            .filter(call => String(call.args[0]).includes('Could not publish V'));
        expect(publishErrors).to.have.lengthOf(1);
        expect(adapter.setStateChangedAsync.calledWith('V', { val: 13.1, ack: true })).to.equal(true);
    });

    it('throttles repeated identical reopen failures across watchdog retries', async () => {
        const adapter = harness();
        adapter.com.open.rejects(new Error('no such device'));
        await adapter.watchDog();
        adapter.lastOpenAttempt = 0;
        await adapter.watchDog();
        expect(adapter.com.open.callCount).to.equal(2);
        const messages = adapter.log.error
            .getCalls()
            .filter(call => String(call.args[0]).includes('Could not open/reopen'));
        expect(messages).to.have.lengthOf(1);
    });

    it('throttles repeated info.connection write failures while still retrying the write', async () => {
        const adapter = harness();
        adapter.setStateAsync.rejects(new Error('database unavailable'));
        await adapter.safeSetConnectionState(true);
        await adapter.safeSetConnectionState(true);
        expect(adapter.setStateAsync.callCount).to.equal(2);
        const messages = adapter.log.error
            .getCalls()
            .filter(call => String(call.args[0]).includes('Could not update info.connection'));
        expect(messages).to.have.lengthOf(1);
    });

    it('coalesces queued frames instead of building an unbounded database backlog', async () => {
        const adapter = harness();
        adapter.connectionRequested = true;
        adapter.connectionState = true;
        let release;
        adapter.setStateChangedAsync
            .withArgs('V')
            .onFirstCall()
            .returns(new Promise(resolve => (release = resolve)));
        adapter.enqueueFrame({ V: 11.1 });
        await new Promise(resolve => setImmediate(resolve));
        adapter.enqueueFrame({ V: 22.2 });
        adapter.enqueueFrame({ V: 33.3 });
        release();
        await adapter.frameQueue;
        const values = adapter.setStateChangedAsync
            .getCalls()
            .filter(call => call.args[0] === 'V')
            .map(call => call.args[1].val);
        expect(values).to.deep.equal([11.1, 33.3]);
    });

    it('drops queued frames and TTL renewal on disconnect, then accepts fresh generation data', async () => {
        const adapter = harness();
        adapter.connectionRequested = true;
        adapter.connectionState = true;
        adapter.expireSeconds = 30;
        let release;
        adapter.setStateAsync
            .withArgs('V')
            .onFirstCall()
            .returns(new Promise(resolve => (release = resolve)));
        adapter.enqueueFrame({ V: 11.1 });
        await new Promise(resolve => setImmediate(resolve));
        adapter.enqueueFrame({ V: 22.2 });
        adapter.enqueueFrame({ V: 33.3 });
        await adapter.safeSetConnectionState(false);
        release();
        await adapter.frameQueue;
        let values = adapter.setStateAsync
            .getCalls()
            .filter(call => call.args[0] === 'V')
            .map(call => call.args[1].val);
        expect(values).to.deep.equal([11.1]);

        await adapter.safeSetConnectionState(true);
        adapter.enqueueFrame({ V: 44.4 });
        await adapter.frameQueue;
        values = adapter.setStateAsync
            .getCalls()
            .filter(call => call.args[0] === 'V')
            .map(call => call.args[1].val);
        expect(values).to.deep.equal([11.1, 44.4]);
        expect(adapter.setStateAsync.lastCall.args[1]).to.include({ expire: 30, ack: true });
    });

    it('does not publish a frame whose receive time already exceeded the data timeout', async () => {
        const adapter = harness();
        adapter.connectionRequested = true;
        await adapter.publishFrame({ V: 11.1 }, adapter.connectionGeneration, Date.now() - 10001);
        expect(adapter.setStateChangedAsync.calledWith('V')).to.equal(false);
    });

    it('migrates info.connection metadata', async () => {
        const adapter = harness();
        await adapter.initConnectionObject();
        expect(adapter.extendObjectAsync.calledWith('info.connection')).to.equal(true);
        expect(adapter.extendObjectAsync.firstCall.args[1].common).to.include({
            type: 'boolean',
            role: 'indicator.connected',
            read: true,
            write: false,
        });
    });
});

describe('VE.Direct read-only runtime diagnostics', () => {
    it('migrates all diagnostic objects read-only and initializes serial defaults', async () => {
        const adapter = harness();
        await adapter.initConnectionObject();
        const commons = new Map(
            adapter.extendObjectAsync
                .getCalls()
                .filter(call => call.args[0].startsWith('info.') && call.args[0] !== 'info.connection')
                .map(call => [call.args[0], call.args[1].common]),
        );
        expect(commons.size).to.equal(6);
        for (const [id, common] of commons) {
            expect(common, id).to.include({ read: true, write: false });
            expect(common.name.en).to.be.a('string').and.not.equal('');
            expect(common.name.de).to.be.a('string').and.not.equal('');
            expect(common.name['zh-cn']).to.be.a('string').and.not.equal('');
        }
        adapter.configureConnectionTarget();
        await adapter.initializeDiagnostics();
        const values = publishedStateValues(adapter);
        expect(values).to.include({
            'info.transport': 'serial',
            'info.lastValidFrameAt': 0,
            'info.reconnectCount': 0,
            'info.checksumErrors': 0,
            'info.parserErrors': 0,
            'info.lastTransportError': '',
        });
        expect(commons.get('info.lastValidFrameAt')).to.include({ role: 'value.time', unit: 'ms', min: 0 });
    });

    it('initializes TCP diagnostics without publishing the network target', async () => {
        const adapter = harness();
        adapter.config = {
            byTCPIP: true,
            tcpHost: 'secret.example',
            tcpPort: 1234,
            USBDevice: '',
            expireTime: 0,
            messageBuffer: 0,
        };
        adapter.configureConnectionTarget();
        await adapter.initializeDiagnostics();
        const calls = [...adapter.setStateAsync.getCalls(), ...adapter.setStateChangedAsync.getCalls()];
        expect(calls.find(call => call.args[0] === 'info.transport').args[1].val).to.equal('tcp');
        for (const call of calls) {
            expect(String(call.args[1].val)).not.to.include('secret.example');
            expect(String(call.args[1].val)).not.to.include('1234');
        }
    });

    it('counts only successful opens after the initial transport open', async () => {
        const adapter = harness();
        for (let index = 0; index < 2; index++) {
            adapter.lastOpenAttempt = 0;
            await adapter.watchDog();
        }
        expect(adapter.successfulOpenCount).to.equal(2);
        expect(adapter.reconnectCount).to.equal(1);
        await flush();
        expect(adapter.setStateChangedAsync.calledWith('info.reconnectCount', { val: 1, ack: true })).to.equal(true);

        adapter.com.open.rejects(new Error('offline'));
        adapter.lastOpenAttempt = 0;
        await adapter.watchDog();
        expect(adapter.successfulOpenCount).to.equal(2);
        expect(adapter.reconnectCount).to.equal(1);
    });

    it('publishes valid-frame time at most every 30 seconds and flushes a newer value on disconnect', async () => {
        const clock = sinon.useFakeTimers({ now: 100000, toFake: ['Date'] });
        try {
            const adapter = harness();
            adapter.initConnectionObject = sinon.stub().resolves();
            adapter.watchDog = sinon.stub().resolves();
            await adapter.onReady();
            clearInterval(adapter.watchDogInterval);
            adapter.watchDogInterval = undefined;

            adapter.com.onValidFrame();
            await flush();
            for (let index = 0; index < 20; index++) {
                adapter.com.onValidFrame();
            }
            await flush();
            await clock.tickAsync(30000);
            adapter.com.onValidFrame();
            await flush();
            await clock.tickAsync(1000);
            adapter.com.onValidFrame();
            await flush();
            await adapter.safeSetConnectionState(false);
            const values = adapter.setStateChangedAsync
                .getCalls()
                .filter(call => call.args[0] === 'info.lastValidFrameAt')
                .map(call => call.args[1].val);
            expect(values).to.deep.equal([100000, 130000, 131000]);
        } finally {
            clock.restore();
        }
    });

    it('publishes cumulative parser counters only when real parser errors occur', async () => {
        const { adapter, ports } = serialHarness();
        await adapter.onReady();
        clearInterval(adapter.watchDogInterval);
        adapter.watchDogInterval = undefined;
        await adapter.activeWatchDog;
        expect(ports).to.have.lengthOf(1);

        const corrupted = makeFrame([['V', '13290']]);
        corrupted[5] ^= 1;
        ports[0].emit('data', corrupted);
        await flush();
        ports[0].emit('data', makeFrame([['V', 'not-a-number']]));
        await flush();
        ports[0].emit('data', Buffer.from(`:7${'0'.repeat(300)}\n`, 'ascii'));
        await flush();

        const checksumValues = adapter.setStateChangedAsync
            .getCalls()
            .filter(call => call.args[0] === 'info.checksumErrors')
            .map(call => call.args[1].val);
        const parserValues = adapter.setStateChangedAsync
            .getCalls()
            .filter(call => call.args[0] === 'info.parserErrors')
            .map(call => call.args[1].val);
        expect(checksumValues).to.deep.equal([1]);
        expect(parserValues).to.deep.equal([1, 2]);
        expect(adapter.lastValidFrameAt).to.equal(0);
        await adapter.com.close();
    });

    it('stores only sanitized transport errors and retains the last real error after recovery', async () => {
        const adapter = harness();
        adapter.config.tcpHost = 'secret.example';
        adapter.serialPortPath = '/dev/ttyUSB-secret';
        const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1234'), { code: 'ECONNREFUSED' });
        expect(adapter.sanitizeTransportError(refused)).to.equal('ECONNREFUSED');
        expect(adapter.sanitizeTransportError(new Error('open /dev/ttyUSB-secret failed'))).to.equal(
            'open <target> failed',
        );
        expect(adapter.sanitizeTransportError(new Error('DNS secret.example failed'))).to.equal('DNS <target> failed');
        expect(adapter.sanitizeTransportError(new Error('route 2001:db8::1%lo0 failed'))).to.equal(
            'route <address> failed',
        );
        await adapter.recordTransportError(refused);
        await adapter.recordTransportOpen();
        expect(adapter.lastTransportError).to.equal('ECONNREFUSED');
        const call = adapter.setStateChangedAsync
            .getCalls()
            .find(candidate => candidate.args[0] === 'info.lastTransportError');
        expect(call.args[1]).to.deep.equal({ val: 'ECONNREFUSED', ack: true });
        expect(JSON.stringify(call.args[1])).not.to.include('127.0.0.1');
    });

    it('keeps counters and diagnostics independent between two instances', async () => {
        const first = harness();
        const second = harness();
        await first.recordTransportOpen();
        await first.recordTransportOpen();
        await second.recordTransportOpen();
        first.recordParserError({ checksumErrors: 2, invalidFrames: 3, invalidHexMessages: 1 });
        await first.drainDiagnostics();
        expect(first.reconnectCount).to.equal(1);
        expect(second.reconnectCount).to.equal(0);
        expect(first.setStateChangedAsync.calledWith('info.checksumErrors', { val: 2, ack: true })).to.equal(true);
        expect(first.setStateChangedAsync.calledWith('info.parserErrors', { val: 4, ack: true })).to.equal(true);
        expect(second.setStateChangedAsync.calledWith('info.checksumErrors')).to.equal(false);
        expect(second.setStateChangedAsync.calledWith('info.parserErrors')).to.equal(false);
    });

    it('keeps connection transitions ordered and watchdog progress when timestamp writes hang', async () => {
        const adapter = harness();
        let releaseTimestamp;
        const pendingTimestamp = new Promise(resolve => (releaseTimestamp = resolve));
        adapter.setStateChangedAsync.withArgs('info.lastValidFrameAt').returns(pendingTimestamp);
        adapter.lastValidFrameAt = 1000;
        await adapter.safeSetConnectionState(true);
        await adapter.safeSetConnectionState(false);

        adapter.lastValidFrameAt = 2000;
        await adapter.safeSetConnectionState(true);
        expect(adapter.connectionRequested).to.equal(true);
        expect(adapter.connectionState).to.equal(true);
        const connectionValues = adapter.setStateAsync
            .getCalls()
            .filter(call => call.args[0] === 'info.connection')
            .map(call => call.args[1].val);
        expect(connectionValues.slice(0, 3)).to.deep.equal([true, false, true]);

        adapter.lastFrameTime = 0;
        adapter.lastValidFrameAt = 3000;
        adapter.com.isOpen.returns(true);
        adapter.lastOpenAttempt = 0;
        await adapter.watchDog();
        expect(adapter.com.close.called).to.equal(true);
        expect(adapter.com.open.called).to.equal(true);
        releaseTimestamp();
        await flush();
        await Promise.all([...adapter.stateQueues.values()]);
    });

    for (const [name, config, transport] of [
        ['an empty serial target', { USBDevice: '', expireTime: 0, messageBuffer: 0 }, 'serial'],
        [
            'an invalid TCP target',
            { byTCPIP: true, tcpHost: 'http://127.0.0.1', tcpPort: 1234, expireTime: 0, messageBuffer: 0 },
            'tcp',
        ],
    ]) {
        it(`resets all diagnostics before rejecting ${name}`, async () => {
            const adapter = harness();
            adapter.config = config;
            adapter.lastValidFrameAt = 123;
            adapter.lastValidFramePublishedAt = 123;
            adapter.lastValidFramePublishOperation = 123;
            adapter.successfulOpenCount = 4;
            adapter.reconnectCount = 3;
            adapter.lastTransportError = 'old error';
            adapter.diagnosticValues.set('info.reconnectCount', 99);
            adapter.handleReady();
            await adapter.readyPromise;
            if (adapter.watchDogInterval) {
                clearInterval(adapter.watchDogInterval);
                adapter.watchDogInterval = undefined;
            }
            const values = publishedStateValues(adapter);
            expect(values).to.include({
                'info.transport': transport,
                'info.lastValidFrameAt': 0,
                'info.reconnectCount': 0,
                'info.checksumErrors': 0,
                'info.parserErrors': 0,
                'info.lastTransportError': '',
            });
            expect(adapter.lastValidFrameAt).to.equal(0);
            expect(adapter.reconnectCount).to.equal(0);
            expect(adapter.lastTransportError).to.equal('');
            expect(adapter.watchDogInterval).to.equal(undefined);
        });
    }

    it('retries a failed timestamp publication with the same forced-flush timestamp', async () => {
        const adapter = harness();
        adapter.setStateChangedAsync.withArgs('info.lastValidFrameAt').onFirstCall().rejects(new Error('db down'));
        adapter.lastValidFrameAt = 1000;
        await adapter.publishLastValidFrame(true);
        expect(adapter.lastValidFramePublishedAt).to.equal(0);
        expect(adapter.lastValidFramePublishOperation).to.equal(0);
        expect(adapter.diagnosticValues.has('info.lastValidFrameAt')).to.equal(false);

        await adapter.publishLastValidFrame(true);
        expect(adapter.lastValidFramePublishedAt).to.equal(1000);
        expect(adapter.diagnosticValues.get('info.lastValidFrameAt')).to.equal(1000);
        expect(adapter.setStateChangedAsync.withArgs('info.lastValidFrameAt').callCount).to.equal(2);
    });

    it('keeps the latest diagnostic value after an older A-B-A operation fails', async () => {
        const adapter = harness();
        let rejectFirst;
        let resolveSecond;
        let resolveThird;
        adapter.setStateChangedAsync.onCall(0).returns(new Promise((_, reject) => (rejectFirst = reject)));
        adapter.setStateChangedAsync.onCall(1).returns(new Promise(resolve => (resolveSecond = resolve)));
        adapter.setStateChangedAsync.onCall(2).returns(new Promise(resolve => (resolveThird = resolve)));
        const first = adapter.writeDiagnosticState('info.parserErrors', 'A');
        const second = adapter.writeDiagnosticState('info.parserErrors', 'B');
        const third = adapter.writeDiagnosticState('info.parserErrors', 'A');
        rejectFirst(new Error('first write failed'));
        await flush();
        resolveSecond();
        await flush();
        resolveThird();
        expect(await Promise.all([first, second, third])).to.deep.equal([true, true, true]);
        expect(adapter.diagnosticValues.get('info.parserErrors')).to.equal('A');
        await adapter.writeDiagnosticState('info.parserErrors', 'A');
        expect(adapter.setStateChangedAsync.callCount).to.equal(2);
    });

    it('masks compressed, scoped and bracketed addresses plus mixed-case hostnames conservatively', () => {
        const adapter = harness();
        adapter.config.tcpHost = 'Secret.Example.';
        adapter.serialPortPath = '/dev/ttyUSB0';
        adapter.config.USBDevice = '/dev/ttyUSB0';
        for (const [message, expected] of [
            ['route ::1 failed', 'route <address> failed'],
            ['route fe80::1%lo0 failed', 'route <address> failed'],
            ['route [fe80::1%lo0]:1234 failed', 'route <address> failed'],
            ['route 192.0.2.1:1234 failed', 'route <address> failed'],
            ['DNS secret.example failed', 'DNS <target> failed'],
            ['DNS secret.example. failed', 'DNS <target> failed'],
            ['DNS other.example failed', 'Error'],
            ['open /dev/ttyUSB9 failed', 'Error'],
            ['DNS secret.example and other.example failed', 'Error'],
            ['open /dev/ttyUSB0 and /dev/ttyUSB9 failed', 'Error'],
            ['route 192.0.2.1 via otherhost failed', 'Error'],
            ['endpoint otherhost failed', 'Error'],
            ['endpoint other.example:1234 failed', 'Error'],
        ]) {
            expect(adapter.sanitizeTransportError(new Error(message)), message).to.equal(expected);
        }
    });

    it('continues later watchdog cycles while reconnect-count publication is pending', async () => {
        const adapter = harness();
        let releaseReconnect;
        adapter.setStateChangedAsync
            .withArgs('info.reconnectCount')
            .returns(new Promise(resolve => (releaseReconnect = resolve)));
        for (let index = 0; index < 3; index++) {
            adapter.lastOpenAttempt = 0;
            await adapter.watchDog();
        }
        expect(adapter.com.open.callCount).to.equal(3);
        expect(adapter.successfulOpenCount).to.equal(3);
        expect(adapter.reconnectCount).to.equal(2);
        releaseReconnect();
        await flush();
        await Promise.all([...adapter.stateQueues.values()]);
    });

    it('coalesces different timestamp attempts to the active and latest values only', async () => {
        const adapter = harness();
        let releaseFirst;
        adapter.setStateChangedAsync
            .withArgs('info.lastValidFrameAt')
            .onFirstCall()
            .returns(new Promise(resolve => (releaseFirst = resolve)));
        adapter.lastValidFrameAt = 100000;
        const first = adapter.publishLastValidFrame(true);
        adapter.lastValidFrameAt = 101000;
        const second = adapter.publishLastValidFrame(true);
        adapter.lastValidFrameAt = 102000;
        const third = adapter.publishLastValidFrame(true);
        await flush();
        expect(adapter.setStateChangedAsync.withArgs('info.lastValidFrameAt').callCount).to.equal(1);
        releaseFirst();
        await Promise.all([first, second, third]);
        const values = adapter.setStateChangedAsync
            .getCalls()
            .filter(call => call.args[0] === 'info.lastValidFrameAt')
            .map(call => call.args[1].val);
        expect(values).to.deep.equal([100000, 102000]);
        expect(adapter.lastValidFramePublishedAt).to.equal(102000);
    });

    it('uses the latest successfully written timestamp for throttling during an active drain', async () => {
        const adapter = harness();
        let releaseSecond;
        adapter.setStateChangedAsync
            .withArgs('info.lastValidFrameAt')
            .onSecondCall()
            .returns(new Promise(resolve => (releaseSecond = resolve)));
        adapter.lastValidFrameAt = 100000;
        const first = adapter.publishLastValidFrame(true);
        adapter.lastValidFrameAt = 101000;
        const second = adapter.publishLastValidFrame(true);
        await flush();
        expect(adapter.diagnosticPublishedValues.get('info.lastValidFrameAt')).to.equal(100000);
        expect(adapter.lastValidFramePublishedAt).to.equal(0);

        adapter.lastValidFrameAt = 102000;
        await adapter.publishLastValidFrame();
        expect(adapter.diagnosticEntries.get('info.lastValidFrameAt').latest).to.equal(101000);
        releaseSecond();
        await Promise.all([first, second]);
        const values = adapter.setStateChangedAsync
            .getCalls()
            .filter(call => call.args[0] === 'info.lastValidFrameAt')
            .map(call => call.args[1].val);
        expect(values).to.deep.equal([100000, 101000]);
    });

    it('reuses pending timestamp and parser drains without per-event Promise observers', async () => {
        const adapter = harness();
        let release;
        const pending = new Promise(resolve => (release = resolve));
        adapter.setStateChangedAsync.returns(pending);
        adapter.lastValidFrameAt = 1000;
        adapter.publishLastValidFrame(true);
        const operation = adapter.lastValidFrameOperationSequence;
        for (let index = 1; index <= 5000; index++) {
            adapter.lastValidFrameAt = 1000 + index;
            adapter.publishLastValidFrame(true);
            adapter.recordParserError({ checksumErrors: index, invalidFrames: index, invalidHexMessages: 0 });
        }
        expect(adapter.lastValidFrameOperationSequence).to.equal(operation);
        expect(adapter.diagnosticDrains.size).to.equal(3);
        release();
        await adapter.drainDiagnostics();
    });

    it('continues close and open when the info.connection write hangs', async () => {
        const adapter = harness();
        let release;
        adapter.setStateAsync.withArgs('info.connection').returns(new Promise(resolve => (release = resolve)));
        adapter.com.isOpen.returns(true);
        await adapter.watchDog();
        expect(adapter.com.close.calledOnce).to.equal(true);
        expect(adapter.com.open.calledOnce).to.equal(true);
        expect(adapter.activeWatchDog).to.equal(undefined);
        expect(adapter.connectionRequested).to.equal(false);
        release();
        await Promise.all([...adapter.stateQueues.values()]);
    });

    it('drains a trailing latest timestamp before finishing unload', async () => {
        const adapter = harness();
        let releaseFirst;
        adapter.setStateChangedAsync
            .withArgs('info.lastValidFrameAt')
            .onFirstCall()
            .returns(new Promise(resolve => (releaseFirst = resolve)));
        adapter.lastValidFrameAt = 1000;
        adapter.publishLastValidFrame(true);
        adapter.lastValidFrameAt = 2000;
        adapter.publishLastValidFrame(true);
        const callback = sinon.stub();
        adapter.onUnload(callback);
        await flush();
        releaseFirst();
        await adapter.unloadPromise;
        const values = adapter.setStateChangedAsync
            .getCalls()
            .filter(call => call.args[0] === 'info.lastValidFrameAt')
            .map(call => call.args[1].val);
        expect(values).to.deep.equal([1000, 2000]);
        expect(callback.calledOnce).to.equal(true);
    });

    it('does not overwrite a real transport error during a planned close', async () => {
        const { adapter } = serialHarness();
        await adapter.onReady();
        clearInterval(adapter.watchDogInterval);
        adapter.watchDogInterval = undefined;
        await adapter.activeWatchDog;
        await adapter.recordTransportError(Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }));
        await adapter.com.close();
        expect(adapter.lastTransportError).to.equal('ECONNRESET');
        const values = adapter.setStateChangedAsync
            .getCalls()
            .filter(call => call.args[0] === 'info.lastTransportError')
            .map(call => call.args[1].val);
        expect(values).to.deep.equal(['ECONNRESET']);
    });
});

describe('VE.Direct frame sampling', () => {
    let clock;
    beforeEach(() => (clock = sinon.useFakeTimers()));
    afterEach(() => clock.restore());

    it('merges complete multiblock frames instead of dropping serial lines', () => {
        const adapter = harness();
        adapter.samplingSeconds = 5;
        adapter.enqueueFrame = sinon.stub();
        adapter.acceptFrame({ V: 13.1, I: 1 });
        adapter.acceptFrame({ H20: 0.12, H21: 53 });
        adapter.acceptFrame({ V: 13.2, I: 1.1 });
        expect(adapter.enqueueFrame.called).to.equal(false);
        clock.tick(5000);
        expect(adapter.enqueueFrame.calledOnce).to.equal(true);
        expect(adapter.enqueueFrame.firstCall.args[0]).to.deep.equal({ V: 13.2, I: 1.1, H20: 0.12, H21: 53 });
    });

    it('does not turn a delayed sampled publication into fresh liveness', async () => {
        const adapter = harness();
        adapter.samplingSeconds = 5;
        adapter.connectionState = false;
        adapter.connectionRequested = false;
        adapter.acceptFrame({ V: 13.1 });
        await clock.tickAsync(5000);
        await adapter.frameQueue;
        expect(adapter.connectionState).to.equal(false);
        expect(adapter.setStateAsync.calledWith('info.connection', { val: true, ack: true })).to.equal(false);
    });

    it('does not leave a partial sample after unload', () => {
        const adapter = harness();
        adapter.samplingSeconds = 5;
        adapter.acceptFrame({ V: 13.1 });
        const callback = sinon.stub();
        adapter.onUnload(callback);
        clock.tick(10000);
        expect(adapter.pendingSample).to.equal(null);
        expect(adapter.sampleTimer).to.equal(undefined);
    });

    it('discards a pending sample when the serial link is reported down', async () => {
        const adapter = harness();
        adapter.samplingSeconds = 5;
        adapter.connectionState = true;
        adapter.connectionRequested = true;
        adapter.acceptFrame({ V: 13.1 });
        adapter.lastFrameTime = 0;

        await adapter.watchDog();
        expect(adapter.pendingSample).to.equal(null);
        expect(adapter.sampleTimer).to.equal(undefined);

        await clock.tickAsync(5000);
        await adapter.frameQueue;
        expect(adapter.setStateChangedAsync.calledWith('V')).to.equal(false);
    });

    it('starts a fresh sample generation after a reconnect', async () => {
        const adapter = harness();
        adapter.samplingSeconds = 5;
        adapter.connectionState = true;
        adapter.connectionRequested = true;
        adapter.acceptFrame({ V: 13.1, I: 1 });
        adapter.lastFrameTime = 0;
        await adapter.watchDog();
        expect(adapter.connectionState).to.equal(false);

        await adapter.safeSetConnectionState(true);
        adapter.acceptFrame({ V: 13.2 });
        await clock.tickAsync(5000);
        await adapter.frameQueue;
        expect(adapter.setStateChangedAsync.calledWith('I', { val: 1, ack: true })).to.equal(false);
        expect(adapter.setStateChangedAsync.calledWith('V', { val: 13.2, ack: true })).to.equal(true);
    });

    it('does not acknowledge or renew TTL for values while the link is down', async () => {
        const adapter = harness();
        adapter.expireSeconds = 30;
        adapter.connectionState = false;
        adapter.connectionRequested = false;

        await adapter.publishFrame({ V: 13.29 });

        expect(adapter.setStateAsync.calledWith('V')).to.equal(false);
        expect(adapter.setStateChangedAsync.calledWith('V')).to.equal(false);
    });
});

describe('VE.Direct watchdog and parser integration', () => {
    it('does not report a connection merely because opening succeeded', async () => {
        const adapter = harness();
        await adapter.watchDog();
        expect(adapter.com.open.calledOnce).to.equal(true);
        expect(adapter.connectionState).to.equal(false);
        expect(adapter.setStateAsync.calledWith('info.connection', { val: true, ack: true })).to.equal(false);
    });

    it('reopens a closed port even when the last TEXT frame is still fresh', async () => {
        const adapter = harness();
        adapter.lastFrameTime = Date.now();
        adapter.com.isOpen.returns(false);
        await adapter.watchDog();
        expect(adapter.com.open.calledOnce).to.equal(true);
        expect(adapter.connectionState).to.equal(false);
    });

    it('forces reconnect of a freshly streaming but invalidated HEX session', async () => {
        const adapter = harness();
        adapter.lastFrameTime = Date.now();
        adapter.connectionRequested = false;
        adapter.com.isOpen.returns(true);
        await adapter.watchDog();
        expect(adapter.com.close.calledOnce).to.equal(true);
        expect(adapter.com.open.calledOnce).to.equal(true);
    });

    it('closes and reopens a stale open port', async () => {
        const adapter = harness();
        adapter.com.isOpen.returns(true);
        await adapter.watchDog();
        expect(adapter.com.close.calledOnce).to.equal(true);
        expect(adapter.com.open.calledOnce).to.equal(true);
        expect(adapter.connectionState).to.equal(false);
    });

    it('immediately invalidates queued data on remote close and preserves the HEX close handler', async () => {
        const adapter = harness();
        const previousPortClosed = sinon.stub();
        adapter.com.onPortClosed = previousPortClosed;
        adapter.initConnectionObject = sinon.stub().resolves();
        adapter.watchDog = sinon.stub().resolves();
        await adapter.onReady();
        clearInterval(adapter.watchDogInterval);
        adapter.watchDogInterval = undefined;
        await adapter.safeSetConnectionState(true);
        adapter.pendingSample = { V: 11.1 };
        adapter.sampleTimer = setTimeout(() => undefined, 10000);
        adapter.pendingFrameBatch = {
            values: { V: 22.2 },
            generation: adapter.connectionGeneration,
            receivedAt: Date.now(),
        };
        const generation = adapter.connectionGeneration;
        const closeError = new Error('remote close');
        adapter.com.onPortClosed(closeError);
        expect(previousPortClosed.calledOnceWithExactly(closeError)).to.equal(true);
        expect(adapter.pendingSample).to.equal(null);
        expect(adapter.pendingFrameBatch).to.equal(null);
        expect(adapter.sampleTimer).to.equal(undefined);
        expect(adapter.connectionGeneration).to.equal(generation + 1);
        expect(adapter.connectionRequested).to.equal(false);
        await flush();
        expect(adapter.connectionState).to.equal(false);
    });

    it('uses monotonic time for freshness and reconnect cooldown after wall-clock regression', async () => {
        const adapter = harness();
        adapter.lastFrameTime = 100000;
        adapter.lastFrameMonotonic = 1000;
        adapter.lastOpenAttempt = 100000;
        adapter.lastOpenAttemptMonotonic = 1000;
        adapter.monotonicNow = () => 11001;
        const clock = sinon.stub(Date, 'now').returns(90000);
        try {
            expect(adapter.isFresh()).to.equal(false);
            expect(adapter.canPublishFrame(0, 100000, 1000)).to.equal(false);
            await adapter.watchDog();
            expect(adapter.com.open.calledOnce).to.equal(true);
        } finally {
            clock.restore();
        }
    });

    it('deduplicates overlapping watchdog operations', async () => {
        const adapter = harness();
        let release;
        adapter.com.open.returns(new Promise(resolve => (release = resolve)));
        const first = adapter.watchDog();
        expect(adapter.watchDog()).to.equal(first);
        release();
        await first;
        expect(adapter.com.open.calledOnce).to.equal(true);
    });

    it('uses only checksum-valid parser frames for liveness and publication', async () => {
        const adapter = harness();
        const parser = new VeDirectParser();
        adapter.initConnectionObject = sinon.stub().resolves();
        adapter.watchDog = sinon.stub().resolves();
        await adapter.onReady();
        if (adapter.watchDogInterval) {
            clearInterval(adapter.watchDogInterval);
        }
        parser.onValidFrame = () => adapter.com.onValidFrame();
        parser.onFrame = frame => adapter.com.onFrame(frame);

        const corrupted = makeFrame([['V', '13290']]);
        corrupted[5] ^= 1;
        parser.receive(corrupted);
        await new Promise(resolve => setImmediate(resolve));
        expect(adapter.connectionState).to.equal(false);
        expect(adapter.setStateChangedAsync.calledWith('V')).to.equal(false);

        parser.receive(makeFrame([['V', '13290']]));
        await adapter.frameQueue;
        await new Promise(resolve => setImmediate(resolve));
        expect(adapter.connectionState).to.equal(true);
        expect(adapter.setStateChangedAsync.calledWith('V', { val: 13.29, ack: true })).to.equal(true);
    });
});

describe('VE.Direct adapter over the real serial lifecycle', () => {
    let clock;
    afterEach(() => {
        if (clock) {
            clock.restore();
            clock = undefined;
        }
    });

    function useFakeClock() {
        clock = sinon.useFakeTimers({
            now: 100000,
            toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
        });
    }

    async function startAdapter(adapter) {
        if (clock) {
            adapter.monotonicNow = () => clock.now;
        }
        await adapter.onReady();
        clearInterval(adapter.watchDogInterval);
        adapter.watchDogInterval = undefined;
        await flush();
    }

    it('drops a pending sample when the link is lost instead of publishing stale values or renewing TTL', async () => {
        useFakeClock();
        const { adapter, ports } = serialHarness();
        adapter.config = { USBDevice: '/dev/fake', expireTime: 30, messageBuffer: 60 };
        await startAdapter(adapter);
        expect(ports).to.have.lengthOf(1);

        ports[0].emit(
            'data',
            makeFrame([
                ['V', '13290'],
                ['I', '-1250'],
            ]),
        );
        await flush();
        expect(adapter.pendingSample).to.deep.equal({ V: 13.29, I: -1.25 });

        // Unplug: the port reports closed, then the 10 s data timeout expires.
        ports[0].isOpen = false;
        ports[0].emit('close');
        adapter.lastFrameTime = 0;
        await clock.tickAsync(11000);
        await adapter.watchDog();
        expect(adapter.pendingSample).to.equal(null);
        expect(adapter.sampleTimer).to.equal(undefined);

        await clock.tickAsync(60000);
        await adapter.frameQueue;
        expect(adapter.setStateAsync.getCalls().filter(call => call.args[0] === 'V')).to.have.lengthOf(0);
        expect(adapter.setStateChangedAsync.getCalls().filter(call => call.args[0] === 'V')).to.have.lengthOf(0);
        expect(adapter.connectionState).to.equal(false);
        expect(ports).to.have.lengthOf(2);
    });

    it('reopens the port after the link is lost and publishes fresh frames again', async () => {
        useFakeClock();
        const { adapter, ports } = serialHarness();
        adapter.config = { USBDevice: '/dev/fake', expireTime: 0, messageBuffer: 0 };
        await startAdapter(adapter);

        ports[0].emit('data', makeFrame([['V', '13290']]));
        await adapter.frameQueue;
        await flush();
        expect(adapter.setStateChangedAsync.calledWith('V', { val: 13.29, ack: true })).to.equal(true);
        expect(adapter.connectionState).to.equal(true);

        ports[0].isOpen = false;
        ports[0].emit('close');
        adapter.lastFrameTime = 0;
        await clock.tickAsync(11000);
        await adapter.watchDog();
        await flush();
        expect(adapter.connectionState).to.equal(false);
        expect(ports).to.have.lengthOf(2);
        expect(ports[1].isOpen).to.equal(true);

        ports[1].emit('data', makeFrame([['V', '13400']]));
        await adapter.frameQueue;
        await flush();
        expect(adapter.setStateChangedAsync.calledWith('V', { val: 13.4, ack: true })).to.equal(true);
        expect(adapter.connectionState).to.equal(true);
    });

    it('writes a final disconnected state on unload and releases the serial port', async () => {
        const { adapter, ports } = serialHarness();
        adapter.config = { USBDevice: '/dev/fake', expireTime: 0, messageBuffer: 0 };
        await startAdapter(adapter);

        ports[0].emit('data', makeFrame([['V', '13290']]));
        await adapter.frameQueue;
        await flush();
        expect(adapter.connectionState).to.equal(true);

        const callback = sinon.stub();
        adapter.onUnload(callback);
        await adapter.unloadPromise;

        expect(callback.calledOnce).to.equal(true);
        expect(adapter.watchDogInterval).to.equal(undefined);
        expect(adapter.connectionState).to.equal(false);
        expect(adapter.setStateAsync.lastCall.args).to.deep.equal(['info.connection', { val: false, ack: true }]);
        expect(ports[0].isOpen).to.equal(false);
        expect(ports[0].closeCalls).to.equal(1);
    });
});

describe('VE.Direct configuration and unload', () => {
    for (const name of ['expireTime', 'messageBuffer']) {
        it(`rejects invalid negative ${name} without starting a watchdog`, async () => {
            const adapter = harness();
            adapter.config[name] = -1;
            adapter.initConnectionObject = sinon.stub().resolves();
            adapter.handleReady();
            await adapter.readyPromise;
            expect(adapter.log.error.called).to.equal(true);
            expect(adapter.watchDogInterval).to.equal(undefined);
        });
    }

    it('opens a validated raw TCP target without requiring a local serial device', async () => {
        const adapter = harness();
        adapter.config = {
            byTCPIP: true,
            tcpHost: ' 127.0.0.1 ',
            tcpPort: '1234',
            USBDevice: '',
            expireTime: 0,
            messageBuffer: 0,
        };
        adapter.initConnectionObject = sinon.stub().resolves();
        await adapter.onReady();
        clearInterval(adapter.watchDogInterval);
        adapter.watchDogInterval = undefined;
        await adapter.activeWatchDog;
        expect(adapter.serialPortPath).to.equal('');
        expect(adapter.connectionTarget).to.deep.equal({ host: '127.0.0.1', port: 1234 });
        expect(Object.isFrozen(adapter.connectionTarget)).to.equal(true);
        expect(adapter.com.open.calledOnceWithExactly(adapter.connectionTarget)).to.equal(true);
    });

    it('retains the existing serial configuration unless raw TCP is explicitly enabled', () => {
        const adapter = harness();
        adapter.config = { USBDevice: ' /dev/ttyUSB9 ', byTCPIP: false, tcpHost: 'ignored', tcpPort: 1234 };
        expect(adapter.configureConnectionTarget()).to.equal('/dev/ttyUSB9');
        expect(adapter.connectionTarget).to.equal('/dev/ttyUSB9');
    });

    for (const [host, port] of [
        ['', 1234],
        ['http://127.0.0.1', 1234],
        ['127.0.0.1/path', 1234],
        ['127.0.0.1', 0],
        ['127.0.0.1', 65536],
        ['127.0.0.1', 12.5],
        ['127.0.0.1', '1e3'],
    ]) {
        it(`rejects invalid raw TCP target ${host}:${port} without opening a connection`, async () => {
            const adapter = harness();
            adapter.config = { byTCPIP: true, tcpHost: host, tcpPort: port, expireTime: 0, messageBuffer: 0 };
            adapter.initConnectionObject = sinon.stub().resolves();
            adapter.handleReady();
            await adapter.readyPromise;
            expect(adapter.com.open.called).to.equal(false);
            expect(adapter.watchDogInterval).to.equal(undefined);
            expect(adapter.log.error.called).to.equal(true);
        });
    }

    it('writes a final acknowledged disconnected state before unload callback', async () => {
        const adapter = harness();
        await adapter.publishFrame({ V: 13.29 });
        const callback = sinon.stub();
        adapter.onUnload(callback);
        await adapter.unloadPromise;
        expect(adapter.com.close.calledOnce).to.equal(true);
        expect(adapter.connectionState).to.equal(false);
        expect(adapter.setStateAsync.lastCall.args).to.deep.equal(['info.connection', { val: false, ack: true }]);
        expect(callback.calledOnce).to.equal(true);
    });

    it('keeps serial resources independent between two instances', async () => {
        const first = harness();
        const second = harness();
        const firstCallback = sinon.stub();
        first.onUnload(firstCallback);
        await first.unloadPromise;
        expect(first.com.close.calledOnce).to.equal(true);
        expect(second.com.close.called).to.equal(false);
        expect(second.unloaded).to.equal(false);
    });

    it('finishes unload even if close fails', async () => {
        const adapter = harness();
        adapter.com.close.rejects(new Error('close failed'));
        const callback = sinon.stub();
        adapter.onUnload(callback);
        await adapter.unloadPromise;
        expect(callback.calledOnce).to.equal(true);
        expect(adapter.log.error.called).to.equal(true);
    });

    it('finishes unload when initialization never settles', async () => {
        const adapter = harness();
        adapter.unloadTimeoutMs = 20;
        adapter.setObjectNotExistsAsync.returns(new Promise(() => undefined));
        adapter.handleReady();
        const callback = sinon.stub();
        adapter.onUnload(callback);
        await adapter.unloadPromise;
        expect(callback.calledOnce).to.equal(true);
    });

    it('finishes unload when pending state writes never settle', async () => {
        const adapter = harness();
        adapter.unloadTimeoutMs = 20;
        adapter.setObjectNotExistsAsync.returns(new Promise(() => undefined));
        adapter.enqueueFrame({ V: 13.29 });
        await new Promise(resolve => setImmediate(resolve));
        const callback = sinon.stub();
        adapter.onUnload(callback);
        await adapter.unloadPromise;
        expect(callback.calledOnce).to.equal(true);
    });

    it('does not resume startup work when control-object initialization settles after unload', async () => {
        const adapter = harness();
        adapter.unloadTimeoutMs = 20;
        adapter.config.hexReadEnabled = true;
        let releaseInit;
        adapter.initControlObjects = sinon.stub().returns(new Promise(resolve => (releaseInit = resolve)));
        adapter.handleReady();
        await flush();
        const callback = sinon.stub();
        adapter.onUnload(callback);
        await adapter.unloadPromise;
        expect(callback.calledOnce).to.equal(true);
        const writesBefore = adapter.setStateAsync.callCount + adapter.setStateChangedAsync.callCount;
        releaseInit();
        await adapter.readyPromise;
        await flush();
        expect(adapter.setStateAsync.callCount + adapter.setStateChangedAsync.callCount).to.equal(writesBefore);
        expect(adapter.subscribeStatesAsync.called).to.equal(false);
        expect(adapter.hexClient).to.equal(undefined);
        expect(adapter.com.onValidFrame).to.equal(undefined);
        expect(adapter.com.onPortClosed).to.equal(undefined);
    });

    it('invokes each registered unload callback exactly once', async () => {
        const adapter = harness();
        adapter.unloadTimeoutMs = 20;
        adapter.setObjectNotExistsAsync.returns(new Promise(() => undefined));
        adapter.enqueueFrame({ V: 13.29 });
        await new Promise(resolve => setImmediate(resolve));
        const first = sinon.stub();
        const second = sinon.stub();
        adapter.onUnload(first);
        adapter.onUnload(second);
        await adapter.unloadPromise;
        expect(first.calledOnce).to.equal(true);
        expect(second.calledOnce).to.equal(true);
    });
});

describe('VE.Direct validated HEX adapter integration', () => {
    const adapters = [];
    function make(options) {
        const adapter = hexHarness(options);
        adapters.push(adapter);
        return adapter;
    }

    afterEach(() => {
        for (const adapter of adapters.splice(0)) {
            if (adapter.currentLimitTimer) {
                clearInterval(adapter.currentLimitTimer);
            }
        }
    });

    it('publishes an inactive supervisor on every adapter start', async () => {
        const adapter = harness();
        adapter.initConnectionObject = sinon.stub().resolves();
        adapter.watchDog = sinon.stub().resolves();
        await adapter.onReady();
        if (adapter.watchDogInterval) {
            clearInterval(adapter.watchDogInterval);
            adapter.watchDogInterval = undefined;
        }
        expect(adapter.currentLimitActive).to.equal(false);
        expect(adapter.setStateAsync.calledWith('control.currentLimitActive', { val: false, ack: true })).to.equal(
            true,
        );
    });

    it('migrates every control object read-only by default and enables only explicit controls', async () => {
        const adapter = make({ chargerControlEnabled: false, currentLimitControlEnabled: false });
        await adapter.initControlObjects();
        const commons = adapter.extendObjectAsync
            .getCalls()
            .filter(call => String(call.args[0]).startsWith('control.'))
            .map(call => [call.args[0], call.args[1].common]);
        expect(commons.length).to.be.greaterThanOrEqual(10);
        for (const [, common] of commons) {
            expect(common.write).to.equal(false);
        }
        const readOnlyLimit = commons.find(([id]) => id === 'control.chargeCurrentLimit')[1];
        expect(readOnlyLimit).not.to.have.property('max');

        adapter.chargerControlEnabled = true;
        adapter.currentLimitControlEnabled = true;
        await adapter.initControlObjects();
        const enabled = Object.fromEntries(
            adapter.extendObjectAsync
                .getCalls()
                .filter(call => String(call.args[0]).startsWith('control.'))
                .map(call => [call.args[0], call.args[1].common.write]),
        );
        expect(enabled['control.chargerOn']).to.equal(true);
        expect(enabled['control.chargeCurrentLimit']).to.equal(true);
        expect(enabled['control.currentLimitActive']).to.equal(true);
        expect(enabled['control.chargeVoltageSetpoint']).to.equal(false);
        expect(enabled['control.maximumBatteryCurrent']).to.equal(false);
    });

    it('bootstraps every whitelisted register and decodes external-control capability', async () => {
        const adapter = make();
        const values = {
            capabilities: 0x8000,
            deviceMode: true,
            deviceState: 3,
            remoteControlUsed: 2,
            networkMode: 'standalone',
            maxBatteryCurrent: 50,
            chargeCurrentLimit: 12.3,
            chargeVoltageSetpoint: 14.4,
        };
        for (const [name, value] of Object.entries(values)) {
            adapter.hexClient.getField.withArgs(name).resolves(value);
        }
        await adapter.refreshHexState();
        expect(adapter.hexClient.getField.callCount).to.equal(8);
        expect(adapter.externalControlSupported).to.equal(true);
        expect(adapter.setStateAsync.calledWith('control.capabilities', { val: 0x8000, ack: true })).to.equal(true);
        expect(adapter.setStateAsync.calledWith('control.externalControlSupported', { val: true, ack: true })).to.equal(
            true,
        );
        expect(adapter.setStateAsync.calledWith('control.chargerOn', { val: true, ack: true })).to.equal(true);
        expect(adapter.setStateAsync.calledWith('control.maximumBatteryCurrent', { val: 50, ack: true })).to.equal(
            true,
        );
        expect(adapter.setStateAsync.calledWith('control.chargeCurrentLimit', { val: 12.3, ack: true })).to.equal(true);
        expect(adapter.setStateAsync.calledWith('control.lastError', { val: '', ack: true })).to.equal(true);
    });

    it('continues after an unsupported register without publishing an invented value', async () => {
        const adapter = make();
        for (const name of [
            'capabilities',
            'deviceMode',
            'deviceState',
            'remoteControlUsed',
            'networkMode',
            'maxBatteryCurrent',
            'chargeVoltageSetpoint',
        ]) {
            adapter.hexClient.getField.withArgs(name).resolves(0);
        }
        adapter.hexClient.getField.withArgs('deviceMode').resolves(true);
        adapter.hexClient.getField.withArgs('networkMode').resolves('standalone');
        adapter.hexClient.getField.withArgs('chargeCurrentLimit').rejects(new Error('Unknown ID'));
        await adapter.refreshHexState();
        expect(adapter.hexClient.getField.callCount).to.equal(8);
        expect(adapter.setStateAsync.calledWith('control.chargeCurrentLimit')).to.equal(false);
        const lastError = adapter.setStateAsync.getCalls().find(call => call.args[0] === 'control.lastError');
        expect(lastError.args[1].val).to.contain('chargeCurrentLimit: Unknown ID');
    });

    it('deduplicates bootstrap per connection generation and retries after reconnect', async () => {
        const adapter = make();
        const values = {
            capabilities: 0,
            deviceMode: true,
            deviceState: 0,
            remoteControlUsed: 0,
            networkMode: 'standalone',
            maxBatteryCurrent: 50,
            chargeCurrentLimit: 0,
            chargeVoltageSetpoint: 0,
        };
        for (const [name, value] of Object.entries(values)) {
            adapter.hexClient.getField.withArgs(name).resolves(value);
        }
        await Promise.all([adapter.ensureHexBootstrap(), adapter.ensureHexBootstrap()]);
        await flush();
        expect(adapter.hexClient.getField.callCount).to.equal(8);
        await adapter.ensureHexBootstrap();
        expect(adapter.hexClient.getField.callCount).to.equal(8);

        adapter.connectionGeneration++;
        adapter.nextHexBootstrapAt = 0;
        await adapter.ensureHexBootstrap();
        expect(adapter.hexClient.getField.callCount).to.equal(16);
    });

    it('ignores acknowledged, deleted, unknown and foreign state events', async () => {
        const adapter = make();
        for (const [id, state] of [
            ['vedirect.0.control.chargerOn', { val: true, ack: true }],
            ['vedirect.0.control.chargerOn', null],
            ['vedirect.0.control.unknown', { val: true, ack: false }],
            ['other.1.control.chargerOn', { val: true, ack: false }],
        ]) {
            await adapter.performStateChange(id, state);
        }
        expect(adapter.hexClient.setField.called).to.equal(false);
    });

    it('rejects control writes without fresh valid TEXT data', async () => {
        const adapter = make();
        adapter.lastFrameTime = 0;
        await expect(
            adapter.performStateChange('vedirect.0.control.chargerOn', { val: true, ack: false }),
        ).to.be.rejectedWith('fresh valid TEXT');
        expect(adapter.hexClient.setField.called).to.equal(false);
    });

    it('fails closed when a control is disabled or not strictly boolean', async () => {
        const adapter = make({ chargerControlEnabled: false });
        await expect(
            adapter.performStateChange('vedirect.0.control.chargerOn', { val: true, ack: false }),
        ).to.be.rejectedWith('disabled');
        adapter.chargerControlEnabled = true;
        await expect(
            adapter.performStateChange('vedirect.0.control.chargerOn', { val: 1, ack: false }),
        ).to.be.rejectedWith('boolean');
        expect(adapter.hexClient.setField.called).to.equal(false);
    });

    it('publishes charger readback rather than the requested switch value', async () => {
        const adapter = make();
        adapter.hexClient.setField.withArgs('deviceMode', true).resolves(false);
        await adapter.performStateChange('vedirect.0.control.chargerOn', { val: true, ack: false });
        expect(adapter.hexClient.setField.calledOnceWith('deviceMode', true)).to.equal(true);
        expect(adapter.setStateAsync.calledWith('control.chargerOn', { val: false, ack: true })).to.equal(true);
    });

    it('rejects unsafe current caps and refresh settings before starting a watchdog', async () => {
        for (const config of [
            { currentLimitMax: 0, currentLimitRefreshSeconds: 20 },
            { currentLimitMax: 50, currentLimitRefreshSeconds: 4 },
            { currentLimitMax: 50, currentLimitRefreshSeconds: 51 },
            { currentLimitMax: 50, currentLimitRefreshSeconds: 5.5 },
            { currentLimitMax: 0.05, currentLimitRefreshSeconds: 20 },
            { currentLimitMax: 6553.5, currentLimitRefreshSeconds: 20 },
            { currentLimitMax: 12.30000000001, currentLimitRefreshSeconds: 20 },
            { currentLimitMax: 50, currentLimitRefreshSeconds: -1 },
        ]) {
            const adapter = harness();
            adapter.config = {
                USBDevice: '/dev/fake',
                expireTime: 0,
                messageBuffer: 0,
                currentLimitControlEnabled: true,
                ...config,
            };
            adapter.initConnectionObject = sinon.stub().resolves();
            await expect(adapter.onReady()).to.be.rejected;
            expect(adapter.watchDogInterval).to.equal(undefined);
        }
    });

    it('keeps disabled current settings inert instead of rejecting startup', async () => {
        const adapter = harness();
        adapter.config = {
            USBDevice: '/dev/fake',
            expireTime: 0,
            messageBuffer: 0,
            currentLimitControlEnabled: false,
            currentLimitMax: 0.05,
            currentLimitRefreshSeconds: -1,
        };
        adapter.initConnectionObject = sinon.stub().resolves();
        await adapter.onReady();
        clearInterval(adapter.watchDogInterval);
        adapter.watchDogInterval = undefined;
        await adapter.activeWatchDog;
        expect(adapter.currentLimitMax).to.equal(0);
        expect(adapter.currentLimitRefreshSeconds).to.equal(20);
        expect(adapter.log.error.called).to.equal(false);
    });

    it('requires external-control capability before any current-limit Set', async () => {
        const adapter = make({ externalControlSupported: false });
        await expect(adapter.applyCurrentLimit(10)).to.be.rejectedWith('does not advertise');
        expect(adapter.hexClient.setField.called).to.equal(false);

        adapter.externalControlSupported = undefined;
        adapter.hexClient.getField.withArgs('capabilities').resolves(0);
        await expect(adapter.applyCurrentLimit(10)).to.be.rejectedWith('does not advertise');
        expect(adapter.hexClient.setField.called).to.equal(false);
    });

    it('applies external mode and current with verified readbacks before activating the supervisor', async () => {
        const adapter = make();
        adapter.hexClient.setField.withArgs('networkMode', 5).resolves('external');
        adapter.hexClient.setField.withArgs('chargeCurrentLimit', 12.3).resolves(12.3);
        await adapter.performStateChange('vedirect.0.control.chargeCurrentLimit', { val: 12.3, ack: false });
        expect(adapter.hexClient.setField.getCalls().map(call => call.args)).to.deep.equal([
            ['chargeCurrentLimit', 12.3],
            ['networkMode', 5],
        ]);
        expect(adapter.desiredCurrentLimit).to.equal(12.3);
        expect(adapter.currentLimitActive).to.equal(true);
        expect(adapter.currentLimitTimer).not.to.equal(undefined);
        expect(adapter.setStateAsync.calledWith('control.currentLimitActive', { val: true, ack: true })).to.equal(true);
    });

    it('rejects out-of-range, coerced and silently rounded current values', async () => {
        const adapter = make();
        for (const value of [-0.1, 50.1, 12.34, '12.3', Number.NaN, Number.POSITIVE_INFINITY]) {
            await expect(
                adapter.performStateChange('vedirect.0.control.chargeCurrentLimit', { val: value, ack: false }),
            ).to.be.rejected;
        }
        expect(adapter.hexClient.setField.called).to.equal(false);
    });

    it('does not activate the supervisor on a current or network readback mismatch', async () => {
        const adapter = make();
        adapter.hexClient.setField.withArgs('networkMode', 5).resolves('external');
        adapter.hexClient.setField.withArgs('chargeCurrentLimit', 12.3).resolves(12.2);
        await expect(adapter.applyCurrentLimit(12.3)).to.be.rejectedWith('differs');
        expect(adapter.currentLimitActive).to.equal(false);
        expect(adapter.currentLimitTimer).to.equal(undefined);
        expect(adapter.hexClient.setField.withArgs('networkMode').called).to.equal(false);
        expect(adapter.setStateAsync.calledWith('control.currentLimitActive', { val: true, ack: true })).to.equal(
            false,
        );

        adapter.hexClient.setField.withArgs('chargeCurrentLimit', 12.3).resolves(12.3);
        adapter.hexClient.setField.withArgs('networkMode', 5).resolves('standalone');
        await expect(adapter.applyCurrentLimit(12.3)).to.be.rejectedWith('expected external');
    });

    it('never enables external control when the current-limit Set itself fails', async () => {
        const adapter = make();
        adapter.hexClient.setField.withArgs('chargeCurrentLimit', 10).rejects(new Error('current write failed'));
        await expect(adapter.applyCurrentLimit(10)).to.be.rejectedWith('current write failed');
        expect(adapter.hexClient.setField.withArgs('networkMode').called).to.equal(false);
        expect(adapter.currentLimitActive).to.equal(false);
        expect(adapter.currentLimitTimer).to.equal(undefined);
    });

    it('bounds rapid current changes to one pending adapter operation', async () => {
        const adapter = make();
        let releaseCurrent;
        adapter.hexClient.setField
            .withArgs('chargeCurrentLimit', 12.3)
            .returns(new Promise(resolve => (releaseCurrent = resolve)));
        adapter.hexClient.setField.withArgs('networkMode', 5).resolves('external');
        const first = adapter.performStateChange('vedirect.0.control.chargeCurrentLimit', {
            val: 12.3,
            ack: false,
        });
        await flush();
        await expect(
            adapter.performStateChange('vedirect.0.control.chargeCurrentLimit', { val: 10, ack: false }),
        ).to.be.rejectedWith('still pending');
        releaseCurrent(12.3);
        await first;
        expect(adapter.desiredCurrentLimit).to.equal(12.3);
        expect(adapter.hexClient.setField.withArgs('chargeCurrentLimit', 10).called).to.equal(false);
    });

    it('blocks an old capability from reactivating the gate after disconnect', async () => {
        const adapter = make();
        let releaseCapabilities;
        adapter.hexClient.getField.withArgs('capabilities').resolves(0x8000);
        adapter.setStateAsync
            .withArgs('control.capabilities')
            .returns(new Promise(resolve => (releaseCapabilities = resolve)));
        const refreshing = adapter.refreshHexState();
        await flush();
        await adapter.safeSetConnectionState(false);
        expect(adapter.externalControlSupported).to.equal(undefined);
        releaseCapabilities();
        await refreshing;
        expect(adapter.externalControlSupported).to.equal(undefined);
        expect(adapter.hexClient.getField.withArgs('deviceMode').called).to.equal(false);
    });

    it('prevents an external-mode Set when disconnect wins after current-limit state publication', async () => {
        const adapter = make();
        adapter.hexClient.setField.withArgs('networkMode', 5).resolves('external');
        adapter.hexClient.setField.withArgs('chargeCurrentLimit', 10).resolves(10);
        let releaseCurrentState;
        adapter.setStateAsync
            .withArgs('control.chargeCurrentLimit')
            .returns(new Promise(resolve => (releaseCurrentState = resolve)));
        const applying = adapter.applyCurrentLimit(10);
        const assertion = expect(applying).to.be.rejectedWith('unchanged open session');
        await flush();
        await adapter.safeSetConnectionState(false);
        releaseCurrentState();
        await assertion;
        expect(adapter.hexClient.setField.withArgs('networkMode').called).to.equal(false);
        expect(adapter.currentLimitActive).to.equal(false);
    });

    it('cannot reactivate the supervisor after unload during current state publication', async () => {
        const adapter = make();
        adapter.unloadTimeoutMs = 20;
        adapter.hexClient.setField.withArgs('networkMode', 5).resolves('external');
        adapter.hexClient.setField.withArgs('chargeCurrentLimit', 10).resolves(10);
        let releaseCurrentState;
        adapter.setStateAsync
            .withArgs('control.chargeCurrentLimit')
            .returns(new Promise(resolve => (releaseCurrentState = resolve)));
        const applying = adapter.applyCurrentLimit(10);
        const assertion = expect(applying).to.be.rejectedWith('unloading');
        await flush();
        adapter.onUnload(() => undefined);
        await adapter.unloadPromise;
        releaseCurrentState();
        await assertion;
        await flush();
        expect(adapter.unloaded).to.equal(true);
        expect(adapter.currentLimitActive).to.equal(false);
        expect(adapter.currentLimitTimer).to.equal(undefined);
        const activeWrites = adapter.setStateAsync
            .getCalls()
            .filter(call => call.args[0] === 'control.currentLimitActive')
            .map(call => call.args[1].val);
        expect(activeWrites[activeWrites.length - 1]).to.equal(false);
    });

    it('refreshes both registers but skips a stale TEXT link', async () => {
        const adapter = make();
        adapter.desiredCurrentLimit = 10;
        adapter.currentLimitActive = true;
        adapter.hexClient.setField.withArgs('networkMode', 5).resolves('external');
        adapter.hexClient.setField.withArgs('chargeCurrentLimit', 10).resolves(10);
        await adapter.runCurrentLimitSupervisor();
        expect(adapter.hexClient.setField.callCount).to.equal(2);

        adapter.hexClient.setField.resetHistory();
        adapter.lastFrameTime = 0;
        await adapter.runCurrentLimitSupervisor();
        expect(adapter.hexClient.setField.called).to.equal(false);
    });

    it('stops the local supervisor even when standalone readback fails', async () => {
        const adapter = make();
        adapter.currentLimitActive = true;
        adapter.desiredCurrentLimit = 10;
        adapter.currentLimitTimer = setInterval(() => undefined, 10000);
        adapter.hexClient.setField.withArgs('networkMode', 0).rejects(new Error('no response'));
        await expect(adapter.stopCurrentLimit()).to.be.rejectedWith('no response');
        expect(adapter.currentLimitActive).to.equal(false);
        expect(adapter.currentLimitTimer).to.equal(undefined);
        expect(adapter.setStateAsync.calledWith('control.currentLimitActive', { val: false, ack: true })).to.equal(
            true,
        );
        expect(adapter.setStateAsync.calledWith('control.lastError', { val: 'no response', ack: true })).to.equal(true);
    });

    it('requires a prior verified value before resuming the supervisor', async () => {
        const adapter = make();
        await expect(
            adapter.performStateChange('vedirect.0.control.currentLimitActive', { val: true, ack: false }),
        ).to.be.rejectedWith('before activating');
        expect(adapter.hexClient.setField.called).to.equal(false);
    });

    it('does not publish a late charger response or another write after unload', async () => {
        const adapter = make();
        let release;
        adapter.hexClient.setField.withArgs('deviceMode', true).returns(new Promise(resolve => (release = resolve)));
        const writing = adapter.performStateChange('vedirect.0.control.chargerOn', { val: true, ack: false });
        const assertion = expect(writing).to.be.rejectedWith('unloading');
        await flush();
        const callback = sinon.stub();
        adapter.onUnload(callback);
        await adapter.unloadPromise;
        release(true);
        await assertion;
        expect(adapter.setStateAsync.calledWith('control.chargerOn')).to.equal(false);
        expect(adapter.hexClient.setField.callCount).to.equal(1);
        expect(callback.calledOnce).to.equal(true);
    });

    it('does not start the external-mode Set when unload wins after current-limit readback', async () => {
        const adapter = make();
        let releaseCurrent;
        adapter.hexClient.setField
            .withArgs('chargeCurrentLimit', 10)
            .returns(new Promise(resolve => (releaseCurrent = resolve)));
        const applying = adapter.applyCurrentLimit(10);
        const assertion = expect(applying).to.be.rejectedWith('unloading');
        await flush();
        adapter.onUnload(() => undefined);
        await adapter.unloadPromise;
        releaseCurrent(10);
        await assertion;
        expect(adapter.hexClient.setField.withArgs('networkMode').called).to.equal(false);
        expect(adapter.currentLimitActive).to.equal(false);
        expect(adapter.currentLimitTimer).to.equal(undefined);
    });

    it('cancels HEX operations on disconnect and unload without a final Set', async () => {
        const adapter = make();
        adapter.currentLimitActive = true;
        adapter.desiredCurrentLimit = 10;
        adapter.currentLimitTimer = setInterval(() => undefined, 10000);
        await adapter.safeSetConnectionState(false);
        expect(adapter.hexClient.cancel.calledOnce).to.equal(true);
        expect(adapter.currentLimitActive).to.equal(false);
        expect(adapter.currentLimitTimer).to.equal(undefined);
        expect(adapter.desiredCurrentLimit).to.equal(undefined);
        expect(adapter.externalControlSupported).to.equal(undefined);
        adapter.lastFrameTime = Date.now();
        await adapter.runCurrentLimitSupervisor();
        expect(adapter.hexClient.setField.called).to.equal(false);

        const callback = sinon.stub();
        adapter.onUnload(callback);
        await adapter.unloadPromise;
        expect(adapter.currentLimitTimer).to.equal(undefined);
        expect(adapter.currentLimitActive).to.equal(false);
        expect(adapter.hexClient.cancel.callCount).to.be.greaterThanOrEqual(2);
        expect(adapter.hexClient.setField.called).to.equal(false);
        expect(adapter.setStateAsync.calledWith('control.currentLimitActive', { val: false, ack: true })).to.equal(
            true,
        );
        expect(callback.calledOnce).to.equal(true);
    });
});
