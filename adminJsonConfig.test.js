'use strict';

const fs = require('node:fs');
const net = require('node:net');
const { expect } = require('chai');
const Ajv = require('@iobroker/testing/node_modules/ajv');
const { normalizeTcpTarget } = require('./lib/veDirectTcpPort');

const config = require('./admin/jsonConfig.json');
const ioPackage = require('./io-package.json');
const schemas = {
    minimum: require('./test/fixtures/jsonConfig-7.6.20.schema.json'),
    current: require('./test/fixtures/jsonConfig-current.schema.json'),
};
const languages = ['de', 'es', 'fr', 'it', 'nl', 'pl', 'pt', 'ru', 'uk', 'zh-cn'];

function evaluate(expression, data) {
    return new Function('data', `return (${expression});`)(data);
}

function runtimeAccepts(host) {
    try {
        normalizeTcpTarget({ host, port: 1234 });
        return true;
    } catch {
        return false;
    }
}

describe('Admin 5 jsonConfig', () => {
    it('is valid against pinned minimum/current schemas and keeps every native key/default', () => {
        for (const [name, schema] of Object.entries(schemas)) {
            const candidate = name === 'minimum' ? structuredClone(config) : config;
            if (name === 'minimum') {
                // Admin 7.6.20's schema misspells the renderer's actual
                // `closeable` property as `closable`. Transform only this test
                // candidate; production keeps the non-dismissible warning.
                for (const item of Object.values(candidate.items)) {
                    if (Object.hasOwn(item, 'closeable')) {
                        item.closable = item.closeable;
                        delete item.closeable;
                    }
                }
            }
            const ajv = new Ajv({ strict: false, allErrors: true });
            const valid = ajv.validate(schema, candidate);
            expect(valid, `${name}: ${ajv.errorsText()}`).to.equal(true);
        }
        expect(config.items._tcpWarning.closeable).to.equal(false);
        expect(config.items._controlWarning.closeable).to.equal(false);

        expect(ioPackage.common.adminUI).to.deep.equal({ config: 'json' });
        expect(ioPackage.native).to.deep.equal({
            byUSB: true,
            byTCPIP: false,
            tcpHost: '',
            tcpPort: 0,
            USBDevice: '',
            expireTime: 0,
            messageBuffer: 0,
            hexReadEnabled: false,
            chargerControlEnabled: false,
            currentLimitControlEnabled: false,
            currentLimitMax: 0,
            currentLimitRefreshSeconds: 20,
        });
        for (const [key, item] of Object.entries(config.items)) {
            if (!key.startsWith('_')) {
                expect(ioPackage.native, key).to.have.property(key);
            }
            for (const size of ['xs', 'sm', 'md', 'lg', 'xl']) {
                expect(item[size], `${key}.${size}`).to.be.within(1, 12);
            }
        }
        for (const legacy of [
            'admin/index_m.html',
            'admin/style.css',
            'admin/words.js',
            'admin/admin.d.ts',
            'admin/tsconfig.json',
        ]) {
            expect(fs.existsSync(legacy), `${legacy} was removed`).to.equal(false);
        }
    });

    it('validates serial and TCP targets conditionally including IPv6 and hidden defaults', () => {
        const serial = config.items.USBDevice;
        const host = config.items.tcpHost;
        const port = config.items.tcpPort;
        for (const [value, expected] of [
            ['', false],
            ['/dev/xxx', false],
            ['/dev/ttyUSB0', true],
            [' /dev/serial/by-id/device ', true],
        ]) {
            expect(evaluate(serial.validator, { byTCPIP: false, USBDevice: value }), value).to.equal(expected);
        }
        expect(evaluate(serial.validator, { byTCPIP: true, USBDevice: '' })).to.equal(true);
        expect(evaluate(serial.hidden, { byTCPIP: true })).to.equal(true);

        for (const [value, expected] of [
            ['localhost', true],
            ['127.0.0.1', true],
            ['ve-direct.local', true],
            ['example.com.', true],
            ['::1', true],
            ['::', true],
            ['2001:db8::1', true],
            ['1:2:3:4:5:6:7:8', true],
            ['1:2:3:4:5:6:192.0.2.1', true],
            ['0:0:0:0:0:ffff:192.0.2.1', true],
            ['::ffff:192.0.2.1', true],
            ['::ffff:0:192.0.2.1', true],
            ['fe80::1%lo0', true],
            ['2001:db8::1%lo0', true],
            ['::1%42', true],
            ['1:2:3:4:5:6:7:8%eth0', true],
            ['', false],
            ['host name', false],
            ['host/path', false],
            ['http://host', false],
            ['host:1234', false],
            ['host?x=1', false],
            [':::', false],
            ['dead:beef:cafe', false],
            ['1:2:3:4:5:6:7:8:9', false],
            ['1:2:3:4:5:192.0.2.1', false],
            ['1:2:3:4:5:6:7:192.0.2.1', false],
            ['1::2::3', false],
            ['::ffff:999.1.1.1', false],
            ['::ffff:192.168.001.001', false],
            ['::ffff:192.0.2.01', false],
            ['192.0.2.1::', false],
            ['192.0.2.1::%lo0', false],
            ['fe80:%lo0', false],
            ['fe80::1%a_b', false],
            ['fe80::1%-bad', false],
            ['fe80::1%', false],
            ['::1%eth%0', false],
        ]) {
            expect(evaluate(host.validator, { byTCPIP: true, tcpHost: value }), value).to.equal(expected);
            expect(runtimeAccepts(value), `runtime parity for ${value}`).to.equal(expected);
        }
        expect(evaluate(host.validator, { byTCPIP: false, tcpHost: '' })).to.equal(true);
        expect(evaluate(host.hidden, { byTCPIP: false })).to.equal(true);

        for (const value of [1, 1234, 65535, '1234']) {
            expect(evaluate(port.validator, { byTCPIP: true, tcpPort: value }), String(value)).to.equal(true);
        }
        for (const value of [0, 65536, 1.5, '1.5', '1e3', '', Infinity, NaN]) {
            expect(evaluate(port.validator, { byTCPIP: true, tcpPort: value }), String(value)).to.equal(false);
        }
        expect(evaluate(port.validator, { byTCPIP: false, tcpPort: 0 })).to.equal(true);
        expect(evaluate(port.hidden, { byTCPIP: false })).to.equal(true);
    });

    it('matches native IPv6 grammar across scoped and embedded IPv4 combinations', () => {
        const addresses = [
            '::',
            '::1',
            '1::',
            '1:2:3:4:5:6:7:8',
            '::ffff:192.0.2.1',
            '::ffff:0:192.0.2.1',
            '::192.0.2.1',
            '1::192.0.2.1',
            '192.0.2.1::',
            '1:192.0.2.1::',
            '1:2:3:4:5:192.0.2.1::',
            '0:0:0:0:0:ffff:192.0.2.1',
            '1:2:3:4:5:6:192.0.2.1',
            '2001:db8::1',
            'fe80::1',
            'fe80:',
            ':::',
            '1::2::3',
            'dead:beef:cafe',
            '1:2:3:4:5:192.0.2.1',
            '1:2:3:4:5:6:7:192.0.2.1',
            '::ffff:192.168.001.001',
            '::ffff:999.1.1.1',
            '1:2:3:4:5:6:7:8:9',
            'gg::1',
        ];
        const scopes = [undefined, 'lo0', '42', 'a_b', '-bad', ''];
        for (const address of addresses) {
            for (const scope of scopes) {
                const value = scope === undefined ? address : `${address}%${scope}`;
                const expected = net.isIP(address) === 6 && (scope === undefined || /^[a-z0-9]+$/i.test(scope));
                expect(evaluate(config.items.tcpHost.validator, { byTCPIP: true, tcpHost: value }), value).to.equal(
                    expected,
                );
                expect(runtimeAccepts(value), `runtime parity for ${value}`).to.equal(expected);
            }
        }
    });

    it('gates current controls by opt-in and accepts legacy numeric strings', () => {
        const max = config.items.currentLimitMax;
        const refresh = config.items.currentLimitRefreshSeconds;
        for (const value of [0, 0.05, -1, 6553.5, 12.30000000001, Infinity, NaN]) {
            expect(
                evaluate(max.validator, { currentLimitControlEnabled: true, currentLimitMax: value }),
                String(value),
            ).to.equal(false);
        }
        for (const value of [0.1, 12.3, 50, 6553.4, '12.3', '50', '6553.4']) {
            expect(
                evaluate(max.validator, { currentLimitControlEnabled: true, currentLimitMax: value }),
                String(value),
            ).to.equal(true);
        }
        expect(evaluate(max.validator, { currentLimitControlEnabled: false, currentLimitMax: 0 })).to.equal(true);
        expect(evaluate(max.hidden, { currentLimitControlEnabled: false })).to.equal(true);

        for (const value of [4, 51, 5.5, 0, Infinity, NaN]) {
            expect(
                evaluate(refresh.validator, { currentLimitControlEnabled: true, currentLimitRefreshSeconds: value }),
                String(value),
            ).to.equal(false);
        }
        for (const value of [5, 20, 50, '5', '20', '50']) {
            expect(
                evaluate(refresh.validator, { currentLimitControlEnabled: true, currentLimitRefreshSeconds: value }),
                String(value),
            ).to.equal(true);
        }
        expect(
            evaluate(refresh.validator, { currentLimitControlEnabled: false, currentLimitRefreshSeconds: 0 }),
        ).to.equal(true);
        expect(evaluate(refresh.hidden, { currentLimitControlEnabled: false })).to.equal(true);
    });

    it('provides every displayed text and validator error in every non-English catalog', () => {
        const keys = new Set();
        for (const item of Object.values(config.items)) {
            for (const property of ['label', 'text', 'placeholder', 'tooltip', 'validatorErrorText']) {
                if (item[property]) {
                    keys.add(item[property]);
                }
            }
        }
        for (const language of ['en', ...languages]) {
            expect(fs.existsSync(`admin/i18n/${language}.json`), `${language}: short layout`).to.equal(true);
            expect(
                fs.existsSync(`admin/i18n/${language}/translations.json`),
                `${language}: no duplicate long layout`,
            ).to.equal(false);
        }
        const english = JSON.parse(fs.readFileSync('admin/i18n/en.json', 'utf8'));
        for (const key of keys) {
            expect(english[key], `English key ${key}`).to.be.a('string').and.not.equal('');
        }
        for (const language of languages) {
            const values = JSON.parse(fs.readFileSync(`admin/i18n/${language}.json`, 'utf8'));
            for (const key of keys) {
                expect(values[key], `${language}: ${key}`).to.be.a('string').and.not.equal('');
            }
        }
    });
});
