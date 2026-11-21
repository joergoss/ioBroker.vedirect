'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const proxyquire = require('proxyquire');
const { parseArgs, resourceSnapshot, resourceGrowthErrors, delay } = require('./helpers');

const MAX_RETAINED_SAMPLES = 2000;

class Adapter extends EventEmitter {}
const { Vedirect } = proxyquire.noCallThru()('../../main', {
    '@iobroker/adapter-core': { Adapter },
});

function makeFrame(voltageMv) {
    const body = Buffer.from(`\r\nV\t${voltageMv}\r\nVPV\t1000\r\nChecksum\t`, 'ascii');
    let sum = 0;
    for (const byte of body) {
        sum = (sum + byte) & 0xff;
    }
    return Buffer.concat([body, Buffer.from([(256 - sum) & 0xff])]);
}

function createAdapterHarness(host, port, namespace) {
    const adapter = new Vedirect();
    const writes = [];
    const errors = [];
    adapter.config = {
        byTCPIP: true,
        tcpHost: host,
        tcpPort: port,
        USBDevice: '',
        expireTime: 0,
        messageBuffer: 0,
        hexReadEnabled: false,
        chargerControlEnabled: false,
        currentLimitControlEnabled: false,
    };
    adapter.namespace = namespace;
    adapter.log = {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: text => errors.push(String(text)),
    };
    adapter.setObjectNotExistsAsync = async () => undefined;
    adapter.extendObjectAsync = async () => undefined;
    adapter.subscribeStatesAsync = async () => undefined;
    adapter.setStateAsync = async (id, state) => {
        writes.push({ id, state });
    };
    adapter.setStateChangedAsync = async (id, state) => {
        writes.push({ id, state });
    };
    return { adapter, writes, errors };
}

class FrameServer {
    constructor() {
        this.server = undefined;
        this.port = 0;
        this.sockets = new Set();
        this.frameTimer = undefined;
        this.frameIndex = 0;
        this.clientBytes = 0;
        this.accepted = 0;
        this.errors = [];
    }

    async listen() {
        this.server = net.createServer(socket => {
            this.accepted++;
            this.sockets.add(socket);
            socket.on('data', data => {
                this.clientBytes += data.length;
            });
            socket.on('error', error => {
                this.errors.push(/** @type {NodeJS.ErrnoException} */ (error).code || error.message);
            });
            socket.on('close', () => this.sockets.delete(socket));
        });
        const server = /** @type {net.Server} */ (this.server);
        await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
            const onError = error => reject(error);
            server.once('error', onError);
            server.listen({ port: 0, host: '127.0.0.1' }, () => {
                server.removeListener('error', onError);
                server.on('error', error => {
                    this.errors.push(/** @type {NodeJS.ErrnoException} */ (error).code || error.message);
                });
                resolve();
            });
        }));
        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('Loopback server has no numeric TCP port');
        }
        this.port = address.port;
        this.startFrames();
    }

    startFrames() {
        if (this.frameTimer) {
            return;
        }
        this.frameTimer = setInterval(() => {
            this.frameIndex++;
            const frame = makeFrame(13000 + (this.frameIndex % 100));
            for (const socket of this.sockets) {
                if (!socket.destroyed && socket.writable) {
                    socket.write(frame);
                }
            }
        }, 50);
        this.frameTimer.unref();
    }

    stopFrames() {
        if (this.frameTimer) {
            clearInterval(this.frameTimer);
            this.frameTimer = undefined;
        }
    }

    fin() {
        this.stopFrames();
        for (const socket of this.sockets) {
            socket.end();
        }
        this.startFrames();
    }

    rst() {
        this.stopFrames();
        for (const socket of this.sockets) {
            socket.resetAndDestroy();
        }
        this.startFrames();
    }

    async close() {
        this.stopFrames();
        for (const socket of this.sockets) {
            socket.destroy();
        }
        const server = this.server;
        if (server?.listening) {
            await /** @type {Promise<void>} */ (new Promise(resolve => server.close(() => resolve())));
        }
    }
}

class SoakRunner {
    constructor(options) {
        this.options = options;
        this.abortController = new AbortController();
        this.abortExitCode = 0;
        this.active = new Set();
        this.samples = [];
        this.sampleCursor = 0;
        this.droppedSamples = 0;
        this.events = [];
        this.errors = [];
        this.shutdown = false;
        this.sampleTimer = undefined;
        this.finishPromise = undefined;
        this.processBaseline = resourceSnapshot();
        this.instanceSequence = 0;
    }

    abort(exitCode) {
        if (!this.shutdown) {
            this.shutdown = true;
            this.abortExitCode = exitCode;
            this.abortController.abort();
        }
    }

    abortableDelay(milliseconds) {
        const signal = this.abortController.signal;
        if (signal.aborted) {
            return Promise.reject(new Error('Soak run aborted by signal'));
        }
        return /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                signal.removeEventListener('abort', onAbort);
                resolve();
            }, milliseconds);
            const onAbort = () => {
                clearTimeout(timer);
                reject(new Error('Soak run aborted by signal'));
            };
            signal.addEventListener('abort', onAbort, { once: true });
        }));
    }

    async withAbort(promise) {
        const signal = this.abortController.signal;
        if (signal.aborted) {
            throw new Error('Soak run aborted by signal');
        }
        /** @type {() => void} */
        let onAbort = () => undefined;
        const cancellation = new Promise((_, reject) => {
            onAbort = () => reject(new Error('Soak run aborted by signal'));
            signal.addEventListener('abort', onAbort, { once: true });
        });
        try {
            return await Promise.race([promise, cancellation]);
        } finally {
            signal.removeEventListener('abort', onAbort);
        }
    }

    async waitFor(predicate, timeoutMs, description) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (this.shutdown) {
                throw new Error('Soak run aborted by signal');
            }
            if (predicate()) {
                return;
            }
            await this.abortableDelay(50);
        }
        throw new Error(`Timed out waiting for ${description}`);
    }

    async waitForCleanup(predicate, timeoutMs, description) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (predicate()) {
                return;
            }
            await delay(50);
        }
        throw new Error(`Timed out waiting for ${description}`);
    }

    async startPair(host = '127.0.0.1', scenario) {
        const server = new FrameServer();
        const harness = createAdapterHarness(host, 0, `soak.${this.instanceSequence++}`);
        const pair = { server, scenario, ...harness };
        this.active.add(pair);
        await server.listen();
        pair.adapter.config.tcpPort = server.port;
        if (this.shutdown) {
            throw new Error('Soak run aborted by signal');
        }
        this.sample('pair-start', [pair]);
        pair.adapter.handleReady();
        await this.withAbort(pair.adapter.readyPromise);
        if (host === '127.0.0.1') {
            await this.waitFor(() => pair.adapter.connectionState === true, 10000, 'initial valid frame');
        }
        return pair;
    }

    async cleanupPair(pair) {
        let failure;
        try {
            pair.server.stopFrames();
            if (!pair.adapter.unloaded) {
                pair.adapter.onUnload(() => undefined);
                await pair.adapter.unloadPromise;
            }
            await pair.server.close();
            await this.waitForCleanup(() => pair.server.sockets.size === 0, 2000, 'server sockets to close');
            assert.equal(pair.adapter.com.isOpen(), false);
            assert.equal(pair.adapter.com.port, undefined);
            assert.equal(pair.adapter.watchDogInterval, undefined);
            assert.equal(pair.adapter.activeWatchDog, undefined);
            assert.equal(pair.adapter.currentLimitTimer, undefined);
            assert.equal(pair.adapter.pendingFrameBatch, null);
            assert.equal(pair.adapter.stateQueues.size, 0);
            assert.equal(pair.adapter.diagnosticDrains.size, 0);
            assert.equal(pair.server.clientBytes, 0, 'adapter must not write any bytes or HEX Sets');
            for (const write of pair.writes) {
                if (typeof write.state.val === 'number') {
                    assert.equal(Number.isFinite(write.state.val), true, `non-finite state ${write.id}`);
                }
            }
            this.assertExpectedErrors(pair);
        } catch (error) {
            failure = error;
        } finally {
            pair.server.stopFrames();
            try {
                if (!pair.adapter.unloaded) {
                    pair.adapter.onUnload(() => undefined);
                    await pair.adapter.unloadPromise;
                }
            } catch (error) {
                failure ||= error;
            }
            try {
                await pair.server.close();
            } catch (error) {
                failure ||= error;
            }
            this.active.delete(pair);
        }
        if (failure) {
            throw failure;
        }
        this.sample('pair-clean', [pair]);
    }

    assertExpectedErrors(pair) {
        const scenario = pair.scenario;
        const allowedAdapter = {
            fin: [/Serial port closed unexpectedly/],
            independent: [/Serial port closed unexpectedly/],
            rst: [/ECONNRESET/],
            stop: [],
            dns: [/ENOTFOUND/],
        }[scenario];
        const allowedServer = {
            fin: ['ECONNRESET'],
            independent: ['ECONNRESET'],
            rst: ['ECONNRESET'],
            stop: ['ECONNRESET'],
            dns: ['ECONNRESET'],
        }[scenario];
        assert(allowedAdapter && allowedServer, `Missing error policy for scenario ${scenario}`);
        const unexpectedAdapter = pair.errors.filter(error => !allowedAdapter.some(pattern => pattern.test(error)));
        const unexpectedServer = pair.server.errors.filter(code => !allowedServer.includes(code));
        assert.deepEqual(unexpectedAdapter, [], `unexpected ${scenario} adapter errors`);
        assert.deepEqual(unexpectedServer, [], `unexpected ${scenario} server errors`);
    }

    async cleanupActive() {
        const pairs = [...this.active];
        const results = await Promise.allSettled(pairs.map(pair => this.cleanupPair(pair)));
        for (let index = 0; index < results.length; index++) {
            const result = results[index];
            if (result.status === 'rejected') {
                this.errors.push(`${pairs[index].adapter.namespace}: ${String(result.reason)}`);
            }
        }
    }

    sample(label, pairs = [...this.active]) {
        const sample = {
            at: new Date().toISOString(),
            label,
            ...resourceSnapshot(),
            pairs: pairs.map(pair => ({
                connectionState: pair.adapter.connectionState,
                sessionId: pair.adapter.com.sessionId,
                successfulOpenCount: pair.adapter.successfulOpenCount,
                reconnectCount: pair.adapter.reconnectCount,
                lastValidFrameAt: pair.adapter.lastValidFrameAt,
                activeWatchDog: pair.adapter.activeWatchDog !== undefined,
                watchDogInterval: pair.adapter.watchDogInterval !== undefined,
                stateQueues: pair.adapter.stateQueues.size,
                diagnosticDrains: pair.adapter.diagnosticDrains.size,
                stateWrites: pair.writes.length,
                serverSockets: pair.server.sockets.size,
                accepted: pair.server.accepted,
                serverErrors: [...pair.server.errors],
                clientBytes: pair.server.clientBytes,
            })),
        };
        if (this.samples.length < MAX_RETAINED_SAMPLES) {
            this.samples.push(sample);
        } else {
            this.droppedSamples++;
            this.samples[this.sampleCursor] = sample;
            this.sampleCursor = (this.sampleCursor + 1) % MAX_RETAINED_SAMPLES;
        }
    }

    recoveryEvidence(pair, before) {
        assert(pair.server.accepted > before.accepted, 'server must accept a new connection');
        assert(pair.adapter.com.sessionId > before.sessionId, 'session must change');
        assert(pair.adapter.lastValidFrameAt > before.lastValidFrameAt, 'a newer valid frame is required');
        assert(
            pair.writes.slice(before.writes).some(write => write.id === 'V' && write.state.val > 0),
            'a real V payload must be published after recovery',
        );
    }

    async runReconnectScenario(name) {
        const pair = await this.startPair('127.0.0.1', name);
        const before = {
            accepted: pair.server.accepted,
            sessionId: pair.adapter.com.sessionId,
            lastValidFrameAt: pair.adapter.lastValidFrameAt,
            writes: pair.writes.length,
        };
        const started = Date.now();
        pair.server[name]();
        if (name === 'rst') {
            await this.waitFor(() => pair.adapter.lastTransportError === 'ECONNRESET', 10000, 'RST ECONNRESET');
        }
        await this.waitFor(
            () => pair.adapter.reconnectCount === 1 && pair.adapter.connectionState === true,
            20000,
            `${name.toUpperCase()} reconnect`,
        );
        assert.equal(pair.adapter.successfulOpenCount, 2);
        this.recoveryEvidence(pair, before);
        if (name === 'rst') {
            assert.equal(pair.adapter.lastTransportError, 'ECONNRESET');
        } else {
            assert.notEqual(pair.adapter.lastTransportError, 'ECONNRESET');
        }
        this.events.push({ scenario: name, milliseconds: Date.now() - started, reconnectCount: 1 });
        await this.cleanupPair(pair);
    }

    async runStopScenario() {
        const pair = await this.startPair('127.0.0.1', 'stop');
        const before = {
            accepted: pair.server.accepted,
            sessionId: pair.adapter.com.sessionId,
            lastValidFrameAt: pair.adapter.lastValidFrameAt,
            writes: pair.writes.length,
        };
        const started = Date.now();
        pair.server.stopFrames();
        await this.waitFor(
            () => pair.adapter.reconnectCount === 1 && pair.server.accepted > before.accepted,
            20000,
            'new socket after data stop',
        );
        pair.server.startFrames();
        await this.waitFor(() => pair.adapter.connectionState === true, 10000, 'fresh data after stop');
        assert.equal(pair.adapter.successfulOpenCount, 2);
        this.recoveryEvidence(pair, before);
        this.events.push({ scenario: 'stop', milliseconds: Date.now() - started, reconnectCount: 1 });
        await this.cleanupPair(pair);
    }

    async runDnsScenario() {
        const pair = await this.startPair('nonexistent.invalid.', 'dns');
        const started = Date.now();
        await this.waitFor(() => pair.adapter.lastTransportError === 'ENOTFOUND', 15000, 'DNS ENOTFOUND');
        assert.equal(pair.adapter.successfulOpenCount, 0);
        assert.equal(pair.adapter.reconnectCount, 0);
        const before = {
            accepted: pair.server.accepted,
            sessionId: pair.adapter.com.sessionId,
            lastValidFrameAt: pair.adapter.lastValidFrameAt,
            writes: pair.writes.length,
        };
        pair.adapter.config.tcpHost = '127.0.0.1';
        pair.adapter.configureConnectionTarget();
        await this.waitFor(() => pair.adapter.connectionState === true, 15000, 'recovery after DNS failure');
        assert.equal(pair.adapter.successfulOpenCount, 1);
        assert.equal(pair.adapter.reconnectCount, 0);
        this.recoveryEvidence(pair, before);
        this.events.push({ scenario: 'dns', milliseconds: Date.now() - started, reconnectCount: 0 });
        await this.cleanupPair(pair);
    }

    async runIndependentScenario() {
        const first = await this.startPair('127.0.0.1', 'independent');
        const second = await this.startPair('127.0.0.1', 'independent');
        const before = {
            accepted: first.server.accepted,
            sessionId: first.adapter.com.sessionId,
            lastValidFrameAt: first.adapter.lastValidFrameAt,
            writes: first.writes.length,
        };
        const secondBefore = second.adapter.lastValidFrameAt;
        const started = Date.now();
        first.server.fin();
        await this.waitFor(
            () => first.adapter.reconnectCount === 1 && first.adapter.connectionState === true,
            20000,
            'independent A reconnect',
        );
        this.recoveryEvidence(first, before);
        assert.equal(second.adapter.connectionState, true);
        assert(second.adapter.lastValidFrameAt > secondBefore, 'B must continue receiving fresh frames');
        assert.equal(second.adapter.reconnectCount, 0);
        assert.equal(second.adapter.successfulOpenCount, 1);
        this.events.push({ scenario: 'independent', milliseconds: Date.now() - started, first: 1, second: 0 });
        await Promise.all([this.cleanupPair(first), this.cleanupPair(second)]);
    }

    async runScenario(name) {
        if (name === 'fin' || name === 'rst') {
            await this.runReconnectScenario(name);
        } else if (name === 'dns') {
            await this.runDnsScenario();
        } else if (name === 'stop') {
            await this.runStopScenario();
        } else if (name === 'independent') {
            await this.runIndependentScenario();
        } else {
            throw new RangeError(`Unsupported scenario ${name}`);
        }
    }

    async finalResourceSnapshot() {
        const snapshots = [resourceSnapshot()];
        await delay(100);
        snapshots.push(resourceSnapshot());
        await delay(100);
        snapshots.push(resourceSnapshot());
        const median = key => snapshots.map(snapshot => snapshot[key]).sort((a, b) => a - b)[1];
        return {
            heapUsedMb: median('heapUsedMb'),
            heapTotalMb: median('heapTotalMb'),
            rssMb: median('rssMb'),
            resources: snapshots[2].resources,
        };
    }

    async finish(exitCode = 0) {
        if (this.finishPromise) {
            return this.finishPromise;
        }
        this.finishPromise = (async () => {
            if (this.sampleTimer) {
                clearInterval(this.sampleTimer);
                this.sampleTimer = undefined;
            }
            await this.cleanupActive();
            const finalResources = await this.finalResourceSnapshot();
            this.errors.push(...resourceGrowthErrors(this.processBaseline, finalResources));
            const report = {
                passed: this.errors.length === 0 && !this.shutdown,
                aborted: this.shutdown,
                parameters: this.options,
                baseline: this.processBaseline,
                final: finalResources,
                droppedSamples: this.droppedSamples,
                events: this.events,
                samples: this.samples,
                errors: this.errors,
            };
            if (this.options.output) {
                const outputPath = path.resolve(this.options.output);
                fs.mkdirSync(path.dirname(outputPath), { recursive: true });
                fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
            }
            console.log(JSON.stringify(report, null, 2));
            process.exitCode = exitCode || this.abortExitCode || (report.passed ? 0 : 1);
            return report;
        })();
        return this.finishPromise;
    }

    async run() {
        this.sampleTimer = setInterval(() => this.sample('periodic'), this.options.sampleSeconds * 1000);
        try {
            if (this.options.scenario === 'short' || this.options.scenario === 'cycle') {
                const deadline = Date.now() + this.options.durationSeconds * 1000;
                do {
                    for (const scenario of ['fin', 'rst', 'dns', 'stop', 'independent']) {
                        if (this.shutdown) {
                            break;
                        }
                        await this.runScenario(scenario);
                    }
                } while (this.options.scenario === 'cycle' && Date.now() < deadline && !this.shutdown);
            } else {
                await this.runScenario(this.options.scenario);
            }
        } catch (error) {
            this.errors.push(error instanceof Error ? error.stack : String(error));
        }
        return this.finish();
    }
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const runner = new SoakRunner(options);
    process.once('SIGINT', () => runner.abort(130));
    process.once('SIGTERM', () => runner.abort(143));
    await runner.run();
}

if (require.main === module) {
    void main().catch(error => {
        console.error(error instanceof Error ? error.stack : String(error));
        process.exitCode = 1;
    });
}

module.exports = { FrameServer, SoakRunner, makeFrame };
