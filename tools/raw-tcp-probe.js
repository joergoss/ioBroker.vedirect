'use strict';

const { VeDirectCom } = require('../lib/veDirectCom');
const { normalizeTcpTarget } = require('../lib/veDirectTcpPort');

const DEFAULT_DURATION_SECONDS = 12;
const MAX_DURATION_SECONDS = 120;
const DEFAULT_OPEN_TIMEOUT_MS = 10000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5000;
const USAGE = `Usage: node tools/raw-tcp-probe.js <hostname-or-IP> <port> [seconds=${DEFAULT_DURATION_SECONDS}]

Read-only VE.Direct TCP diagnosis. Duration must be an integer from 1 to ${MAX_DURATION_SECONDS} seconds.
The probe sends no data, HEX commands, or Telnet negotiation bytes.`;

function durationSeconds(value) {
    const text = String(value);
    if (!/^[0-9]+$/.test(text)) {
        throw new RangeError('Duration must contain digits only');
    }
    const seconds = Number(text);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_DURATION_SECONDS) {
        throw new RangeError(`Duration must be an integer in the range 1..${MAX_DURATION_SECONDS} seconds`);
    }
    return seconds;
}

/**
 * Parse positional probe arguments without opening a connection.
 *
 * @param {string[]} argv Host, port, optional duration, or --help.
 * @returns {{help: boolean, target?: Readonly<{host: string, port: number}>, durationMs?: number, openTimeoutMs?: number, closeTimeoutMs?: number}} Parsed CLI options.
 */
function parseProbeArgs(argv) {
    if (argv.length === 1 && ['-h', '--help'].includes(argv[0])) {
        return { help: true };
    }
    if (argv.length < 2 || argv.length > 3 || argv.some(value => String(value).startsWith('--'))) {
        throw new Error('Expected a host, a TCP port, and optionally a duration in seconds');
    }
    const target = normalizeTcpTarget({ host: argv[0], port: argv[1] });
    const seconds = argv.length === 3 ? durationSeconds(argv[2]) : DEFAULT_DURATION_SECONDS;
    return {
        help: false,
        target,
        durationMs: seconds * 1000,
        openTimeoutMs: DEFAULT_OPEN_TIMEOUT_MS,
        closeTimeoutMs: DEFAULT_CLOSE_TIMEOUT_MS,
    };
}

function milliseconds(value, name, maximum) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > maximum) {
        throw new RangeError(`${name} must be an integer in the range 1..${maximum} ms`);
    }
    return value;
}

function delay(millisecondsToWait) {
    return new Promise(resolve => setTimeout(resolve, millisecondsToWait));
}

/**
 * Listen to one raw TCP VE.Direct endpoint without writing a single byte.
 *
 * @param {{target: {host: string, port: number}, durationMs?: number, openTimeoutMs?: number, closeTimeoutMs?: number}} options Probe options.
 * @returns {Promise<Record<string, unknown>>} Structured connection and parser evidence.
 */
async function runRawTcpProbe(options) {
    if (typeof options !== 'object' || options === null) {
        throw new TypeError('Probe options are required');
    }
    const target = normalizeTcpTarget(options.target);
    const durationMs = milliseconds(options.durationMs ?? DEFAULT_DURATION_SECONDS * 1000, 'durationMs', 120000);
    const openTimeoutMs = milliseconds(options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS, 'openTimeoutMs', 60000);
    const closeTimeoutMs = milliseconds(options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS, 'closeTimeoutMs', 60000);
    const com = new VeDirectCom(undefined, { openTimeoutMs, closeTimeoutMs });
    const ports = new Set();
    const errors = [];
    const seenErrors = new WeakSet();
    const startedAt = Date.now();
    let stage = 'open';
    let openedAt;
    let validFrameCount = 0;
    let lastFrame = null;
    let lastFrameAt;
    let lastValidFrameAt;
    let connectionClosedEarly = false;
    let closeReason;

    const recordError = error => {
        const normalized = /** @type {Error & {code?: string|number}} */ (
            error instanceof Error ? error : new Error(String(error))
        );
        if (seenErrors.has(normalized)) {
            return;
        }
        seenErrors.add(normalized);
        /** @type {{stage: string, message: string, code?: string|number}} */
        const details = { stage, message: normalized.message };
        if (normalized.code !== undefined) {
            details.code = normalized.code;
        }
        errors.push(details);
    };

    com.onError = recordError;
    com.onValidFrame = () => {
        validFrameCount++;
        lastValidFrameAt = Date.now();
    };
    com.onFrame = frame => {
        if (Object.keys(frame).length > 0) {
            lastFrame = { ...frame };
            lastFrameAt = Date.now();
        }
    };
    com.onPortClosed = () => {
        if (stage === 'listen') {
            connectionClosedEarly = true;
            closeReason = 'TCP connection closed unexpectedly';
        }
    };

    try {
        const opening = com.open(target);
        if (com.port) {
            ports.add(com.port);
        }
        await opening;
        openedAt = Date.now();
        stage = 'listen';
        await delay(durationMs);
    } catch (error) {
        recordError(error);
    } finally {
        stage = 'close';
        try {
            await com.close();
        } catch (error) {
            recordError(error);
        }
    }

    const parser = {
        checksumErrors: com.parser.checksumErrors,
        invalidFrames: com.parser.invalidFrames,
        invalidHexMessages: com.parser.invalidHexMessages,
        hexMessages: com.parser.hexMessages,
    };
    const bytes = [...ports].map(port => port?.socket?.bytesWritten);
    const bytesProofAvailable =
        ports.size > 0 && bytes.every(value => typeof value === 'number' && Number.isFinite(value));
    const bytesWritten = bytesProofAvailable ? bytes.reduce((sum, value) => sum + value, 0) : null;
    const reasons = [];
    if (!openedAt) {
        reasons.push('OPEN_FAILED');
    }
    if (validFrameCount === 0) {
        reasons.push('NO_VALID_FRAME');
    }
    if (connectionClosedEarly) {
        reasons.push('CONNECTION_CLOSED_EARLY');
    }
    if (parser.checksumErrors > 0) {
        reasons.push('CHECKSUM_ERRORS');
    }
    if (parser.invalidFrames > 0) {
        reasons.push('INVALID_FRAMES');
    }
    if (parser.invalidHexMessages > 0) {
        reasons.push('INVALID_HEX_MESSAGES');
    }
    if (errors.length > 0) {
        reasons.push('TRANSPORT_ERRORS');
    }
    if (!bytesProofAvailable) {
        reasons.push('WRITE_PROOF_UNAVAILABLE');
    } else if (bytesWritten !== 0) {
        reasons.push('BYTES_WRITTEN');
    }

    return {
        ok: reasons.length === 0,
        access: 'TCP_READ_ONLY',
        target,
        node: process.version,
        startedAt: new Date(startedAt).toISOString(),
        openedAt: openedAt ? new Date(openedAt).toISOString() : null,
        closedAt: new Date().toISOString(),
        durationMs,
        validFrameCount,
        lastValidFrameAt: lastValidFrameAt ? new Date(lastValidFrameAt).toISOString() : null,
        lastFrameAt: lastFrameAt ? new Date(lastFrameAt).toISOString() : null,
        lastFrame,
        connectionClosedEarly,
        closeReason: closeReason || null,
        parser,
        errors,
        bytesWritten,
        readOnlyVerified: bytesProofAvailable && bytesWritten === 0,
        reasons,
    };
}

/**
 * Run the command-line probe and print either usage help or one JSON result.
 *
 * @param {string[]} [argv] Positional CLI arguments.
 */
async function main(argv = process.argv.slice(2)) {
    let options;
    try {
        options = parseProbeArgs(argv);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        console.error(USAGE);
        process.exitCode = 2;
        return;
    }
    if (!options.target) {
        console.log(USAGE);
        return;
    }
    try {
        const result = await runRawTcpProbe({
            target: options.target,
            durationMs: options.durationMs,
            openTimeoutMs: options.openTimeoutMs,
            closeTimeoutMs: options.closeTimeoutMs,
        });
        console.log(JSON.stringify(result, null, 2));
        if (!result.ok) {
            process.exitCode = 1;
        }
    } catch (error) {
        console.error(error instanceof Error ? error.stack : String(error));
        process.exitCode = 1;
    }
}

if (require.main === module) {
    void main();
}

module.exports = { DEFAULT_DURATION_SECONDS, MAX_DURATION_SECONDS, USAGE, parseProbeArgs, runRawTcpProbe, main };
