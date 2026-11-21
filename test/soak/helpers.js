'use strict';

const SCENARIOS = new Set(['short', 'cycle', 'fin', 'rst', 'dns', 'stop', 'independent']);
const DEFAULT_RESOURCE_LIMITS = Object.freeze({
    heapUsedGrowthMb: 16,
    rssGrowthMb: 32,
    tcpSocketGrowth: 0,
    tcpServerGrowth: 0,
    timeoutGrowth: 2,
    immediateGrowth: 4,
});

function parsePositiveInteger(value, name, minimum, maximum) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < minimum || number > maximum) {
        throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
    }
    return number;
}

function parseArgs(argv) {
    const options = { scenario: 'short', durationSeconds: 3600, sampleSeconds: 10, output: undefined };
    for (let index = 0; index < argv.length; index++) {
        const argument = argv[index];
        const [name, inlineValue] = argument.split('=', 2);
        const value = inlineValue === undefined ? argv[++index] : inlineValue;
        if (name === '--scenario') {
            if (!SCENARIOS.has(value)) {
                throw new RangeError(`Unknown soak scenario: ${value}`);
            }
            options.scenario = value;
        } else if (name === '--duration') {
            options.durationSeconds = parsePositiveInteger(value, 'duration', 30, 86400);
        } else if (name === '--sample') {
            options.sampleSeconds = parsePositiveInteger(value, 'sample', 1, 300);
        } else if (name === '--output') {
            if (!value) {
                throw new RangeError('output path must not be empty');
            }
            options.output = value;
        } else {
            throw new RangeError(`Unknown soak argument: ${argument}`);
        }
    }
    return Object.freeze(options);
}

function resourceSnapshot() {
    const memory = process.memoryUsage();
    const resources = {};
    for (const resource of process.getActiveResourcesInfo()) {
        resources[resource] = (resources[resource] || 0) + 1;
    }
    return {
        heapUsedMb: Number((memory.heapUsed / 1024 / 1024).toFixed(3)),
        heapTotalMb: Number((memory.heapTotal / 1024 / 1024).toFixed(3)),
        rssMb: Number((memory.rss / 1024 / 1024).toFixed(3)),
        resources,
    };
}

function resourceGrowthErrors(baseline, final, limits = DEFAULT_RESOURCE_LIMITS) {
    const errors = [];
    const heapGrowth = final.heapUsedMb - baseline.heapUsedMb;
    const rssGrowth = final.rssMb - baseline.rssMb;
    if (heapGrowth > limits.heapUsedGrowthMb) {
        errors.push(`heapUsed grew by ${heapGrowth.toFixed(3)} MiB (limit ${limits.heapUsedGrowthMb})`);
    }
    if (rssGrowth > limits.rssGrowthMb) {
        errors.push(`RSS grew by ${rssGrowth.toFixed(3)} MiB (limit ${limits.rssGrowthMb})`);
    }
    for (const [resource, limit] of /** @type {Array<[string, number]>} */ ([
        ['TCPSocket', limits.tcpSocketGrowth],
        ['TCPSocketWrap', limits.tcpSocketGrowth],
        ['TCPServer', limits.tcpServerGrowth],
        ['TCPServerWrap', limits.tcpServerGrowth],
        ['Timeout', limits.timeoutGrowth],
        ['Immediate', limits.immediateGrowth],
    ])) {
        const growth = (final.resources[resource] || 0) - (baseline.resources[resource] || 0);
        if (growth > limit) {
            errors.push(`${resource} count grew by ${growth} (limit ${limit})`);
        }
    }
    return errors;
}

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
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

module.exports = { DEFAULT_RESOURCE_LIMITS, parseArgs, resourceSnapshot, resourceGrowthErrors, delay, deferred };
