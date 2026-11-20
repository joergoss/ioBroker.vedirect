'use strict';

const fs = require('node:fs');
const { expect } = require('chai');
const Ajv = require('@iobroker/testing/node_modules/ajv');

const config = require('./admin/jsonConfig.json');
const ioPackage = require('./io-package.json');
const SCHEMA_URL =
    'https://raw.githubusercontent.com/ioBroker/ioBroker.admin/master/packages/jsonConfig/schemas/jsonConfig.json';
const languages = ['de', 'es', 'fr', 'it', 'nl', 'pl', 'pt', 'ru', 'uk', 'zh-cn'];

function evaluate(expression, data) {
    return new Function('data', `return (${expression});`)(data);
}

describe('Admin 5 jsonConfig', () => {
    it('is valid against the current official schema and keeps every native key/default', async () => {
        const response = await fetch(SCHEMA_URL, { signal: AbortSignal.timeout(10000) });
        expect(response.ok).to.equal(true);
        const schema = await response.json();
        const ajv = new Ajv({ strict: false, allErrors: true });
        const valid = ajv.validate(schema, config);
        expect(ajv.errorsText(undefined, { separator: '\n' })).to.equal('No errors');
        expect(valid).to.equal(true);

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

        for (const value of ['localhost', '127.0.0.1', 've-direct.local', '::1', '2001:db8::1']) {
            expect(evaluate(host.validator, { byTCPIP: true, tcpHost: value }), value).to.equal(true);
        }
        for (const value of ['', 'host name', 'host/path', 'http://host', 'host:1234', 'host?x=1']) {
            expect(evaluate(host.validator, { byTCPIP: true, tcpHost: value }), value).to.equal(false);
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

    it('gates current controls by opt-in and accepts legacy numeric strings', () => {
        const max = config.items.currentLimitMax;
        const refresh = config.items.currentLimitRefreshSeconds;
        for (const value of [0, 0.05, -1, Infinity, NaN]) {
            expect(
                evaluate(max.validator, { currentLimitControlEnabled: true, currentLimitMax: value }),
                String(value),
            ).to.equal(false);
        }
        for (const value of [0.1, 12.3, 50, '12.3', '50']) {
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
        const english = JSON.parse(fs.readFileSync('admin/i18n/en/translations.json', 'utf8'));
        for (const key of keys) {
            expect(english[key], `English key ${key}`).to.be.a('string').and.not.equal('');
        }
        for (const language of languages) {
            const values = JSON.parse(fs.readFileSync(`admin/i18n/${language}/translations.json`, 'utf8'));
            for (const key of keys) {
                expect(values[key], `${language}: ${key}`).to.be.a('string').and.not.equal('');
            }
        }
    });
});
