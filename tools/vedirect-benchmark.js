'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

function writeCommand(command) {
    return ['set', 'setex', 'psetex', 'mset', 'msetnx'].includes(String(command).toLowerCase());
}

function parseProcStat(content) {
    const closing = content.lastIndexOf(') ');
    if (closing < 0) {
        throw new Error('Invalid /proc stat format');
    }
    const fields = content.slice(closing + 2).split(' ');
    return { userJiffies: Number(fields[11]), systemJiffies: Number(fields[12]) };
}

function procMetrics(pid) {
    const stat = parseProcStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = /^VmRSS:\s+(\d+) kB$/m.exec(status);
    return { ...stat, rssKb: match ? Number(match[1]) : null };
}

function instancePids(instances) {
    const lines = execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' }).split('\n');
    const result = {};
    for (const instance of instances) {
        const line = lines.find(candidate => {
            const match = /^\s*(\d+)\s+(.+)$/.exec(candidate);
            return match && match[2] === `io.${instance}`;
        });
        if (!line) {
            throw new Error(`No running process for ${instance}`);
        }
        result[instance] = Number(line.trim().split(/\s+/, 1)[0]);
    }
    return result;
}

function durationSeconds(value) {
    const parsed = Number(value === undefined ? 30 : value);
    if (!Number.isInteger(parsed) || parsed < 5 || parsed > 300) {
        throw new RangeError('BENCHMARK_SECONDS must be an integer between 5 and 300');
    }
    return parsed;
}

async function main() {
    const seconds = durationSeconds(process.env.BENCHMARK_SECONDS);
    const instances = (process.env.VEDIRECT_INSTANCES || 'vedirect.0,vedirect.1').split(',').map(value => value.trim());
    const Redis = require('ioredis').default;
    const pids = instancePids(instances);
    const redis = new Redis({ host: process.env.IOB_STATESDB_HOST || '192.168.8.40', port: 6379 });
    const monitor = await redis.monitor();
    const writes = Object.fromEntries(instances.map(instance => [instance, 0]));
    monitor.on('monitor', (_time, args) => {
        const key = String(args[1] || '');
        if (writeCommand(args[0])) {
            for (const instance of instances) {
                if (key.startsWith(`io.${instance}.`)) {
                    writes[instance]++;
                }
            }
        }
    });
    const before = Object.fromEntries(instances.map(instance => [instance, procMetrics(pids[instance])]));
    const started = Date.now();
    await new Promise(resolve => setTimeout(resolve, seconds * 1000));
    const elapsedSeconds = (Date.now() - started) / 1000;
    const after = Object.fromEntries(instances.map(instance => [instance, procMetrics(pids[instance])]));
    const states = {};
    for (const instance of instances) {
        const raw = await redis.get(`io.system.adapter.${instance}.eventLoopLag`);
        states[instance] = raw ? JSON.parse(raw).val : null;
    }
    const result = {
        startedAt: new Date(started).toISOString(),
        finishedAt: new Date().toISOString(),
        elapsedSeconds,
        messageBuffer: Number(process.env.BENCHMARK_BUFFER || 0),
        expireTime: process.env.BENCHMARK_EXPIRE || '0',
        instances: {},
    };
    for (const instance of instances) {
        const cpuJiffies =
            after[instance].userJiffies +
            after[instance].systemJiffies -
            before[instance].userJiffies -
            before[instance].systemJiffies;
        result.instances[instance] = {
            pid: pids[instance],
            cpuPercent: Number(((cpuJiffies / (elapsedSeconds * 100)) * 100).toFixed(2)),
            rssMb: after[instance].rssKb === null ? null : Number((after[instance].rssKb / 1024).toFixed(1)),
            stateWrites: writes[instance],
            writesPerSecond: Number((writes[instance] / elapsedSeconds).toFixed(3)),
            eventLoopLag: states[instance],
        };
    }
    await monitor.disconnect();
    await redis.quit();
    console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
    main().catch(error => {
        console.error(error instanceof Error ? error.stack : String(error));
        process.exitCode = 1;
    });
}

module.exports = { writeCommand, parseProcStat, durationSeconds };
