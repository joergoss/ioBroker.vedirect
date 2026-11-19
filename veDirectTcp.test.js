'use strict';

const net = require('node:net');
const dns = require('node:dns');
const { expect } = require('chai');
const { VeDirectCom } = require('./lib/veDirectCom');
const { VeDirectHexClient } = require('./lib/veDirectHexClient');
const { VeDirectTcpPort, normalizeTcpTarget } = require('./lib/veDirectTcpPort');
const { encodeRequest, encodeGet, encodeSet, decodeFrame } = require('./lib/veDirect/hexProtocol');
const { REGISTER_IDS, encodeRaw } = require('./lib/veDirect/hexFields');

const TEST_TIMEOUT_MS = 2000;

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

async function bounded(promise, label, milliseconds = TEST_TIMEOUT_MS) {
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

function immediate() {
    return new Promise(resolve => setImmediate(resolve));
}

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function makeFrame(fields) {
    const body = Buffer.from(`\r\n${fields.map(([label, value]) => `${label}\t${value}\r\n`).join('')}Checksum\t`);
    let sum = 0;
    for (const byte of body) {
        sum = (sum + byte) & 0xff;
    }
    return Buffer.concat([body, Buffer.from([(256 - sum) & 0xff])]);
}

function registerFrame(command, registerId, rawValue) {
    const payload = Buffer.concat([Buffer.from([registerId & 0xff, registerId >>> 8, 0]), Buffer.from(rawValue)]);
    return encodeRequest(command, payload);
}

function writeSocket(socket, data) {
    return bounded(
        new Promise((resolve, reject) => {
            socket.write(data, error => (error ? reject(error) : resolve()));
        }),
        'server socket write',
    );
}

async function writeChunks(socket, frame) {
    const sizes = [1, 2, 5, 1, 7, 3, 11, 2, 13];
    let offset = 0;
    let index = 0;
    // Keep the checksum byte as its own final write. This also exercises a
    // checksum outside ASCII without converting any part of the frame to text.
    while (offset < frame.length - 1) {
        const size = sizes[index++ % sizes.length];
        const end = Math.min(offset + size, frame.length - 1);
        await writeSocket(socket, frame.subarray(offset, end));
        offset = end;
    }
    await writeSocket(socket, frame.subarray(frame.length - 1));
}

function closeRawPort(port) {
    return new Promise((resolve, reject) => {
        port.close(error => (error ? reject(error) : resolve()));
    });
}

function closeServer(server) {
    if (!server.listening) {
        return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
    });
}

async function rejection(promise, pattern) {
    try {
        await bounded(promise, 'expected rejection');
    } catch (error) {
        expect(error).to.be.instanceOf(Error);
        if (pattern) {
            expect(error.message).to.match(pattern);
        }
        return error;
    }
    throw new Error('Expected promise to reject');
}

describe('VE.Direct raw TCP transport', function () {
    this.timeout(5000);

    const coms = new Set();
    const clients = new Set();
    const directPorts = new Set();
    const servers = new Set();
    const serverSockets = new Set();
    const dnsRestores = [];

    function holdDnsLookup(hostname) {
        const originalLookup = dns.lookup;
        const pending = [];
        const called = deferred();
        const release = () => {
            for (const { options, callback } of pending.splice(0)) {
                if (options.all) {
                    callback(null, [{ address: '127.0.0.1', family: 4 }]);
                } else {
                    callback(null, '127.0.0.1', 4);
                }
            }
        };
        dns.lookup = (candidate, options, callback) => {
            if (candidate !== hostname) {
                return originalLookup.call(dns, candidate, options, callback);
            }
            pending.push({
                options: typeof options === 'function' ? {} : options,
                callback: typeof options === 'function' ? options : callback,
            });
            called.resolve();
        };
        dnsRestores.push(() => {
            dns.lookup = originalLookup;
            release();
        });
        return { called, release };
    }

    function createCom(options = {}) {
        const com = new VeDirectCom(undefined, {
            openTimeoutMs: 1000,
            closeTimeoutMs: 500,
            writeTimeoutMs: 500,
            drainTimeoutMs: 500,
            ...options,
        });
        coms.add(com);
        return com;
    }

    function createClient(com) {
        const client = new VeDirectHexClient(com, { responseTimeoutMs: 1000 });
        clients.add(client);
        return client;
    }

    async function startServer(onConnection) {
        const server = net.createServer(socket => {
            serverSockets.add(socket);
            // A test may deliberately reset a peer. Keep such server-side errors
            // away from EventEmitter's process-level unhandled-error behavior.
            socket.on('error', () => undefined);
            onConnection?.(socket);
        });
        servers.add(server);
        await bounded(
            new Promise((resolve, reject) => {
                const onError = error => reject(error);
                server.once('error', onError);
                server.listen(0, '127.0.0.1', () => {
                    server.removeListener('error', onError);
                    resolve();
                });
            }),
            'loopback listen',
        );
        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('Loopback server did not expose an ephemeral TCP port');
        }
        return { server, target: { host: '127.0.0.1', port: address.port } };
    }

    afterEach(async () => {
        let cleanupError;
        for (const restore of dnsRestores.splice(0).reverse()) {
            restore();
        }
        for (const client of clients) {
            client.cancel(new Error('TCP test cleanup'));
        }
        clients.clear();

        for (const com of coms) {
            try {
                await bounded(com.close(), 'Com cleanup', 1000);
            } catch (error) {
                cleanupError ||= error;
            }
        }
        coms.clear();

        for (const port of directPorts) {
            try {
                await bounded(closeRawPort(port), 'TCP port cleanup', 1000);
            } catch (error) {
                cleanupError ||= error;
            }
        }
        directPorts.clear();

        for (const socket of serverSockets) {
            socket.destroy();
        }
        for (const server of servers) {
            try {
                await bounded(closeServer(server), 'TCP server cleanup', 1000);
            } catch (error) {
                cleanupError ||= error;
            }
        }
        servers.clear();

        for (const socket of serverSockets) {
            expect(socket.destroyed, 'accepted TCP socket destroyed').to.equal(true);
        }
        serverSockets.clear();
        if (cleanupError) {
            throw cleanupError;
        }
    });

    it('normalizes fresh frozen targets and rejects the invalid target matrix', () => {
        const input = { host: '  127.0.0.1  ', port: '00080' };
        const normalized = normalizeTcpTarget(input);
        expect(normalized).to.deep.equal({ host: '127.0.0.1', port: 80 });
        expect(normalized).not.to.equal(input);
        expect(Object.isFrozen(normalized)).to.equal(true);
        expect(input).to.deep.equal({ host: '  127.0.0.1  ', port: '00080' });

        expect(normalizeTcpTarget({ host: 'localhost', port: 1 })).to.deep.equal({
            host: 'localhost',
            port: 1,
        });
        expect(normalizeTcpTarget({ host: 've-direct.local', port: '65535' })).to.deep.equal({
            host: 've-direct.local',
            port: 65535,
        });
        expect(normalizeTcpTarget({ host: '::1', port: 502 })).to.deep.equal({ host: '::1', port: 502 });

        const invalidTargets = [undefined, null, [], '127.0.0.1', {}, { host: 127, port: 1 }];
        for (const host of ['', '   ', 'host name', 'host\tname', 'http://host', 'tcp:host', 'host/path', 'host?x=1']) {
            invalidTargets.push({ host, port: 1 });
        }
        for (const port of [
            undefined,
            null,
            '',
            ' ',
            '0',
            0,
            '000',
            -1,
            65536,
            1.5,
            '1.5',
            '1e3',
            '0x50',
            '+80',
            ' 80',
            '80 ',
            Infinity,
            -Infinity,
            NaN,
            true,
            {},
            [],
            1n,
        ]) {
            invalidTargets.push({ host: 'localhost', port });
        }
        for (const target of invalidTargets) {
            expect(() => normalizeTcpTarget(target)).to.throw();
        }
    });

    it('parses a checksum-valid TEXT frame and its binary checksum over arbitrary TCP chunks', async () => {
        const connected = deferred();
        const { target } = await startServer(socket => connected.resolve(socket));
        const com = createCom();
        const frames = [];
        const frameReceived = deferred();
        const errors = [];
        com.onError = error => errors.push(error);
        com.onFrame = frame => {
            frames.push(frame);
            frameReceived.resolve();
        };

        await bounded(com.open(target), 'TCP open');
        const socket = await bounded(connected.promise, 'accepted connection');
        const frame = makeFrame([
            ['V', '13118'],
            ['I', '-1000'],
        ]);
        expect(frame[frame.length - 1]).to.equal(0xe2);
        await writeChunks(socket, frame);
        await bounded(frameReceived.promise, 'TEXT frame');

        expect(frames).to.deep.equal([{ V: 13.118, I: -1 }]);
        expect(errors).to.deep.equal([]);
        expect(com.port.socket.timeout).to.equal(0);
    });

    it('cancels a pending DNS connect on close and never connects after the close completes', async () => {
        let connectionCount = 0;
        const { target } = await startServer(() => connectionCount++);
        const heldDns = holdDnsLookup('cancel-pending.test');
        const com = createCom({ openTimeoutMs: 1500, closeTimeoutMs: 200 });
        const opening = com.open({ host: 'cancel-pending.test', port: target.port });
        await bounded(heldDns.called.promise, 'controlled DNS lookup');
        const port = com.port;
        expect(port.isOpen).to.equal(false);
        expect(port.socket.destroyed).to.equal(false);
        const observedOpen = rejection(opening);

        await bounded(com.close(), 'close during pending DNS', 500);
        await observedOpen;

        expect(port.socket.destroyed).to.equal(true);
        expect(com.port).to.equal(undefined);
        heldDns.release();
        await delay(50);
        expect(connectionCount).to.equal(0);
    });

    it('reports remote close and reconnects through the real default factory without old parser state', async () => {
        const connections = [deferred(), deferred()];
        let connectionCount = 0;
        const { target } = await startServer(socket => {
            const index = connectionCount++;
            if (index < connections.length) {
                connections[index].resolve(socket);
            }
        });
        const com = createCom();
        const frames = [];
        const closeErrors = [];
        const remotelyClosed = deferred();
        const secondFrame = deferred();
        com.onFrame = frame => {
            frames.push(frame);
            if (frames.length === 2) {
                secondFrame.resolve();
            }
        };
        com.onPortClosed = error => {
            closeErrors.push(error);
            remotelyClosed.resolve();
        };

        await bounded(com.open(target), 'first TCP open');
        // Leave an incomplete block on the first session. Reconnect must reset it.
        const firstSocket = await bounded(connections[0].promise, 'first accepted connection');
        await writeSocket(firstSocket, makeFrame([['V', '99999']]).subarray(0, 9));
        firstSocket.end();
        await bounded(remotelyClosed.promise, 'remote close notification');

        expect(com.isOpen()).to.equal(false);
        expect(closeErrors).to.have.lengthOf(1);
        await rejection(com.writeAndDrain(Buffer.from(':A\n')), /not ready/);

        await bounded(com.open(target), 'second TCP open');
        const secondSocket = await bounded(connections[1].promise, 'second accepted connection');
        await writeChunks(secondSocket, makeFrame([['V', '13118']]));
        // This frame contains only current, proving the old partial voltage block
        // cannot leak into the new connection.
        await writeChunks(secondSocket, makeFrame([['I', '-1000']]));
        await bounded(secondFrame.promise, 'frames after reconnect');

        expect(connectionCount).to.equal(2);
        expect(frames).to.deep.equal([{ V: 13.118 }, { I: -1 }]);
        expect(closeErrors).to.have.lengthOf(1);
    });

    it('runs HEX Get and Set with exact codec bytes, Set acknowledgement, and real Get readback', async () => {
        const connected = deferred();
        const requests = [];
        const responses = [];
        let wireError;
        let getCount = 0;
        const { target } = await startServer(socket => {
            connected.resolve(socket);
            let pending = Buffer.alloc(0);
            socket.on('data', data => {
                pending = Buffer.concat([pending, data]);
                let lf;
                while ((lf = pending.indexOf(0x0a)) !== -1) {
                    const request = Buffer.from(pending.subarray(0, lf + 1));
                    pending = pending.subarray(lf + 1);
                    requests.push(request);
                    try {
                        const decoded = decodeFrame(request);
                        let response;
                        if (decoded.command === 0x8) {
                            // A Set acknowledgement has the exact command, register,
                            // flags and raw value layout of the accepted request.
                            response = encodeRequest(0x8, decoded.payload);
                        } else if (decoded.command === 0x7) {
                            getCount++;
                            const raw = getCount === 1 ? Buffer.from([123, 0]) : Buffer.from([11, 0]);
                            response = registerFrame(0x7, decoded.registerId, raw);
                        } else {
                            throw new Error(`Unexpected HEX command ${decoded.command}`);
                        }
                        responses.push(response);
                        socket.write(response);
                    } catch (error) {
                        wireError = error;
                        socket.destroy();
                        return;
                    }
                }
            });
        });
        const com = createCom();
        const client = createClient(com);
        await bounded(com.open(target), 'HEX TCP open');
        await bounded(connected.promise, 'HEX accepted connection');

        expect(await bounded(client.getField('chargeCurrentLimit'), 'HEX Get')).to.equal(12.3);
        expect(await bounded(client.setField('chargeCurrentLimit', 1.2), 'HEX Set plus readback')).to.equal(1.1);

        const id = REGISTER_IDS.chargeCurrentLimit;
        const raw = encodeRaw('chargeCurrentLimit', 1.2);
        const get = encodeGet(id);
        const set = encodeSet(id, raw);
        expect(wireError).to.equal(undefined);
        expect(requests).to.deep.equal([get, set, get]);
        expect(responses).to.deep.equal([
            registerFrame(0x7, id, Buffer.from([123, 0])),
            registerFrame(0x8, id, raw),
            registerFrame(0x7, id, Buffer.from([11, 0])),
        ]);
        expect(decodeFrame(requests[1]).rawValue).to.deep.equal(raw);
        expect(decodeFrame(responses[1]).rawValue).to.deep.equal(raw);
        expect(com.isOpen()).to.equal(true);
    });

    it('rejects an ECONNREFUSED open without retrying or leaving a current port', async () => {
        const { server, target } = await startServer();
        await bounded(closeServer(server), 'release ephemeral port');
        const com = createCom({ openTimeoutMs: 500 });
        const reported = [];
        com.onError = error => reported.push(error);

        const error = await rejection(com.open(target), /ECONNREFUSED|connect/);

        expect(error.code).to.equal('ECONNREFUSED');
        expect(com.isOpen()).to.equal(false);
        expect(com.port).to.equal(undefined);
        expect(reported).to.have.lengthOf(1);
        expect(reported[0]).to.equal(error);
    });

    it('reports a controlled connect timeout exactly once and never connects after timeout cleanup', async () => {
        let connectionCount = 0;
        const { target } = await startServer(() => connectionCount++);
        const heldDns = holdDnsLookup('timeout-pending.test');
        const com = createCom({ openTimeoutMs: 40, closeTimeoutMs: 100 });
        const reported = [];
        com.onError = error => reported.push(error);
        const opening = com.open({ host: 'timeout-pending.test', port: target.port });
        await bounded(heldDns.called.promise, 'timeout DNS lookup');
        const port = com.port;

        const error = await rejection(opening, /timed out/);
        await immediate();

        expect(error.code).to.equal('ETIMEDOUT');
        expect(reported).to.have.lengthOf(1);
        expect(reported[0]).to.equal(error);
        expect(port.socket.destroyed).to.equal(true);
        expect(com.port).to.equal(undefined);
        heldDns.release();
        await delay(50);
        expect(connectionCount).to.equal(0);
    });

    it('sends no Telnet negotiation and performs exactly one write followed by an asynchronous drain', async () => {
        const connected = deferred();
        const enoughBytes = deferred();
        const received = [];
        const payload = Buffer.from(':7014000052\n', 'ascii');
        const { target } = await startServer(socket => {
            connected.resolve(socket);
            socket.on('data', data => {
                received.push(Buffer.from(data));
                if (Buffer.concat(received).length >= payload.length) {
                    enoughBytes.resolve();
                }
            });
        });
        const com = createCom();
        await bounded(com.open(target), 'raw-byte TCP open');
        await bounded(connected.promise, 'raw-byte accepted connection');
        await immediate();
        expect(Buffer.concat(received)).to.have.lengthOf(0, 'no connection negotiation bytes');

        const port = com.port;
        expect(port).to.be.instanceOf(VeDirectTcpPort);
        const events = [];
        const originalWrite = port.write.bind(port);
        const originalDrain = port.drain.bind(port);
        port.write = (data, callback) => {
            events.push('write');
            originalWrite(data, error => {
                events.push('write-callback');
                callback(error);
            });
        };
        port.drain = callback => {
            events.push('drain');
            let synchronous = true;
            originalDrain(error => {
                events.push(synchronous ? 'drain-callback-sync' : 'drain-callback-async');
                callback(error);
            });
            synchronous = false;
        };

        await bounded(com.writeAndDrain(payload), 'raw write and drain');
        await bounded(enoughBytes.promise, 'raw bytes on server');
        await immediate();

        expect(events).to.deep.equal(['write', 'write-callback', 'drain', 'drain-callback-async']);
        expect(Buffer.concat(received)).to.deep.equal(payload);
        expect(Buffer.concat(received).includes(0xff)).to.equal(false);
    });

    it('makes set asynchronous and rejects writes before open and after one idempotent close', async () => {
        const connected = deferred();
        const { target } = await startServer(socket => connected.resolve(socket));
        let openCallbacks = 0;
        let port;
        const opened = new Promise((resolve, reject) => {
            port = new VeDirectTcpPort(
                target,
                error => {
                    openCallbacks++;
                    if (error) {
                        reject(error);
                    } else {
                        resolve();
                    }
                },
                { openTimeoutMs: 1000 },
            );
        });
        directPorts.add(port);
        const errors = [];
        port.on('error', error => errors.push(error));

        const earlyWrite = new Promise(resolve => {
            port.write(Buffer.from([0x01]), error => resolve(error));
        });
        expect(await bounded(earlyWrite, 'early write callback')).to.be.instanceOf(Error);
        await bounded(opened, 'direct TCP open');
        await bounded(connected.promise, 'direct accepted connection');

        let setSynchronous = true;
        await new Promise((resolve, reject) => {
            port.set({ dtr: false }, error => {
                expect(setSynchronous).to.equal(false);
                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            });
            setSynchronous = false;
        });

        let closeEvents = 0;
        const closeCallbacks = [0, 0];
        port.on('close', () => closeEvents++);
        const closes = closeCallbacks.map(
            (count, index) =>
                new Promise((resolve, reject) => {
                    port.close(error => {
                        closeCallbacks[index] = count + 1;
                        if (error) {
                            reject(error);
                        } else {
                            resolve();
                        }
                    });
                }),
        );
        await Promise.all(closes);
        await bounded(closeRawPort(port), 'already closed callback');

        expect(openCallbacks).to.equal(1);
        expect(closeCallbacks).to.deep.equal([1, 1]);
        expect(closeEvents).to.equal(1);
        expect(port.isOpen).to.equal(false);
        expect(errors).to.deep.equal([]);
        const lateWrite = new Promise(resolve => {
            port.write(Buffer.from([0x02]), error => resolve(error));
        });
        expect(await bounded(lateWrite, 'late write callback')).to.be.instanceOf(Error);
    });

    it('keeps two real TCP Com instances and their parser streams independent', async () => {
        const connectedA = deferred();
        const connectedB = deferred();
        const { target: targetA } = await startServer(socket => connectedA.resolve(socket));
        const { target: targetB } = await startServer(socket => connectedB.resolve(socket));
        const comA = createCom();
        const comB = createCom();
        const framesA = [];
        const framesB = [];
        const firstA = deferred();
        const firstB = deferred();
        const secondB = deferred();
        comA.onFrame = frame => {
            framesA.push(frame);
            firstA.resolve();
        };
        comB.onFrame = frame => {
            framesB.push(frame);
            if (framesB.length === 1) {
                firstB.resolve();
            } else if (framesB.length === 2) {
                secondB.resolve();
            }
        };

        await Promise.all([bounded(comA.open(targetA), 'open TCP A'), bounded(comB.open(targetB), 'open TCP B')]);
        const [socketA, socketB] = await Promise.all([
            bounded(connectedA.promise, 'accepted A'),
            bounded(connectedB.promise, 'accepted B'),
        ]);
        await Promise.all([
            writeChunks(socketA, makeFrame([['V', '13118']])),
            writeChunks(socketB, makeFrame([['I', '-1000']])),
        ]);
        await Promise.all([bounded(firstA.promise, 'frame A'), bounded(firstB.promise, 'first frame B')]);

        await bounded(comA.close(), 'close only A');
        await writeChunks(socketB, makeFrame([['I', '2000']]));
        await bounded(secondB.promise, 'second frame B');

        expect(framesA).to.deep.equal([{ V: 13.118 }]);
        expect(framesB).to.deep.equal([{ I: -1 }, { I: 2 }]);
        expect(comA.isOpen()).to.equal(false);
        expect(comB.isOpen()).to.equal(true);
    });
});
