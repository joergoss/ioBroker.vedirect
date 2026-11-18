'use strict';

const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');
const { expect } = require('chai');
const { VeDirectCom } = require('./lib/veDirectCom');
const { VeDirectHexClient } = require('./lib/veDirectHexClient');

const HELPER_PATH = path.join(__dirname, 'test', 'helpers', 'pty_mppt.py');
const RPC_TIMEOUT_MS = 2000;
const OPERATION_TIMEOUT_MS = 2500;
let SerialPort;

function supportReason() {
    if (process.platform === 'win32') {
        return 'POSIX PTYs are unavailable on Windows';
    }
    const python = spawnSync('python3', ['-c', 'import os; m,s = os.openpty(); os.close(m); os.close(s)'], {
        encoding: 'utf8',
        timeout: 2000,
    });
    if (python.error) {
        return `python3/os.openpty preflight failed: ${python.error.message}`;
    }
    if (python.status !== 0) {
        return `python3/os.openpty preflight failed with status ${python.status}: ${(python.stderr || '').trim()}`;
    }
    try {
        ({ SerialPort } = require('serialport'));
        // serialport lazy-loads the native addon on open. Load it here so a
        // missing/incompatible SerialPort 12 binding causes an honest suite skip.
        require('@serialport/bindings-cpp/dist/load-bindings');
    } catch (error) {
        return `SerialPort 12 native binding is unavailable: ${error.message}`;
    }
    return undefined;
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

async function bounded(promise, milliseconds, label) {
    let timer;
    const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds} ms`)), milliseconds);
    });
    try {
        return await Promise.race([Promise.resolve(promise), timeout]);
    } finally {
        clearTimeout(timer);
    }
}

function closeRawPort(port) {
    if (!port?.isOpen) {
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        port.close(error => (error ? reject(error) : resolve()));
    });
}

/** Owner for one Python process, its two PTY pairs, and bounded JSON RPC. */
class PtyProcess {
    constructor() {
        this.nextId = 1;
        this.pending = new Map();
        this.events = [];
        this.waiters = new Set();
        this.stderr = '';
        this.failure = undefined;
        this.exited = false;
        this.stopping = false;
        this.child = spawn('python3', ['-u', HELPER_PATH], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
        });
        this.lines = readline.createInterface({ input: this.child.stdout });
        this.lines.on('line', line => this.onLine(line));
        this.child.stderr.on('data', data => {
            this.stderr = `${this.stderr}${data.toString('utf8')}`.slice(-16384);
        });
        this.child.stdin.on('error', error => this.fail(error));
        this.child.on('error', error => this.fail(error));
        this.closed = new Promise(resolve => {
            this.child.once('close', (code, signal) => {
                this.exited = true;
                if (!this.stopping) {
                    this.fail(new Error(`PTY helper exited early (code=${code}, signal=${signal}): ${this.stderr}`));
                }
                resolve();
            });
        });
    }

    fail(error) {
        if (this.failure) {
            return;
        }
        this.failure = error instanceof Error ? error : new Error(String(error));
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(this.failure);
        }
        this.pending.clear();
        for (const waiter of this.waiters) {
            clearTimeout(waiter.timer);
            waiter.reject(this.failure);
        }
        this.waiters.clear();
    }

    onLine(line) {
        let message;
        try {
            message = JSON.parse(line);
        } catch (error) {
            this.fail(new Error(`Invalid PTY helper JSON ${JSON.stringify(line)}: ${error.message}`));
            return;
        }
        if (message.type === 'result') {
            const pending = this.pending.get(message.id);
            if (!pending) {
                return;
            }
            this.pending.delete(message.id);
            clearTimeout(pending.timer);
            if (message.ok) {
                pending.resolve(message.result);
            } else {
                pending.reject(new Error(`PTY helper RPC failed: ${message.error}`));
            }
            return;
        }
        this.events.push(message);
        for (const waiter of [...this.waiters]) {
            if (waiter.predicate(message)) {
                this.waiters.delete(waiter);
                clearTimeout(waiter.timer);
                waiter.resolve(message);
            }
        }
    }

    waitForEvent(predicate, label, timeoutMs = RPC_TIMEOUT_MS) {
        if (this.failure) {
            return Promise.reject(this.failure);
        }
        const existing = this.events.find(predicate);
        if (existing) {
            return Promise.resolve(existing);
        }
        return new Promise((resolve, reject) => {
            const waiter = { predicate, resolve, reject, timer: undefined };
            waiter.timer = setTimeout(() => {
                this.waiters.delete(waiter);
                reject(new Error(`${label} was not received within ${timeoutMs} ms; stderr: ${this.stderr}`));
            }, timeoutMs);
            this.waiters.add(waiter);
        });
    }

    async start() {
        try {
            const ready = await this.waitForEvent(message => message.type === 'ready', 'PTY helper readiness');
            this.paths = ready.devices;
            return this;
        } catch (error) {
            await this.stop();
            throw error;
        }
    }

    call(operation, fields = {}, timeoutMs = RPC_TIMEOUT_MS) {
        if (this.failure || this.exited) {
            return Promise.reject(this.failure || new Error('PTY helper has exited'));
        }
        const id = this.nextId++;
        const message = { id, op: operation, ...fields };
        const result = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`PTY helper ${operation} RPC exceeded ${timeoutMs} ms; stderr: ${this.stderr}`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
        });
        this.child.stdin.write(`${JSON.stringify(message)}\n`, error => {
            if (error) {
                this.fail(error);
            }
        });
        return result;
    }

    configure(device, behavior) {
        return this.call('configure', { device, behavior });
    }

    state(device) {
        return this.call('state', { device });
    }

    async stop() {
        if (this.stopping && this.exited) {
            return;
        }
        this.stopping = true;
        if (!this.exited) {
            try {
                await this.call('shutdown', {}, 300);
            } catch {
                // Forced process cleanup below is authoritative.
            }
        }
        if (!this.exited) {
            this.child.kill('SIGTERM');
            try {
                await bounded(this.closed, 500, 'PTY helper SIGTERM');
            } catch {
                this.child.kill('SIGKILL');
            }
        }
        if (!this.exited) {
            await bounded(this.closed, 1000, 'PTY helper SIGKILL').catch(() => undefined);
        }
        this.lines.close();
        this.child.stdin.destroy();
        this.child.stdout.destroy();
        this.child.stderr.destroy();
    }
}

const unsupported = supportReason();
const ptyDescribe = unsupported ? describe.skip : describe;
const suiteName = `VE.Direct real POSIX PTYs (SerialPort 12)${unsupported ? ` — SKIPPED: ${unsupported}` : ''}`;

ptyDescribe(suiteName, function () {
    this.timeout(10000);
    const helpers = [];
    const communications = [];
    const clients = [];
    const rawPorts = [];
    let helper;

    async function startHelper() {
        const process = new PtyProcess();
        helpers.push(process);
        await process.start();
        return process;
    }

    async function openDevice(device, responseTimeoutMs = 800) {
        const ptySetFallbacks = [];
        const portFactory = (portPath, options, callback) => {
            const port = new SerialPort({ path: portPath, baudRate: options.baudRate, lock: true }, error => {
                if (!error && Number(process.versions.node.split('.')[0]) >= 26) {
                    // A native Poller callback on Node 26 may not reach a JS
                    // microtask checkpoint before another port's close callback.
                    // Give each genuine readable event one ordinary JS turn; no
                    // event, byte, poll, file descriptor or read call is synthesized.
                    const poller = port.port.poller;
                    const nativeEmit = poller.emit;
                    poller.emit = function (event, ...args) {
                        const emitted = nativeEmit.call(this, event, ...args);
                        if (event === 'readable') {
                            setImmediate(() => undefined);
                        }
                        return emitted;
                    };
                }
                callback(error);
            });
            const nativeSet = port.set.bind(port);
            port.set = (settings, setCallback) => {
                nativeSet(settings, error => {
                    // Record PTY-only ioctl gaps, but return the native error to
                    // VeDirectCom. Production must handle precisely this case.
                    if (error && /Inappropriate ioctl for device, cannot set/.test(error.message)) {
                        ptySetFallbacks.push(error);
                    }
                    setCallback(error);
                });
            };
            return port;
        };
        const com = new VeDirectCom(portFactory, {
            openTimeoutMs: 1800,
            closeTimeoutMs: 1200,
            writeTimeoutMs: 1200,
            drainTimeoutMs: 1200,
        });
        const client = new VeDirectHexClient(com, { responseTimeoutMs });
        communications.push(com);
        clients.push(client);
        com.serialErrors = [];
        com.ptySetFallbacks = ptySetFallbacks;
        com.onError = error => com.serialErrors.push(error);
        await bounded(com.open(helper.paths[device]), OPERATION_TIMEOUT_MS, `open ${device}`);
        expect(com.port.path).to.equal(helper.paths[device]);
        expect(com.port.baudRate).to.equal(19200);
        return { com, client };
    }

    function rejection(promise, pattern) {
        return bounded(expect(promise).to.be.rejectedWith(pattern), OPERATION_TIMEOUT_MS, 'expected rejection');
    }

    beforeEach(async () => {
        helper = await startHelper();
    });

    afterEach(async () => {
        for (const client of clients.splice(0)) {
            client.cancel(new Error('PTY test cleanup'));
        }
        await Promise.allSettled(
            communications
                .splice(0)
                .map(com =>
                    bounded(com.close(), 1200, 'serial cleanup').catch(() =>
                        bounded(com.close(), 500, 'serial cleanup retry').catch(() => undefined),
                    ),
                ),
        );
        await Promise.allSettled(
            rawPorts.splice(0).map(port => bounded(closeRawPort(port), 1000, 'raw serial cleanup')),
        );
        await Promise.allSettled(helpers.splice(0).map(process => bounded(process.stop(), 2500, 'PTY cleanup')));
    });

    it('runs two simultaneous independent banks without cross-associating delayed responses', async () => {
        const a = await openDevice('a');
        const b = await openDevice('b');
        await Promise.all([
            helper.configure('a', { mode: 'normal', delayMs: 70 }),
            helper.configure('b', { mode: 'normal', delayMs: 5 }),
        ]);

        const values = await Promise.all([
            a.client.getField('chargeCurrentLimit'),
            b.client.getField('chargeCurrentLimit'),
        ]);
        expect(values).to.deep.equal([1.2, 9.8]);
        expect(await a.client.getField('deviceState')).to.equal(3);
        expect(await b.client.getField('deviceState')).to.equal(5);
        const [stateA, stateB] = await Promise.all([helper.state('a'), helper.state('b')]);
        expect(stateA.registers['2015']).to.equal('0c00');
        expect(stateB.registers['2015']).to.equal('6200');
        expect(stateA.requests).to.have.length(2);
        expect(stateB.requests).to.have.length(2);
        expect(a.com.port).not.to.equal(b.com.port);
        expect(a.com.port.path).not.to.equal(b.com.port.path);
    });

    it('sets both banks and verifies exact Set acknowledgements plus Get readback', async () => {
        const a = await openDevice('a');
        const b = await openDevice('b');
        await Promise.all([
            helper.configure('a', { mode: 'normal', delayMs: 30 }),
            helper.configure('b', { mode: 'normal', delayMs: 2 }),
        ]);

        const values = await Promise.all([
            a.client.setField('chargeCurrentLimit', 2.4),
            b.client.setField('chargeCurrentLimit', 7.6),
        ]);
        expect(values).to.deep.equal([2.4, 7.6]);
        const [stateA, stateB] = await Promise.all([helper.state('a'), helper.state('b')]);
        expect(stateA.registers['2015']).to.equal('1800');
        expect(stateB.registers['2015']).to.equal('4c00');
        expect(stateA.requests.map(request => [request.command, request.registerId, request.valueHex])).to.deep.equal([
            [8, 0x2015, '1800'],
            [7, 0x2015, ''],
        ]);
        expect(stateB.requests.map(request => [request.command, request.registerId, request.valueHex])).to.deep.equal([
            [8, 0x2015, '4c00'],
            [7, 0x2015, ''],
        ]);
        expect(await a.client.getField('chargeCurrentLimit')).to.equal(2.4);
        expect(await b.client.getField('chargeCurrentLimit')).to.equal(7.6);
    });

    it('keeps the healthy PTY usable while another has no HEX response', async () => {
        const a = await openDevice('a', 180);
        const b = await openDevice('b');
        await helper.configure('a', { mode: 'hang' });
        const hung = rejection(a.client.getField('chargeCurrentLimit'), /timed out after 180 ms/);

        expect(await b.client.getField('chargeCurrentLimit')).to.equal(9.8);
        await hung;
        await bounded(a.com.close(), 1600, 'hung port close');
        expect(a.com.isOpen()).to.equal(false);
        expect(b.com.isOpen()).to.equal(true);
        expect(await b.client.setField('networkMode', 5)).to.equal('external');
        expect(await b.client.getField('chargeCurrentLimit')).to.equal(9.8);
        expect(b.com.serialErrors).to.deep.equal([]);
    });

    it('closing A neither closes nor delays operations on B', async () => {
        const a = await openDevice('a');
        const b = await openDevice('b');
        await a.com.close();
        expect(a.com.isOpen()).to.equal(false);

        expect(await b.client.getField('deviceState')).to.equal(5);
        expect(await b.client.setField('chargeCurrentLimit', 6.5)).to.equal(6.5);
        expect(await b.client.getField('chargeCurrentLimit')).to.equal(6.5);
        expect(b.com.isOpen()).to.equal(true);
        expect((await helper.state('b')).registers['2015']).to.equal('4100');
    });

    it('rejects a second cooperative lock:true SerialPort open of the same slave', async () => {
        const a = await openDevice('a');
        let second;
        const openResult = new Promise(resolve => {
            second = new SerialPort({ path: helper.paths.a, baudRate: 19200, lock: true }, error =>
                resolve(error || null),
            );
        });
        rawPorts.push(second);
        const error = await bounded(openResult, OPERATION_TIMEOUT_MS, 'second native open');
        expect(error, 'the second open must fail while the first lock is held').to.be.an('error');
        expect(error.message).to.match(/lock|busy|temporarily unavailable/i);
        expect(second.isOpen).to.equal(false);
        expect(a.com.isOpen()).to.equal(true);
        expect(await a.client.getField('chargeCurrentLimit')).to.equal(1.2);
    });

    it('streams independently checksummed TEXT and fragmented HEX through the real parser', async () => {
        const a = await openDevice('a');
        const frames = [];
        const validFrames = [];
        const received = deferred();
        a.com.onValidFrame = () => validFrames.push(true);
        a.com.onFrame = frame => {
            frames.push(frame);
            received.resolve(frame);
        };
        await helper.configure('a', {
            mode: 'normal',
            delayMs: 10,
            chunks: [1, 2, 1, 3, 5],
            chunkDelayMs: 2,
            prefixText: { voltageMv: 13456, currentMa: -1234 },
        });

        const reading = a.client.getField('chargeCurrentLimit');
        const frame = await bounded(received.promise, OPERATION_TIMEOUT_MS, 'chunked TEXT frame');
        expect(await bounded(reading, OPERATION_TIMEOUT_MS, 'chunked HEX response')).to.equal(1.2);
        expect(frame).to.deep.equal({ V: 13.456, I: -1.234 });
        expect(frames).to.deep.equal([{ V: 13.456, I: -1.234 }]);
        expect(validFrames).to.have.length(1);
        expect(a.com.parser.checksumErrors).to.equal(0);
        expect(a.com.parser.invalidFrames).to.equal(0);
        expect(a.com.parser.invalidHexMessages).to.equal(0);
        expect(a.com.parser.hexMessages).to.equal(1);
    });

    it('passes through register/general errors without poisoning either independent session', async () => {
        const a = await openDevice('a');
        const b = await openDevice('b');
        await helper.configure('a', { mode: 'register_error', flags: 4, delayMs: 5 });
        const registerFailure = rejection(a.client.getField('chargeCurrentLimit'), /flags 0x04.*parameterError/);
        await helper.configure('b', { mode: 'general_error' });
        const generalFailure = rejection(b.client.getField('deviceState'), /general error/);
        await Promise.all([registerFailure, generalFailure]);

        expect(a.com.isOpen()).to.equal(true);
        expect(b.com.isOpen()).to.equal(true);
        expect(await a.client.getField('chargeCurrentLimit')).to.equal(1.2);
        expect(await b.client.getField('deviceState')).to.equal(5);
        expect((await helper.state('a')).registers['2015']).to.equal('0c00');
    });

    it('reconnects the same communication and HEX client after its emulator PTY disappears', async () => {
        const a = await openDevice('a');
        expect(await a.client.getField('chargeCurrentLimit')).to.equal(1.2);
        const closed = deferred();
        const clientCloseHandler = a.com.onPortClosed;
        a.com.onPortClosed = error => {
            clientCloseHandler?.(error);
            closed.resolve(error);
        };

        await helper.call('disconnect', { device: 'a' });
        if (process.platform === 'darwin') {
            // macOS reports a closed PTY master as repeated zero-byte reads.
            // SerialPort 12's unixRead recursively retries that EOF forever and
            // emits no close, so recover the real Com explicitly before reopening.
            await bounded(a.com.close(), OPERATION_TIMEOUT_MS, 'macOS PTY EOF recovery');
        }
        await bounded(closed.promise, OPERATION_TIMEOUT_MS, 'native PTY hangup notification');
        expect(a.com.isOpen()).to.equal(false);
        await rejection(a.client.getField('chargeCurrentLimit'), /session is invalid/);

        const restarted = await helper.call('reconnect', { device: 'a' });
        helper.paths.a = restarted.path;
        await bounded(a.com.open(restarted.path), OPERATION_TIMEOUT_MS, 'reopen replacement PTY');
        expect(a.com.isOpen()).to.equal(true);
        expect(await a.client.getField('chargeCurrentLimit')).to.equal(1.2);
        expect(await a.client.setField('chargeCurrentLimit', 3.3)).to.equal(3.3);
        expect((await helper.state('a')).registers['2015']).to.equal('2100');
    });
});
