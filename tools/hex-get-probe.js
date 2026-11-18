'use strict';

const { VeDirectCom } = require('../lib/veDirectCom');
const { VeDirectHexClient } = require('../lib/veDirectHexClient');

const READ_FIELDS = Object.freeze([
    'capabilities',
    'deviceMode',
    'deviceState',
    'remoteControlUsed',
    'networkMode',
    'maxBatteryCurrent',
    'chargeCurrentLimit',
    'chargeVoltageSetpoint',
]);

async function probeRegisters(com, client) {
    const values = {};
    const errors = {};
    for (const name of READ_FIELDS) {
        try {
            values[name] = await client.getField(name);
        } catch (error) {
            errors[name] = error instanceof Error ? error.message : String(error);
            if (!com.isOpen()) {
                break;
            }
        }
    }
    return { values, errors };
}

async function main() {
    const serialPath = String(process.argv[2] || '').trim();
    if (!serialPath || serialPath.startsWith('--')) {
        console.error('Usage: node tools/hex-get-probe.js /dev/ttyUSB-VE-1');
        process.exitCode = 2;
        return;
    }
    const com = new VeDirectCom(undefined, { openTimeoutMs: 10000, closeTimeoutMs: 5000 });
    const client = new VeDirectHexClient(com, { responseTimeoutMs: 2000, maxQueueSize: 2 });
    client.onError = error => console.error(`HEX close error: ${error.message}`);
    com.onError = error => console.error(`Serial error: ${error.message}`);
    try {
        await com.open(serialPath);
        const result = await probeRegisters(com, client);
        console.log(
            JSON.stringify(
                {
                    serialPath,
                    access: 'HEX_GET_ONLY',
                    node: process.version,
                    ...result,
                },
                null,
                2,
            ),
        );
        if (Object.keys(result.errors).length > 0) {
            process.exitCode = 1;
        }
    } finally {
        client.cancel(new Error('Read-only HEX probe finished'));
        await com.close().catch(error => {
            console.error(`Could not close serial port: ${error.message}`);
            process.exitCode = 1;
        });
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error(error instanceof Error ? error.stack : String(error));
        process.exitCode = 1;
    });
}

module.exports = { READ_FIELDS, probeRegisters };
