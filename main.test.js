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
    };
    adapter.config = { USBDevice: '/dev/fake', expireTime: 0, messageBuffer: 0 };
    adapter.serialPortPath = '/dev/fake';
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
    adapter.hexClient = {
        getField: sinon.stub(),
        setField: sinon.stub(),
        cancel: sinon.stub(),
    };
    adapter.lastFrameTime = Date.now();
    return adapter;
}

function flush() {
    return new Promise(resolve => setImmediate(resolve));
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
            toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
        });
    }

    async function startAdapter(adapter) {
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
            { currentLimitMax: 0.05, currentLimitRefreshSeconds: 20 },
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
            ['networkMode', 5],
            ['chargeCurrentLimit', 12.3],
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
        expect(adapter.setStateAsync.calledWith('control.currentLimitActive', { val: true, ack: true })).to.equal(
            false,
        );

        adapter.hexClient.setField.withArgs('networkMode', 5).resolves('standalone');
        await expect(adapter.applyCurrentLimit(12.3)).to.be.rejectedWith('expected external');
    });

    it('bounds rapid current changes to one pending adapter operation', async () => {
        const adapter = make();
        let releaseMode;
        adapter.hexClient.setField.withArgs('networkMode', 5).returns(new Promise(resolve => (releaseMode = resolve)));
        adapter.hexClient.setField.withArgs('chargeCurrentLimit', 12.3).resolves(12.3);
        const first = adapter.performStateChange('vedirect.0.control.chargeCurrentLimit', {
            val: 12.3,
            ack: false,
        });
        await flush();
        await expect(
            adapter.performStateChange('vedirect.0.control.chargeCurrentLimit', { val: 10, ack: false }),
        ).to.be.rejectedWith('still pending');
        releaseMode('external');
        await first;
        expect(adapter.desiredCurrentLimit).to.equal(12.3);
        expect(adapter.hexClient.setField.withArgs('chargeCurrentLimit', 10).called).to.equal(false);
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

    it('does not start the current Set when unload wins after network-mode readback', async () => {
        const adapter = make();
        let releaseMode;
        adapter.hexClient.setField.withArgs('networkMode', 5).returns(new Promise(resolve => (releaseMode = resolve)));
        const applying = adapter.applyCurrentLimit(10);
        const assertion = expect(applying).to.be.rejectedWith('unloading');
        await flush();
        adapter.onUnload(() => undefined);
        await adapter.unloadPromise;
        releaseMode('external');
        await assertion;
        expect(adapter.hexClient.setField.withArgs('chargeCurrentLimit').called).to.equal(false);
        expect(adapter.currentLimitActive).to.equal(false);
        expect(adapter.currentLimitTimer).to.equal(undefined);
    });

    it('cancels HEX operations on disconnect and unload without a final Set', async () => {
        const adapter = make();
        adapter.currentLimitActive = true;
        adapter.currentLimitTimer = setInterval(() => undefined, 10000);
        await adapter.safeSetConnectionState(false);
        expect(adapter.hexClient.cancel.calledOnce).to.equal(true);
        expect(adapter.externalControlSupported).to.equal(undefined);

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
