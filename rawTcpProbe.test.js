'use strict';

const net = require('node:net');
const { spawn } = require('node:child_process');
const { expect } = require('chai');
const { VeDirectCom } = require('./lib/veDirectCom');
const { parseProbeArgs, runRawTcpProbe } = require('./tools/raw-tcp-probe');

const TEST_TIMEOUT_MS = 3000;

function bounded(promise, label, milliseconds = TEST_TIMEOUT_MS) {
    let timer;
    const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds} ms`)), milliseconds);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function makeFrame(fields) {
    const body = Buffer.from(`\r\n${fields.map(([label, value]) => `${label}\t${value}\r\n`).join('')}Checksum\t`);
    let sum = 0;
    for (const byte of body) {
        sum = (sum + byte) & 0xff;
    }
    return Buffer.concat([body, Buffer.from([(256 - sum) & 0xff])]);
}

function socketWrite(socket, data) {
    return new Promise((resolve, reject) => {
        socket.write(data, error => (error ? reject(error) : resolve()));
    });
}

async function writeChunks(socket, frame) {
    const sizes = [1, 2, 5, 3, 1, 7, 2];
    let offset = 0;
    for (let index = 0; offset < frame.length; index++) {
        const end = Math.min(offset + sizes[index % sizes.length], frame.length);
        await socketWrite(socket, frame.subarray(offset, end));
        offset = end;
    }
}

function closeServer(server) {
    if (!server.listening) {
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
}

describe('Read-only raw TCP diagnostic probe', function () {
    this.timeout(5000);
    const servers = new Set();
    const sockets = new Set();
    const children = new Set();

    async function startServer(onConnection) {
        const server = net.createServer(socket => {
            sockets.add(socket);
            socket.on('error', () => undefined);
            onConnection(socket);
        });
        servers.add(server);
        await bounded(
            new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(0, '127.0.0.1', resolve);
            }),
            'loopback listen',
        );
        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('No ephemeral TCP address');
        }
        return { server, target: { host: '127.0.0.1', port: address.port } };
    }

    afterEach(async () => {
        for (const child of children) {
            if (child.exitCode === null && child.signalCode === null) {
                child.kill('SIGKILL');
            }
        }
        children.clear();
        for (const socket of sockets) {
            socket.destroy();
        }
        sockets.clear();
        for (const server of servers) {
            await bounded(closeServer(server), 'server cleanup', 1000);
        }
        servers.clear();
    });

    it('parses valid CLI targets and rejects invalid arguments and durations', async () => {
        expect(parseProbeArgs(['127.0.0.1', '1234'])).to.include({ durationMs: 12000, help: false });
        expect(parseProbeArgs(['localhost', '00080', '2'])).to.deep.include({
            durationMs: 2000,
            help: false,
        });
        expect(parseProbeArgs(['--help'])).to.deep.equal({ help: true });
        for (const args of [
            [],
            ['localhost'],
            ['--unknown'],
            ['localhost', '1234', '1', 'extra'],
            ['localhost', '0'],
            ['http://localhost', '1234'],
            ['localhost', '1234', '0'],
            ['localhost', '1234', '121'],
            ['localhost', '1234', '1.5'],
            ['localhost', '1234', '1e2'],
            ['localhost', '1234', ' 2'],
        ]) {
            expect(() => parseProbeArgs(args), JSON.stringify(args)).to.throw();
        }
        for (const durationMs of [0, -1, 1.5, 120001, Infinity, NaN]) {
            await expect(runRawTcpProbe({ target: { host: 'localhost', port: 1 }, durationMs })).to.be.rejected;
        }
    });

    it('parses real fragmented frames and verifies zero bytes written by the probe', async () => {
        const received = [];
        const { target } = await startServer(socket => {
            socket.on('data', data => received.push(Buffer.from(data)));
            void (async () => {
                await writeChunks(
                    socket,
                    makeFrame([
                        ['V', '13118'],
                        ['I', '-1000'],
                    ]),
                );
                await writeChunks(
                    socket,
                    makeFrame([
                        ['V', '13200'],
                        ['I', '2000'],
                    ]),
                );
            })();
        });
        const result = await runRawTcpProbe({ target, durationMs: 30, openTimeoutMs: 500, closeTimeoutMs: 200 });
        expect(result.ok).to.equal(true);
        expect(result.access).to.equal('TCP_READ_ONLY');
        expect(result.validFrameCount).to.equal(2);
        expect(result.lastFrame).to.deep.equal({ V: 13.2, I: 2 });
        expect(result.lastFrameAt).to.be.a('string');
        expect(result.bytesWritten).to.equal(0);
        expect(result.readOnlyVerified).to.equal(true);
        expect(result.reasons).to.deep.equal([]);
        expect(received).to.deep.equal([]);
    });

    it('keeps valid-block and decoded-frame timestamps distinct across unknown-only blocks', async () => {
        const { target } = await startServer(socket => {
            void (async () => {
                await writeChunks(socket, makeFrame([['V', '13118']]));
                await new Promise(resolve => setTimeout(resolve, 10));
                await writeChunks(socket, makeFrame([['X_NEW', '123']]));
            })();
        });
        const result = await runRawTcpProbe({ target, durationMs: 30, openTimeoutMs: 500, closeTimeoutMs: 200 });
        expect(result.ok).to.equal(true);
        expect(result.validFrameCount).to.equal(2);
        expect(result.lastFrame).to.deep.equal({ V: 13.118 });
        expect(Date.parse(result.lastValidFrameAt)).to.be.greaterThan(Date.parse(result.lastFrameAt));
        expect(result.bytesWritten).to.equal(0);
    });

    it('reports unknown-only valid liveness without inventing a decoded frame timestamp', async () => {
        const { target } = await startServer(socket => {
            void writeChunks(socket, makeFrame([['X_NEW', '123']]));
        });
        const result = await runRawTcpProbe({ target, durationMs: 20, openTimeoutMs: 500, closeTimeoutMs: 200 });
        expect(result.ok).to.equal(true);
        expect(result.validFrameCount).to.equal(1);
        expect(result.lastValidFrameAt).to.be.a('string');
        expect(result.lastFrame).to.equal(null);
        expect(result.lastFrameAt).to.equal(null);
        expect(result.bytesWritten).to.equal(0);
    });

    it('reports garbage and missing valid frames without inventing values', async () => {
        const { target } = await startServer(socket => {
            socket.on('data', () => undefined);
            void socketWrite(socket, Buffer.from('not a VE.Direct block\r\n'));
        });
        const result = await runRawTcpProbe({ target, durationMs: 20, openTimeoutMs: 500, closeTimeoutMs: 200 });
        expect(result.ok).to.equal(false);
        expect(result.validFrameCount).to.equal(0);
        expect(result.lastFrame).to.equal(null);
        expect(result.reasons).to.include('NO_VALID_FRAME');
        expect(result.bytesWritten).to.equal(0);
    });

    it('surfaces a corrupted checksum instead of accepting a partial frame', async () => {
        const { target } = await startServer(socket => {
            const frame = makeFrame([['V', '13118']]);
            frame[5] ^= 1;
            void writeChunks(socket, frame);
        });
        const result = await runRawTcpProbe({ target, durationMs: 20, openTimeoutMs: 500, closeTimeoutMs: 200 });
        expect(result.ok).to.equal(false);
        expect(result.parser.checksumErrors).to.be.greaterThan(0);
        expect(result.reasons).to.include('CHECKSUM_ERRORS');
        expect(result.lastFrame).to.equal(null);
        expect(result.bytesWritten).to.equal(0);
    });

    it('reports an early remote close even after a valid frame', async () => {
        const { target } = await startServer(socket => {
            void writeChunks(socket, makeFrame([['V', '13118']])).then(() => socket.end());
        });
        const result = await runRawTcpProbe({ target, durationMs: 50, openTimeoutMs: 500, closeTimeoutMs: 200 });
        expect(result.validFrameCount).to.equal(1);
        expect(result.ok).to.equal(false);
        expect(result.connectionClosedEarly).to.equal(true);
        expect(result.closeReason).to.equal('TCP connection closed unexpectedly');
        expect(result.reasons).to.include('CONNECTION_CLOSED_EARLY');
        expect(result.bytesWritten).to.equal(0);
    });

    it('returns a structured ECONNREFUSED result without retrying', async () => {
        const { server, target } = await startServer(() => undefined);
        await closeServer(server);
        const result = await runRawTcpProbe({ target, durationMs: 20, openTimeoutMs: 500, closeTimeoutMs: 200 });
        expect(result.ok).to.equal(false);
        expect(result.openedAt).to.equal(null);
        expect(result.reasons).to.include('OPEN_FAILED');
        expect(result.errors.map(error => error.code)).to.include('ECONNREFUSED');
        expect(result.bytesWritten).to.equal(0);
    });

    it('does not claim a write proof when open fails before a socket exists', async () => {
        const originalOpen = VeDirectCom.prototype.open;
        VeDirectCom.prototype.open = function () {
            return Promise.reject(new Error('injected pre-port open failure'));
        };
        let result;
        try {
            result = await runRawTcpProbe({ target: { host: 'localhost', port: 1 }, durationMs: 20 });
        } finally {
            VeDirectCom.prototype.open = originalOpen;
        }
        expect(result.ok).to.equal(false);
        expect(result.openedAt).to.equal(null);
        expect(result.bytesWritten).to.equal(null);
        expect(result.readOnlyVerified).to.equal(false);
        expect(result.reasons).to.include('OPEN_FAILED');
        expect(result.reasons).to.include('WRITE_PROOF_UNAVAILABLE');
    });

    it('emits machine-readable JSON from the real CLI and still writes no bytes', async () => {
        const received = [];
        const { target } = await startServer(socket => {
            socket.on('data', data => received.push(Buffer.from(data)));
            void writeChunks(socket, makeFrame([['V', '13118']]));
        });
        const child = spawn(process.execPath, ['tools/raw-tcp-probe.js', target.host, String(target.port), '1'], {
            cwd: process.cwd(),
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        children.add(child);
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', data => (stdout += data));
        child.stderr.on('data', data => (stderr += data));
        const [code, signal] = await bounded(
            new Promise(resolve => child.once('close', (exitCode, exitSignal) => resolve([exitCode, exitSignal]))),
            'raw TCP CLI',
        );
        expect(signal).to.equal(null);
        expect(code, stderr).to.equal(0);
        const result = JSON.parse(stdout);
        expect(result.ok).to.equal(true);
        expect(result.validFrameCount).to.equal(1);
        expect(result.bytesWritten).to.equal(0);
        expect(result.readOnlyVerified).to.equal(true);
        expect(received).to.deep.equal([]);
    });
});
