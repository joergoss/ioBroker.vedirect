'use strict';

const net = require('node:net');
const { EventEmitter } = require('node:events');

const DEFAULT_OPEN_TIMEOUT_MS = 10000;

/**
 * Validate and normalize an administrative TCP target without mutating it.
 *
 * @param {unknown} target Candidate host/port object.
 * @returns {Readonly<{host: string, port: number}>} A fresh immutable target.
 */
function normalizeTcpTarget(target) {
    if (typeof target !== 'object' || target === null || Array.isArray(target)) {
        throw new TypeError('TCP target must be an object with host and port');
    }
    const candidate = /** @type {{host?: unknown, port?: unknown}} */ (target);
    if (typeof candidate.host !== 'string') {
        throw new TypeError('TCP host must be a string');
    }
    const host = candidate.host.trim();
    if (!host || /\s/.test(host) || /[/\\?#@]/.test(host)) {
        throw new TypeError('TCP host must be a hostname or IP address without whitespace, URL parts, or a path');
    }

    if (net.isIP(host) === 0) {
        // A colon in a non-IPv6 value is a URL scheme or a host:port pair, not a
        // hostname. Validate labels rather than letting DNS interpret URL syntax.
        const hostname = host.endsWith('.') ? host.slice(0, -1) : host;
        if (
            !hostname ||
            hostname.length > 253 ||
            hostname.includes(':') ||
            hostname.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))
        ) {
            throw new TypeError('TCP host must be a valid hostname or IP address without a URL scheme or port');
        }
    }

    let port;
    if (typeof candidate.port === 'string') {
        if (!/^[0-9]+$/.test(candidate.port)) {
            throw new RangeError('TCP port string must contain digits only');
        }
        port = Number(candidate.port);
    } else if (typeof candidate.port === 'number') {
        port = candidate.port;
    } else {
        throw new TypeError('TCP port must be an integer or an administrative digits-only string');
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new RangeError('TCP port must be an integer in the range 1..65535');
    }

    return Object.freeze({ host, port });
}

/**
 * SerialPort-shaped raw TCP transport. There is deliberately no Telnet or
 * RFC2217 negotiation: socket bytes are forwarded unchanged in both directions.
 */
class VeDirectTcpPort extends EventEmitter {
    /**
     * @param {unknown} target TCP host/port object.
     * @param {(error?: Error) => void} openCallback Completion callback for the single connect attempt.
     * @param {{openTimeoutMs?: number}} [options] Connect timeout options.
     */
    constructor(target, openCallback, options = {}) {
        super();
        if (typeof openCallback !== 'function') {
            throw new TypeError('TCP openCallback must be a function');
        }
        this.target = normalizeTcpTarget(target);
        this.openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
        if (typeof this.openTimeoutMs !== 'number' || !Number.isFinite(this.openTimeoutMs) || this.openTimeoutMs < 0) {
            throw new RangeError('TCP openTimeoutMs must be a finite non-negative number');
        }

        this.isOpen = false;
        // VeDirectCom may cancel DNS/connect immediately only for transports
        // which explicitly support close while native open is still pending.
        this.supportsOpenCancellation = true;
        this.openSettled = false;
        this.closeEmitted = false;
        this.closeRequested = false;
        /** @type {((error?: Error) => void)|undefined} */
        this.openCallback = openCallback;
        /** @type {Array<(error?: Error) => void>} */
        this.closeCallbacks = [];
        /** @type {NodeJS.Timeout|undefined} */
        this.connectTimer = undefined;
        /** @type {Error|undefined} */
        this.closeError = undefined;

        this.socket = new net.Socket();
        this.socket.on('data', data => this.emit('data', data));
        this.socket.on('error', error => this.handleSocketError(error));
        this.socket.on('timeout', () => this.handleConnectTimeout());
        this.socket.on('end', () => {
            this.isOpen = false;
        });
        this.socket.on('close', () => this.handleSocketClose());

        // Use both the socket timeout and an explicit deadline: the latter also
        // covers a DNS lookup which has not produced a connected socket yet.
        this.socket.setTimeout(this.openTimeoutMs);
        this.connectTimer = setTimeout(() => this.handleConnectTimeout(), this.openTimeoutMs);
        try {
            this.socket.connect({ host: this.target.host, port: this.target.port });
            this.socket.once('connect', () => this.handleConnect());
        } catch (error) {
            const normalized = error instanceof Error ? error : new Error(String(error));
            queueMicrotask(() => {
                try {
                    this.handleSocketError(normalized);
                } finally {
                    this.socket.destroy();
                }
            });
        }
    }

    /** Cancel the explicit DNS/connect deadline without touching socket activity. */
    clearConnectTimeout() {
        if (this.connectTimer) {
            clearTimeout(this.connectTimer);
            this.connectTimer = undefined;
        }
    }

    /** Complete the only connect attempt and disable further socket inactivity timeouts. */
    handleConnect() {
        if (this.closeRequested || this.socket.destroyed) {
            this.socket.destroy();
            return;
        }
        this.isOpen = true;
        this.clearConnectTimeout();
        // The connection deadline is not a read deadline. Once connected, the
        // VeDirectCom watchdog owns detection of a device which stops sending.
        this.socket.setTimeout(0);
        this.settleOpen();
    }

    /** Reject and destroy a connection which exceeds its bounded open deadline. */
    handleConnectTimeout() {
        if (this.openSettled || this.closeRequested) {
            return;
        }
        const error = Object.assign(
            new Error(
                `TCP connect to ${this.target.host}:${this.target.port} timed out after ${this.openTimeoutMs} ms`,
            ),
            { code: 'ETIMEDOUT' },
        );
        this.settleOpen(error);
        try {
            this.emit('error', error);
        } finally {
            this.socket.destroy();
        }
    }

    /** @param {Error} error Socket error forwarded to the communication owner. */
    handleSocketError(error) {
        if (!this.openSettled) {
            this.settleOpen(error);
        }
        this.emit('error', error);
    }

    /** Publish one terminal close and settle every waiter on that same event. */
    handleSocketClose() {
        if (this.closeEmitted) {
            return;
        }
        this.isOpen = false;
        this.closeEmitted = true;
        this.clearConnectTimeout();
        this.socket.setTimeout(0);
        if (!this.openSettled) {
            this.settleOpen(new Error('TCP socket closed before the connection opened'));
        }

        // The native close event is the sole source of the public close event.
        // Repeated close() calls only share this completion; they never re-emit.
        this.emit('close');
        const callbacks = this.closeCallbacks.splice(0);
        for (const callback of callbacks) {
            callback(this.closeError);
        }
    }

    /** @param {Error} [error] Open failure, or no argument on success. */
    settleOpen(error) {
        if (this.openSettled) {
            return;
        }
        this.openSettled = true;
        this.clearConnectTimeout();
        if (error) {
            this.socket.setTimeout(0);
        }
        const callback = this.openCallback;
        this.openCallback = undefined;
        callback?.(error);
    }

    /**
     * TCP has no serial modem-control lines. Keep the SerialPort API as an
     * asynchronous successful no-op.
     *
     * @param {unknown} _options Ignored modem-control options.
     * @param {(error?: Error) => void} [callback] Completion callback.
     */
    set(_options, callback = () => undefined) {
        queueMicrotask(() => callback());
    }

    /**
     * Write one unchanged byte buffer. The socket callback means this write has
     * been flushed from Node's queue, so the subsequent SerialPort-style drain
     * can complete asynchronously without issuing another write.
     *
     * @param {Buffer} data Exact bytes to send.
     * @param {(error?: Error) => void} [callback] Completion callback.
     */
    write(data, callback = () => undefined) {
        if (!this.isOpen || this.closeRequested || this.socket.destroyed) {
            queueMicrotask(() => callback(new Error('TCP port is not open for writing')));
            return;
        }
        if (!Buffer.isBuffer(data)) {
            queueMicrotask(() => callback(new TypeError('TCP write data must be a Buffer')));
            return;
        }
        try {
            this.socket.write(data, error => callback(error || undefined));
        } catch (error) {
            const normalized = error instanceof Error ? error : new Error(String(error));
            queueMicrotask(() => callback(normalized));
        }
    }

    /**
     * Complete after a successful socket write callback; no extra bytes or
     * modem-specific drain operation are needed for TCP.
     *
     * @param {(error?: Error) => void} [callback] Completion callback.
     */
    drain(callback = () => undefined) {
        if (!this.isOpen || this.closeRequested || this.socket.destroyed) {
            queueMicrotask(() => callback(new Error('TCP port is not open for draining')));
            return;
        }
        queueMicrotask(() => callback());
    }

    /**
     * Destroy this single socket, including while connect is still pending.
     * Concurrent callers share the one native close event and each callback is
     * invoked once. Closing an already closed port is an asynchronous no-op.
     *
     * @param {(error?: Error) => void} [callback] Completion callback.
     */
    close(callback = () => undefined) {
        if (this.closeEmitted) {
            queueMicrotask(() => callback(this.closeError));
            return;
        }

        this.closeCallbacks.push(callback);
        this.closeRequested = true;
        this.isOpen = false;
        if (!this.openSettled) {
            this.settleOpen(new Error('TCP connection closed before the connection opened'));
        }
        this.clearConnectTimeout();
        this.socket.setTimeout(0);
        try {
            this.socket.destroy();
        } catch (error) {
            this.closeError = error instanceof Error ? error : new Error(String(error));
            this.handleSocketClose();
        }
    }
}

module.exports = { VeDirectTcpPort, normalizeTcpTarget };
