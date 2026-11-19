'use strict';

const { VeDirectParser } = require('./veDirect/veDirectParser');

const SERIAL_OPEN_TIMEOUT_MS = 10000;
const SERIAL_CLOSE_TIMEOUT_MS = 5000;
const SERIAL_WRITE_TIMEOUT_MS = 5000;
const SERIAL_DRAIN_TIMEOUT_MS = 5000;

class SerialOperationTimeoutError extends Error {
    constructor(operation, timeoutMs) {
        super(`Serial ${operation} timed out after ${timeoutMs} ms`);
        this.name = 'SerialOperationTimeoutError';
    }
}

const defaultPortFactory = (path, options, callback) => {
    if (typeof path === 'object' && path !== null) {
        // Keep raw TCP independent from the native serialport bindings.
        const { VeDirectTcpPort } = require('./veDirectTcpPort');
        return new VeDirectTcpPort(path, callback, { openTimeoutMs: options.openTimeoutMs });
    }
    // Load native bindings only for a real open, not for parser/unit tests.
    const { SerialPort } = require('serialport');
    return new SerialPort({ path, baudRate: options.baudRate, lock: true }, callback);
};

/**
 * Create an externally settleable promise.
 *
 * @returns {{promise: Promise<any>, resolve: (value?: any) => void, reject: (error?: any) => void}}
 */
function deferred() {
    /** @type {(value?: any) => void} */
    let resolve = () => undefined;
    /** @type {(error?: any) => void} */
    let reject = () => undefined;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

class VeDirectCom {
    /**
     * @param {Function} [portFactory] Serial port factory for production or tests.
     * @param {{openTimeoutMs?: number, closeTimeoutMs?: number, writeTimeoutMs?: number, drainTimeoutMs?: number, lateCloseRetryMs?: number}} [options] Operation timeouts.
     */
    constructor(portFactory = defaultPortFactory, options = {}) {
        /** @type {((frame: Record<string, any>) => void)|undefined} */
        this.onFrame = undefined;
        /** @type {(() => void)|undefined} */
        this.onValidFrame = undefined;
        /** @type {((error: Error) => void)|undefined} */
        this.onError = undefined;
        /** @type {((message: Buffer) => void)|undefined} */
        this.onHexMessage = undefined;
        /** @type {((error: Error) => void)|undefined} */
        this.onPortClosed = undefined;
        /** @type {any} */
        this.port = undefined;
        /** @type {Promise<void>|undefined} */
        this.openPromise = undefined;
        /** @type {Promise<void>|undefined} */
        this.closePromise = undefined;
        this.portFactory = portFactory;
        this.parser = new VeDirectParser();
        this.closeRequestId = 0;
        this.openCloseRequestId = 0;
        this.portStates = new WeakMap();
        this.closeWaiters = new WeakMap();
        this.reportedOpenErrors = new WeakSet();
        this.errorListener = error => {
            const normalized = this.asError(error);
            const state = this.port && this.portStates.get(this.port);
            if (state && !state.ready && !state.closed) {
                this.reportedOpenErrors.add(normalized);
            }
            this.reportError(normalized);
        };
        this.openTimeoutMs = options.openTimeoutMs ?? SERIAL_OPEN_TIMEOUT_MS;
        this.closeTimeoutMs = options.closeTimeoutMs ?? SERIAL_CLOSE_TIMEOUT_MS;
        this.writeTimeoutMs = options.writeTimeoutMs ?? SERIAL_WRITE_TIMEOUT_MS;
        this.drainTimeoutMs = options.drainTimeoutMs ?? SERIAL_DRAIN_TIMEOUT_MS;
        this.lateCloseRetryMs = options.lateCloseRetryMs ?? 1000;
        this.sessionId = 0;
        this.parser.onFrame = frame => {
            if (this.onFrame) {
                this.onFrame({ ...frame });
            }
        };
        this.parser.onValidFrame = () => {
            if (this.onValidFrame) {
                this.onValidFrame();
            }
        };
        this.parser.onHexMessage = message => {
            if (this.onHexMessage) {
                this.onHexMessage(Buffer.from(message));
            }
        };
    }

    isOpen() {
        return this.port?.isOpen === true;
    }

    async writeAndDrain(data) {
        const port = this.port;
        const state = port && this.portStates.get(port);
        const sessionId = this.sessionId;
        if (!port || !state) {
            throw new Error('Serial port is not ready for writing');
        }
        this.assertPortWritable(port, state, sessionId);
        const bytes = Buffer.from(data);

        const writeResult = deferred();
        try {
            port.write(bytes, error => {
                if (error) {
                    writeResult.reject(error);
                } else {
                    writeResult.resolve();
                }
            });
        } catch (error) {
            writeResult.reject(error);
        }
        await this.withTimeout(writeResult.promise, this.writeTimeoutMs, 'write');
        this.assertPortWritable(port, state, sessionId);

        const drainResult = deferred();
        try {
            port.drain(error => {
                if (error) {
                    drainResult.reject(error);
                } else {
                    drainResult.resolve();
                }
            });
        } catch (error) {
            drainResult.reject(error);
        }
        await this.withTimeout(drainResult.promise, this.drainTimeoutMs, 'drain');
        this.assertPortWritable(port, state, sessionId);
    }

    assertPortWritable(port, state, sessionId) {
        if (
            this.port !== port ||
            this.sessionId !== sessionId ||
            !state.ready ||
            state.closed ||
            state.closePending ||
            !port.isOpen
        ) {
            throw new Error('Serial port session changed or closed while writing');
        }
    }

    open(serialportPath) {
        const closeRequest = this.closeRequestId;
        if (this.openPromise && this.openCloseRequestId === closeRequest) {
            return this.openPromise;
        }
        const operation = this.performOpen(serialportPath, closeRequest);
        this.openCloseRequestId = closeRequest;
        this.openPromise = operation;
        const clear = () => {
            if (this.openPromise === operation) {
                this.openPromise = undefined;
            }
        };
        void operation.then(clear, clear);
        return operation;
    }

    async performOpen(serialportPath, closeRequest) {
        if (this.closePromise) {
            await this.closePromise.catch(() => undefined);
        }
        this.assertNotCloseRequested(closeRequest);

        const existing = this.port;
        if (existing) {
            const state = this.portStates.get(existing);
            if (existing.isOpen && state?.ready && !state.closed) {
                return;
            }
            if (existing.isOpen || state?.closePending) {
                await this.closePort(existing);
            } else if (state?.failed && !state.closed) {
                // Keep its late-open callback/listeners alive, but do not let it
                // become the current session after a replacement opens.
                this.port = undefined;
            } else {
                this.cleanupPort(existing);
            }
        }
        this.assertNotCloseRequested(closeRequest);
        this.parser.reset();

        const openResult = deferred();
        /** @type {any} */
        let port;
        /** @type {any} */
        const state = {
            closed: false,
            ready: false,
            failed: false,
            openPending: true,
            closePending: false,
            rejectPending: openResult.reject,
            closeListener: () => undefined,
            dataListener: () => undefined,
        };
        const openCallback = error => {
            state.openPending = false;
            // A factory may legally call back synchronously. Deferring guarantees
            // that the returned port and all listeners have been installed first.
            queueMicrotask(() => {
                if (state.failed) {
                    if (error || !port?.isOpen) {
                        state.closed = true;
                        this.cleanupPort(port);
                    } else {
                        void this.closeLatePort(port);
                    }
                    return;
                }
                if (error) {
                    openResult.reject(error);
                } else {
                    openResult.resolve();
                }
            });
        };

        try {
            port = this.portFactory(
                serialportPath,
                { baudRate: 19200, openTimeoutMs: this.openTimeoutMs },
                openCallback,
            );
            state.closeListener = () => this.handlePortClosed(port);
            state.dataListener = data => {
                if (this.port !== port || !state.ready || state.closed) {
                    return;
                }
                try {
                    this.parser.receive(Buffer.from(data));
                } catch (error) {
                    this.reportError(error);
                }
            };
            this.portStates.set(port, state);
            this.port = port;
            this.sessionId++;
            port.on('error', this.errorListener);
            port.on('close', state.closeListener);

            await this.withTimeout(openResult.promise, this.openTimeoutMs, 'open');
            state.rejectPending = undefined;
            this.assertPortUsable(port, state);
            this.assertNotCloseRequested(closeRequest);

            const setResult = deferred();
            state.rejectPending = setResult.reject;
            port.set({ dtr: false, rts: false, cts: false, brk: false }, error => {
                if (error && !this.isModemControlUnsupportedError(error)) {
                    setResult.reject(error);
                } else {
                    // POSIX PTYs and some virtual serial endpoints do not expose
                    // modem-control ioctls. The byte stream remains fully usable.
                    setResult.resolve();
                }
            });
            await this.withTimeout(setResult.promise, this.openTimeoutMs, 'set');
            state.rejectPending = undefined;
            this.assertPortUsable(port, state);
            this.assertNotCloseRequested(closeRequest);

            port.on('data', state.dataListener);
            state.ready = true;
        } catch (error) {
            const normalized = this.asError(error);
            state.failed = true;
            state.ready = false;
            state.rejectPending = undefined;
            if (port) {
                await this.handleOpenFailure(port, normalized);
            }
            throw normalized;
        }
    }

    close() {
        this.closeRequestId++;
        if (this.closePromise) {
            return this.closePromise;
        }
        const operation = this.performClose();
        this.closePromise = operation;
        const clear = () => {
            if (this.closePromise === operation) {
                this.closePromise = undefined;
            }
        };
        void operation.then(clear, clear);
        return operation;
    }

    async performClose() {
        const pendingOpen = this.openPromise;
        const observedOpen = pendingOpen?.catch(() => undefined);
        let port = this.port;
        const state = port && this.portStates.get(port);
        const cancelPendingOpen = Boolean(
            pendingOpen && state?.openPending && this.port === port && port?.supportsOpenCancellation === true,
        );
        if (pendingOpen && !cancelPendingOpen) {
            // SerialPort 12 rejects close() while its native open is pending.
            // Preserve its established late-open cleanup instead of emitting
            // a false "Port is not open" error. Raw TCP explicitly supports
            // immediate DNS/connect cancellation and takes the other branch.
            await observedOpen;
            port = this.port;
        }
        if (port) {
            await this.closePort(port);
        }
        if (cancelPendingOpen) {
            await observedOpen;
        }
        if (!port) {
            this.parser.reset();
        }
    }

    async closePort(port) {
        const state = this.portStates.get(port);
        if (!state || state.closed) {
            this.cleanupPort(port);
            return;
        }
        const openPending =
            state.openPending && this.openPromise && this.port === port && port.supportsOpenCancellation === true;
        if (!port.isOpen && !state.closePending && !openPending) {
            this.cleanupPort(port);
            return;
        }
        state.ready = false;
        port.removeListener('data', state.dataListener);
        if (this.port === port) {
            this.parser.reset();
        }

        const closeEvent = deferred();
        const waiter = () => closeEvent.resolve();
        let waiters = this.closeWaiters.get(port);
        if (!waiters) {
            waiters = new Set();
            this.closeWaiters.set(port, waiters);
        }
        waiters.add(waiter);
        try {
            if (state.closePending) {
                await this.withTimeout(closeEvent.promise, this.closeTimeoutMs, 'close');
            } else {
                const callbackResult = deferred();
                state.closePending = true;
                port.close(error => {
                    if (error) {
                        state.closePending = false;
                        callbackResult.reject(error);
                        return;
                    }
                    this.handlePortClosed(port);
                    callbackResult.resolve();
                });
                await this.withTimeout(
                    Promise.race([callbackResult.promise, closeEvent.promise]),
                    this.closeTimeoutMs,
                    'close',
                );
            }
        } catch (error) {
            // An outstanding close stays pending while the port reports itself
            // closed, so a later attempt waits for it instead of replacing it.
            state.ready = false;
            if (port.isOpen) {
                state.closePending = false;
            }
            throw error;
        } finally {
            const registered = this.closeWaiters.get(port);
            registered?.delete(waiter);
            if (registered?.size === 0) {
                this.closeWaiters.delete(port);
            }
        }
    }

    async handleOpenFailure(port, error) {
        const state = this.portStates.get(port);
        this.parser.reset();
        if (state) {
            port.removeListener('data', state.dataListener);
        }
        try {
            if ((port.isOpen || state?.closePending) && !state?.closed) {
                await this.closePort(port);
            } else if (!(error instanceof SerialOperationTimeoutError && state?.failed)) {
                this.cleanupPort(port);
            }
        } catch (closeError) {
            this.reportError(closeError);
        }
        if (!this.reportedOpenErrors.delete(error)) {
            this.reportError(error);
        }
    }

    async closeLatePort(port) {
        const state = this.portStates.get(port);
        if (state && !state.closed) {
            // An explicit close while native open was pending may already have
            // cleaned listeners. Late cleanup must never emit an orphan error.
            port.removeListener('error', this.errorListener);
            port.on('error', this.errorListener);
            port.removeListener('close', state.closeListener);
            port.on('close', state.closeListener);
        }
        while (state && !state.closed) {
            try {
                await this.closePort(port);
                return;
            } catch (error) {
                this.reportError(error);
                await this.delay(this.lateCloseRetryMs);
            }
        }
        this.cleanupPort(port);
    }

    delay(milliseconds) {
        return new Promise(resolve => {
            const timer = setTimeout(resolve, milliseconds);
            if (typeof timer.unref === 'function') {
                timer.unref();
            }
        });
    }

    handlePortClosed(port) {
        const state = this.portStates.get(port);
        if (!state || state.closed) {
            return;
        }
        state.closed = true;
        state.ready = false;
        state.closePending = false;
        state.rejectPending?.(new Error('Serial port closed while opening'));
        state.rejectPending = undefined;
        const waiters = this.closeWaiters.get(port);
        if (waiters) {
            for (const waiter of [...waiters]) {
                waiter();
            }
        }
        const wasCurrent = this.port === port;
        if (wasCurrent) {
            this.sessionId++;
            this.port = undefined;
            this.parser.reset();
        }
        this.cleanupPort(port);
        if (wasCurrent && this.onPortClosed) {
            try {
                this.onPortClosed(new Error('Serial port closed during HEX communication'));
            } catch (error) {
                this.reportError(error);
            }
        }
    }

    assertPortUsable(port, state) {
        if (state.closed || !port.isOpen) {
            throw new Error('Serial port closed while opening');
        }
    }

    assertNotCloseRequested(closeRequest) {
        if (closeRequest !== this.closeRequestId) {
            throw new Error('Serial open cancelled by close request');
        }
    }

    cleanupPort(port) {
        const state = this.portStates.get(port);
        if (this.port === port) {
            this.port = undefined;
        }
        if (state) {
            port.removeListener('data', state.dataListener);
            port.removeListener('close', state.closeListener);
            state.ready = false;
        }
        port.removeListener('error', this.errorListener);
    }

    withTimeout(promise, timeoutMs, operation) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new SerialOperationTimeoutError(operation, timeoutMs)), timeoutMs);
            if (typeof timer.unref === 'function') {
                timer.unref();
            }
            promise.then(
                value => {
                    clearTimeout(timer);
                    resolve(value);
                },
                error => {
                    clearTimeout(timer);
                    reject(error);
                },
            );
        });
    }

    asError(error) {
        return error instanceof Error ? error : new Error(String(error));
    }

    isModemControlUnsupportedError(error) {
        if (!error) {
            return false;
        }
        if (error.code !== undefined || error.errno !== undefined) {
            return error.code === 'ENOTTY' || error.errno === -25;
        }
        return (
            error.message === 'Error: Inappropriate ioctl for device, cannot set' ||
            error.message === 'Inappropriate ioctl for device, cannot set'
        );
    }

    reportError(error) {
        const normalized = this.asError(error);
        if (this.onError) {
            this.onError(normalized);
        }
    }
}

module.exports = { VeDirectCom, SERIAL_OPEN_TIMEOUT_MS, SERIAL_CLOSE_TIMEOUT_MS };
