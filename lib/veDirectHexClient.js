'use strict';

const { encodeGet, encodeSet, decodeFrame } = require('./veDirect/hexProtocol');
const { HEX_FIELDS, REGISTER_IDS, encodeRaw, decodeRaw, isRegisterError } = require('./veDirect/hexFields');

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

/**
 * @typedef {number|boolean|string|null} HexValue
 */

/**
 * @typedef {object} HexCom
 * @property {number} sessionId Monotonically changing communication session ID.
 * @property {(buffer: Buffer) => Promise<void>|void} writeAndDrain Write and drain one complete frame.
 * @property {() => Promise<void>|void} close Invalidate the communication session.
 * @property {((message: Buffer) => void)|undefined} onHexMessage Complete HEX frame callback.
 * @property {((error: Error) => void)|undefined} onPortClosed Unexpected close callback.
 */

/**
 * @typedef {object} RegisterResponse
 * @property {Buffer} rawValue Uninterpreted register value bytes.
 * @property {number} flags Raw register flags byte.
 * @property {{unknownId: boolean, notSupported: boolean, parameterError: boolean}} errors Decoded error bits.
 * @property {number} unknownFlagBits Reserved/non-error flag bits.
 */

/**
 * @typedef {object} Deferred
 * @property {Promise<HexValue>} promise Public operation result.
 * @property {(value: HexValue) => void} resolve Resolve operation.
 * @property {(error?: unknown) => void} reject Reject operation.
 */

/**
 * @typedef {object} ActiveOperation
 * @property {'get'|'set'} kind Public operation kind.
 * @property {string} name Stable HEX field name.
 * @property {number} registerId Whitelisted register ID.
 * @property {Buffer} [setValue] Exact scalar value expected in a Set acknowledgement.
 * @property {Deferred} result Public deferred result.
 * @property {'get'|'set'} phase Current wire request phase.
 * @property {number} sessionId Session owning this operation.
 * @property {number} phaseId Per-instance phase generation.
 * @property {boolean} writeDone Whether writeAndDrain fulfilled.
 * @property {boolean} responseDone Whether one usable response arrived.
 * @property {RegisterResponse} [responseFrame] Decoded matching register response.
 * @property {Error} [responseError] General response error.
 * @property {ReturnType<typeof setTimeout>} [timer] Combined write/response deadline.
 */

/** @returns {Deferred} An externally settleable promise. */
function deferred() {
    /** @type {(value: HexValue) => void} */
    let resolve = () => undefined;
    /** @type {(error?: unknown) => void} */
    let reject = () => undefined;
    /** @type {Promise<HexValue>} */
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/**
 * @param {unknown} error Potential thrown value.
 * @param {string} [fallback] Message for an omitted error.
 * @returns {Error} A real Error instance.
 */
function asError(error, fallback = 'VE.Direct HEX operation failed') {
    if (error instanceof Error) {
        return error;
    }
    return new Error(error === undefined ? fallback : String(error));
}

/**
 * Serialize VE.Direct HEX register operations over one communication session.
 * Only the active operation writes to the port; all other calls wait in a
 * bounded per-instance queue. Set includes a mandatory Get readback phase.
 */
class VeDirectHexClient {
    /**
     * @param {HexCom} com VE.Direct communication owner.
     * @param {{responseTimeoutMs?: number, maxQueueSize?: number}} [options] Queue and deadline options.
     */
    constructor(com, { responseTimeoutMs = 1000, maxQueueSize = 16 } = {}) {
        if (typeof responseTimeoutMs !== 'number' || !Number.isFinite(responseTimeoutMs) || responseTimeoutMs < 0) {
            throw new RangeError('responseTimeoutMs must be a finite non-negative number');
        }
        if (!Number.isInteger(maxQueueSize) || maxQueueSize < 0) {
            throw new RangeError('maxQueueSize must be a non-negative integer');
        }

        this.com = com;
        this.responseTimeoutMs = responseTimeoutMs;
        this.maxQueueSize = maxQueueSize;
        /** @type {((error: Error) => void)|undefined} */
        this.onError = undefined;
        /** @type {ActiveOperation|undefined} */
        this.active = undefined;
        /** @type {ActiveOperation[]} */
        this.queue = [];
        /** @type {number|undefined} */
        this.invalidatedSessionId = undefined;
        /** @type {number|undefined} */
        this.closeRequestedSessionId = undefined;

        this.com.onHexMessage = message => this.handleHexMessage(message);
        this.com.onPortClosed = error => this.handlePortClosed(error);
    }

    /**
     * Read and decode one whitelisted register.
     *
     * @param {string} name Stable register name.
     * @returns {Promise<number|boolean|string|null>} Decoded engineering/enum value or unset sentinel.
     */
    async getField(name) {
        const field = this.field(name);
        if (!field.readable) {
            throw new RangeError(`${name} is not readable`);
        }
        return this.enqueue('get', name, REGISTER_IDS[name]);
    }

    /**
     * Write one whitelisted control, verify its exact acknowledgement, then
     * return a freshly decoded Get readback of the same register.
     *
     * @param {string} name Stable register name.
     * @param {unknown} value Logical control value accepted by encodeRaw().
     * @returns {Promise<number|boolean|string|null>} Decoded post-write readback or unset sentinel.
     */
    async setField(name, value) {
        const rawValue = encodeRaw(name, value);
        return this.enqueue('set', name, REGISTER_IDS[name], rawValue);
    }

    /**
     * Reject the active and every queued operation and clear their deadline.
     * Late write completions and frames are ignored by operation identity.
     *
     * @param {unknown} [error] Cancellation reason.
     */
    cancel(error) {
        this.invalidatedSessionId = this.com.sessionId;
        this.abortAll(asError(error, 'VE.Direct HEX client cancelled'));
        this.requestClose();
    }

    /**
     * @param {string} name Candidate stable field name.
     * @returns {Readonly<import('./veDirect/hexFields').HexField>} Field metadata.
     */
    field(name) {
        if (typeof name !== 'string' || !hasOwn(HEX_FIELDS, name)) {
            throw new RangeError(`Unknown VE.Direct HEX register: ${String(name)}`);
        }
        return HEX_FIELDS[name];
    }

    /**
     * @param {'get'|'set'} kind Operation kind.
     * @param {string} name Stable field name.
     * @param {number} registerId Whitelisted register ID.
     * @param {Buffer} [setValue] Exact Set payload.
     * @returns {Promise<HexValue>} Public result promise.
     */
    enqueue(kind, name, registerId, setValue) {
        this.detectSessionChange();
        if (this.invalidatedSessionId !== undefined) {
            if (this.invalidatedSessionId === this.com.sessionId) {
                throw new Error('VE.Direct HEX session is invalid; reconnect before issuing another request');
            }
            this.invalidatedSessionId = undefined;
        }
        if (this.active && this.queue.length >= this.maxQueueSize) {
            throw new RangeError(`VE.Direct HEX request queue is full (maximum ${this.maxQueueSize} waiting requests)`);
        }

        /** @type {ActiveOperation} */
        const operation = {
            kind,
            name,
            registerId,
            setValue,
            result: deferred(),
            phase: kind,
            sessionId: this.com.sessionId,
            phaseId: 0,
            writeDone: false,
            responseDone: false,
        };
        this.queue.push(operation);
        this.pump();
        return operation.result.promise;
    }

    /** Start the next queued operation, if no operation is active. */
    pump() {
        if (this.active) {
            return;
        }
        if (this.invalidatedSessionId !== undefined) {
            if (this.invalidatedSessionId === this.com.sessionId) {
                return;
            }
            this.invalidatedSessionId = undefined;
        }
        const operation = this.queue.shift();
        if (!operation) {
            return;
        }
        operation.sessionId = this.com.sessionId;
        this.active = operation;
        this.startPhase(operation, operation.kind);
    }

    /**
     * Start one Get or Set wire phase. The deadline starts before calling
     * writeAndDrain, so write, drain, and response all share one time budget.
     *
     * @param {ActiveOperation} operation Active public operation.
     * @param {'get'|'set'} phase Wire phase to start.
     */
    startPhase(operation, phase) {
        if (this.active !== operation) {
            return;
        }
        if (operation.sessionId !== this.com.sessionId) {
            this.abortSessionChange(operation);
            return;
        }

        let request;
        try {
            request =
                phase === 'get'
                    ? encodeGet(operation.registerId)
                    : encodeSet(operation.registerId, /** @type {Buffer} */ (operation.setValue));
        } catch (error) {
            this.settleActive(operation, asError(error));
            return;
        }

        operation.phase = phase;
        operation.phaseId++;
        operation.writeDone = false;
        operation.responseDone = false;
        operation.responseFrame = undefined;
        operation.responseError = undefined;
        const phaseId = operation.phaseId;
        operation.timer = setTimeout(() => {
            if (this.isCurrentPhase(operation, phaseId)) {
                this.invalidate(
                    operation,
                    new Error(`VE.Direct HEX ${phase} ${operation.name} timed out after ${this.responseTimeoutMs} ms`),
                );
            }
        }, this.responseTimeoutMs);

        let writeResult;
        try {
            writeResult = this.com.writeAndDrain(request);
        } catch (error) {
            if (this.isCurrentPhase(operation, phaseId)) {
                this.invalidate(operation, asError(error, 'VE.Direct HEX write failed'));
            }
            return;
        }
        Promise.resolve(writeResult).then(
            () => {
                if (!this.isCurrentPhase(operation, phaseId)) {
                    return;
                }
                operation.writeDone = true;
                this.maybeFinishPhase(operation, phaseId);
            },
            error => {
                if (this.isCurrentPhase(operation, phaseId)) {
                    // A rejected write/drain is ambiguous even if a response was
                    // already observed: invalidate rather than risking a retry or
                    // allowing its late bytes to acknowledge another operation.
                    this.invalidate(operation, asError(error, 'VE.Direct HEX write failed'));
                }
            },
        );
    }

    /**
     * @param {ActiveOperation} operation Operation to test.
     * @param {number} phaseId Expected phase generation.
     * @returns {boolean} Whether callbacks still belong to the active phase.
     */
    isCurrentPhase(operation, phaseId) {
        return this.active === operation && operation.phaseId === phaseId;
    }

    /**
     * @param {Buffer} message One complete frame supplied by VeDirectCom.
     */
    handleHexMessage(message) {
        const operation = this.active;
        if (!operation) {
            return;
        }
        if (operation.sessionId !== this.com.sessionId) {
            this.abortSessionChange(operation);
            return;
        }
        if (operation.responseDone) {
            return;
        }

        let frame;
        try {
            frame = decodeFrame(message);
        } catch {
            // Framing noise, garbage and bad checksums never complete a request.
            return;
        }

        if (frame.type === 'general') {
            if (frame.responseType === 'error' || frame.responseType === 'unknown') {
                const error = new Error(
                    `VE.Direct HEX general ${frame.responseType} response during ${operation.phase} ${operation.name}`,
                );
                error.name = 'VeDirectHexGeneralError';
                Object.assign(error, {
                    responseType: frame.responseType,
                    payload: Buffer.from(frame.payload),
                });
                operation.responseError = error;
                operation.responseDone = true;
                this.maybeFinishPhase(operation, operation.phaseId);
            }
            return;
        }

        if (frame.command !== (operation.phase === 'get' ? 0x7 : 0x8) || frame.registerId !== operation.registerId) {
            // Async notifications and responses for other commands/registers
            // are unrelated traffic, not a failure of the active operation.
            return;
        }
        operation.responseFrame = /** @type {RegisterResponse} */ (frame);
        operation.responseDone = true;
        this.maybeFinishPhase(operation, operation.phaseId);
    }

    /**
     * Complete a phase only after both writeAndDrain and the selected response
     * have settled. A response arriving before drain is therefore safe.
     *
     * @param {ActiveOperation} operation Active operation.
     * @param {number} phaseId Phase generation.
     */
    maybeFinishPhase(operation, phaseId) {
        if (!this.isCurrentPhase(operation, phaseId) || !operation.writeDone || !operation.responseDone) {
            return;
        }
        if (operation.sessionId !== this.com.sessionId) {
            this.abortSessionChange(operation);
            return;
        }
        if (operation.timer) {
            clearTimeout(operation.timer);
            operation.timer = undefined;
        }
        if (operation.responseError) {
            this.settleActive(operation, operation.responseError);
            return;
        }

        const completedPhase = operation.phase;
        let decoded;
        try {
            const frame = operation.responseFrame;
            if (!frame) {
                throw new Error('VE.Direct HEX response is missing');
            }
            if (isRegisterError(frame.flags)) {
                throw this.registerError(operation, frame);
            }
            // decodeRaw is the sole register-width and enum validator. No raw
            // payload is truncated or manually padded to the expected width.
            decoded = decodeRaw(operation.name, frame.rawValue);
            const expectedValue = /** @type {Buffer} */ (operation.setValue);
            if (completedPhase === 'set' && !frame.rawValue.equals(expectedValue)) {
                const error = new Error(`VE.Direct HEX Set echo mismatch for ${operation.name}`);
                error.name = 'VeDirectHexEchoError';
                Object.assign(error, {
                    field: operation.name,
                    registerId: operation.registerId,
                    expected: Buffer.from(expectedValue),
                    actual: Buffer.from(frame.rawValue),
                });
                throw error;
            }
        } catch (error) {
            this.settleActive(operation, asError(error));
            return;
        }

        if (completedPhase === 'set') {
            this.startPhase(operation, 'get');
            return;
        }
        this.settleActive(operation, undefined, decoded);
    }

    /**
     * @param {ActiveOperation} operation Failed operation.
     * @param {RegisterResponse} frame Decoded response with non-zero flags.
     * @returns {Error} Structured register error.
     */
    registerError(operation, frame) {
        const namedErrors = Object.entries(frame.errors)
            .filter(([, failed]) => failed)
            .map(([name]) => name);
        if (frame.unknownFlagBits) {
            namedErrors.push(`unknownFlagBits=0x${frame.unknownFlagBits.toString(16).padStart(2, '0')}`);
        }
        const error = new Error(
            `VE.Direct HEX register ${operation.name} returned flags 0x${frame.flags
                .toString(16)
                .padStart(2, '0')
                .toUpperCase()}${namedErrors.length ? ` (${namedErrors.join(', ')})` : ''}`,
        );
        error.name = 'VeDirectHexRegisterError';
        return Object.assign(error, {
            field: operation.name,
            registerId: operation.registerId,
            flags: frame.flags,
            errors: { ...frame.errors },
            unknownFlagBits: frame.unknownFlagBits,
            rawValue: Buffer.from(frame.rawValue),
        });
    }

    /**
     * @param {ActiveOperation} operation Operation to complete.
     * @param {Error} [error] Failure, or omitted for success.
     * @param {HexValue} [value] Successful decoded value.
     */
    settleActive(operation, error, value) {
        if (this.active !== operation) {
            return;
        }
        if (operation.timer) {
            clearTimeout(operation.timer);
            operation.timer = undefined;
        }
        this.active = undefined;
        if (error) {
            operation.result.reject(error);
        } else {
            operation.result.resolve(/** @type {HexValue} */ (value));
        }
        this.pump();
    }

    /**
     * A timeout or write/drain failure invalidates the whole session. There is
     * deliberately no retry and no later queued write on the old session.
     *
     * @param {ActiveOperation} operation Failed active operation.
     * @param {Error} error Fatal session error.
     */
    invalidate(operation, error) {
        if (this.active !== operation) {
            return;
        }
        if (operation.sessionId !== this.com.sessionId) {
            this.abortSessionChange(operation);
            return;
        }
        this.invalidatedSessionId = operation.sessionId;
        this.abortAll(error);
        this.requestClose();
    }

    /** Close the invalidated session once so no late response can acknowledge a new operation. */
    requestClose() {
        if (this.closeRequestedSessionId === this.com.sessionId) {
            return;
        }
        this.closeRequestedSessionId = this.com.sessionId;
        let closeResult;
        try {
            closeResult = this.com.close();
        } catch (closeError) {
            this.reportCloseError(closeError);
            return;
        }
        // Always observe close rejection: callers already received the fatal
        // operation error, while onError is the optional secondary diagnostic.
        Promise.resolve(closeResult).then(undefined, closeError => this.reportCloseError(closeError));
    }

    /**
     * @param {Error} error Port close reason supplied by VeDirectCom.
     */
    handlePortClosed(error) {
        // VeDirectCom increments sessionId before this callback. Require a
        // subsequent reconnect before permitting more writes.
        this.invalidatedSessionId = this.com.sessionId;
        this.abortAll(asError(error, 'VE.Direct serial port closed'));
    }

    /** Abort an old operation if the communication owner changed sessions. */
    detectSessionChange() {
        if (this.active && this.active.sessionId !== this.com.sessionId) {
            this.abortSessionChange(this.active);
        }
    }

    /**
     * @param {ActiveOperation} operation Old-session operation.
     */
    abortSessionChange(operation) {
        if (this.active !== operation) {
            return;
        }
        // The new session belongs to the communication owner and must not be
        // closed merely because an old write or response completed late.
        this.invalidatedSessionId = undefined;
        this.abortAll(new Error(`VE.Direct HEX session changed during ${operation.phase} ${operation.name}`));
    }

    /**
     * @param {Error} error Rejection reason shared by all outstanding callers.
     */
    abortAll(error) {
        const active = this.active;
        this.active = undefined;
        if (active) {
            if (active.timer) {
                clearTimeout(active.timer);
                active.timer = undefined;
            }
            active.result.reject(error);
        }
        const queued = this.queue.splice(0);
        for (const operation of queued) {
            operation.result.reject(error);
        }
    }

    /**
     * @param {unknown} error Secondary close failure.
     */
    reportCloseError(error) {
        if (!this.onError) {
            return;
        }
        try {
            this.onError(asError(error, 'VE.Direct HEX close failed'));
        } catch {
            // An optional diagnostic callback must not create an unhandled
            // rejection in the already-settled invalidation path.
        }
    }
}

module.exports = { VeDirectHexClient };
