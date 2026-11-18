'use strict';

const { expect } = require('chai');
const {
    REGISTER_IDS,
    HEX_FIELDS,
    CAPABILITY_BITS,
    DEVICE_MODE_VALUES,
    NETWORK_MODES,
    REGISTER_ERROR_FLAGS,
    encodeRaw,
    decodeRaw,
    isRegisterError,
    decodeDeviceMode,
    decodeNetworkMode,
    hasCapability,
} = require('./lib/veDirect/hexFields.js');

const bytes = (...values) => Buffer.from(values);
const hex = value => Buffer.from(value.replaceAll(' ', ''), 'hex');

describe('VE.Direct HEX field registry', () => {
    it('contains exactly the eight documented register IDs', () => {
        expect(REGISTER_IDS).to.deep.equal({
            capabilities: 0x0140,
            deviceMode: 0x0200,
            deviceState: 0x0201,
            remoteControlUsed: 0x0202,
            networkMode: 0x200e,
            chargeCurrentLimit: 0x2015,
            maxBatteryCurrent: 0xedf0,
            chargeVoltageSetpoint: 0x2001,
        });
        expect(Object.keys(HEX_FIELDS)).to.have.members(Object.keys(REGISTER_IDS));
        expect(Object.keys(HEX_FIELDS)).to.have.lengthOf(8);
    });

    it('publishes immutable, prototype-safe register metadata', () => {
        expect(Object.getPrototypeOf(HEX_FIELDS)).to.equal(null);
        expect(Object.isFrozen(HEX_FIELDS)).to.equal(true);
        for (const [name, field] of Object.entries(HEX_FIELDS)) {
            expect(Object.isFrozen(field), name).to.equal(true);
            expect(field.name).to.equal(name);
            expect(field.id).to.equal(REGISTER_IDS[name]);
            expect(field.signed).to.equal(false);
            expect(field.readable).to.equal(true);
            expect(field.writable).to.equal(!field.readOnly);
        }
        expect(() => {
            HEX_FIELDS.deviceMode.id = 0xffff;
        }).to.throw(TypeError);
        expect(REGISTER_IDS.deviceMode).to.equal(0x0200);
    });

    it('describes exact unsigned widths, scales and adapter access', () => {
        const fixtures = [
            ['capabilities', 'un32', 4, 1, '', false],
            ['deviceMode', 'un8', 1, 1, '', true],
            ['deviceState', 'un8', 1, 1, '', false],
            ['remoteControlUsed', 'un32', 4, 1, '', false],
            ['networkMode', 'un8', 1, 1, '', true],
            ['chargeCurrentLimit', 'un16', 2, 0.1, 'A', true],
            ['maxBatteryCurrent', 'un16', 2, 0.1, 'A', false],
            ['chargeVoltageSetpoint', 'un16', 2, 0.01, 'V', false],
        ];
        for (const [name, type, width, scale, unit, writable] of fixtures) {
            const field = HEX_FIELDS[name];
            expect(field.type, name).to.equal(type);
            expect(field.bytes, name).to.equal(width);
            expect(field.scale, name).to.equal(scale);
            expect(field.unit, name).to.equal(unit);
            expect(field.writable, name).to.equal(writable);
        }
        expect(HEX_FIELDS.networkMode.writableValues).to.deep.equal([0, 5]);
        expect(HEX_FIELDS.chargeCurrentLimit.min).to.equal(0);
        expect(HEX_FIELDS.chargeCurrentLimit.max).to.equal(6553.5);
    });

    it('exports stable capability, device-mode, network-mode and flag constants', () => {
        expect(CAPABILITY_BITS).to.deep.equal({ externalControl: 15 });
        expect(DEVICE_MODE_VALUES).to.deep.equal({ offLegacy: 0, on: 1, off: 4 });
        expect(NETWORK_MODES).to.deep.equal({ standalone: 0, slave: 3, external: 5, bms: 9, chargeMaster: 0x21 });
        expect(REGISTER_ERROR_FLAGS).to.deep.equal({ unknownId: 1, notSupported: 2, parameterError: 4 });
        expect(HEX_FIELDS.capabilities.values).to.equal(CAPABILITY_BITS);
        expect(HEX_FIELDS.deviceMode.values).to.equal(DEVICE_MODE_VALUES);
        expect(HEX_FIELDS.networkMode.values).to.equal(NETWORK_MODES);
    });

    it('has no runtime module dependencies', () => {
        const loadedModule = require.cache[require.resolve('./lib/veDirect/hexFields.js')];
        expect(loadedModule.children).to.deep.equal([]);
    });
});

describe('VE.Direct HEX capabilities', () => {
    const fixtures = [
        ['zero', '00 00 00 00', 0],
        ['external control only', '00 80 00 00', 0x00008000],
        ['several low and high bits', '05 80 01 00', 0x00018005],
        ['all bits', 'ff ff ff ff', 0xffffffff],
    ];
    for (const [label, payload, expected] of fixtures) {
        it(`decodes ${label} as little-endian un32`, () => {
            expect(decodeRaw('capabilities', hex(payload))).to.equal(expected);
        });
    }

    it('detects ExternalControl at bit 15', () => {
        expect(hasCapability(decodeRaw('capabilities', hex('00 80 00 00')), CAPABILITY_BITS.externalControl)).to.equal(
            true,
        );
        expect(hasCapability(decodeRaw('capabilities', hex('ff 7f 00 00')), CAPABILITY_BITS.externalControl)).to.equal(
            false,
        );
    });

    it('checks bit 31 without signed bitwise overflow', () => {
        expect(hasCapability(0x80000000, 31)).to.equal(true);
        expect(hasCapability(0x7fffffff, 31)).to.equal(false);
        expect(hasCapability(0xffffffff, 0)).to.equal(true);
        expect(hasCapability(0xffffffff, 31)).to.equal(true);
        expect(hasCapability(0, 0)).to.equal(false);
    });

    it('rejects out-of-range or coerced capability masks and bits', () => {
        for (const value of [-1, 0x100000000, 1.5, NaN, Infinity, '32768', null, 32768n]) {
            expect(() => hasCapability(value, 15), String(value)).to.throw();
        }
        for (const bit of [-1, 32, 1.5, NaN, Infinity, '15', null, 15n]) {
            expect(() => hasCapability(0x8000, bit), String(bit)).to.throw();
        }
    });

    it('does not expose capabilities as a control', () => {
        expect(() => encodeRaw('capabilities', 0x8000)).to.throw(/read-only/);
    });
});

describe('VE.Direct HEX device mode and state', () => {
    it('encodes boolean on as 1', () => {
        expect(encodeRaw('deviceMode', true)).to.deep.equal(bytes(1));
    });

    it('encodes boolean off with the firmware-1.17-and-newer value 4', () => {
        expect(encodeRaw('deviceMode', false)).to.deep.equal(bytes(4));
    });

    it('rejects numeric and textual boolean coercion', () => {
        for (const value of [0, 1, 4, 'true', 'false', '', null, undefined, 0n, {}, []]) {
            expect(() => encodeRaw('deviceMode', value), String(value)).to.throw(TypeError);
        }
    });

    const modeFixtures = [
        [0, false, 'legacy off through firmware 1.16'],
        [1, true, 'on'],
        [4, false, 'off from firmware 1.17'],
    ];
    for (const [raw, expected, label] of modeFixtures) {
        it(`decodes ${label}`, () => {
            expect(decodeDeviceMode(raw)).to.equal(expected);
            expect(decodeRaw('deviceMode', bytes(raw))).to.equal(expected);
        });
    }

    it('rejects unknown device modes without treating them as falsy off states', () => {
        for (const raw of [2, 3, 5, 0xff, -1, 256, 1.5, '1', true, null]) {
            expect(() => decodeDeviceMode(raw), String(raw)).to.throw();
        }
        expect(() => decodeRaw('deviceMode', bytes(2))).to.throw(/Unknown deviceMode/);
    });

    it('preserves independent raw device-state fixtures', () => {
        for (const state of [0, 2, 3, 4, 5, 7, 247, 252, 255]) {
            expect(decodeRaw('deviceState', bytes(state))).to.equal(state);
        }
    });

    it('keeps deviceState read-only', () => {
        expect(() => encodeRaw('deviceState', 3)).to.throw(/read-only/);
    });
});

describe('VE.Direct HEX remoteControlUsed', () => {
    const fixtures = [
        ['00 00 00 00', 0],
        ['02 00 00 00', 2],
        ['01 00 00 80', 0x80000001],
        ['ff ff ff ff', 0xffffffff],
    ];
    for (const [payload, expected] of fixtures) {
        it(`decodes ${payload} as an independent little-endian un32 fixture`, () => {
            expect(decodeRaw('remoteControlUsed', hex(payload))).to.equal(expected);
        });
    }

    it('does not make protocol set semantics an initial adapter control', () => {
        expect(HEX_FIELDS.remoteControlUsed.readOnly).to.equal(true);
        expect(() => encodeRaw('remoteControlUsed', 2)).to.throw(/read-only/);
    });
});

describe('VE.Direct HEX network mode', () => {
    it('encodes standalone control as raw zero', () => {
        expect(encodeRaw('networkMode', 0)).to.deep.equal(bytes(0));
    });

    it('encodes external control as raw five', () => {
        expect(encodeRaw('networkMode', 5)).to.deep.equal(bytes(5));
    });

    it('rejects slave, BMS and read-only Charge Master for writing although all are decodable', () => {
        expect(() => encodeRaw('networkMode', NETWORK_MODES.slave)).to.throw(/only standalone/);
        expect(() => encodeRaw('networkMode', NETWORK_MODES.bms)).to.throw(/only standalone/);
        expect(() => encodeRaw('networkMode', NETWORK_MODES.chargeMaster)).to.throw(/only standalone/);
    });

    it('rejects undocumented modes, overflow and enum coercion for writing', () => {
        for (const value of [1, 2, 4, 6, 33, 255, -1, 256, 1.5, NaN, Infinity, '0', '5', 'external', null, true]) {
            expect(() => encodeRaw('networkMode', value), String(value)).to.throw();
        }
    });

    const fixtures = [
        [0, 'standalone'],
        [3, 'slave'],
        [5, 'external'],
        [9, 'bms'],
        [0x21, 'chargeMaster'],
    ];
    for (const [raw, expected] of fixtures) {
        it(`decodes documented raw mode ${raw} as ${expected}`, () => {
            expect(decodeNetworkMode(raw)).to.equal(expected);
            expect(decodeRaw('networkMode', bytes(raw))).to.equal(expected);
        });
    }

    it('rejects unknown network modes instead of silently passing them through', () => {
        for (const raw of [1, 2, 4, 6, 8, 10, 34, 255, -1, 256, 1.5, '5', null]) {
            expect(() => decodeNetworkMode(raw), String(raw)).to.throw();
        }
        expect(() => decodeRaw('networkMode', bytes(34))).to.throw(/Unknown networkMode/);
    });
});

describe('VE.Direct HEX chargeCurrentLimit', () => {
    const encodeFixtures = [
        [0, '00 00'],
        [0.1, '01 00'],
        [0.3, '03 00'],
        [1, '0a 00'],
        [2.3, '17 00'],
        [12.3, '7b 00'],
        [50, 'f4 01'],
        [6553.5, 'ff ff'],
    ];
    for (const [value, payload] of encodeFixtures) {
        it(`encodes exactly representable ${value} A without binary floating-point rejection`, () => {
            expect(encodeRaw('chargeCurrentLimit', value)).to.deep.equal(hex(payload));
        });
    }

    const decodeFixtures = [
        ['00 00', 0],
        ['01 00', 0.1],
        ['17 00', 2.3],
        ['7b 00', 12.3],
        ['f4 01', 50],
        ['ff ff', 6553.5],
    ];
    for (const [payload, expected] of decodeFixtures) {
        it(`decodes little-endian fixture ${payload} to ${expected} A`, () => {
            expect(decodeRaw('chargeCurrentLimit', hex(payload))).to.equal(expected);
        });
    }

    it('rejects values that would require silent 0.1 A rounding', () => {
        for (const value of [0.01, 0.15, 1.23, 12.34, 0.30000000000000004, 1e-7, 6553.55]) {
            expect(() => encodeRaw('chargeCurrentLimit', value), String(value)).to.throw();
        }
    });

    it('rejects negative current limits and un16 overflow', () => {
        for (const value of [-0.1, -1, -6553.5, 6553.6, 6554, 65535, Number.MAX_VALUE]) {
            expect(() => encodeRaw('chargeCurrentLimit', value), String(value)).to.throw();
        }
    });

    it('rejects non-finite numbers and every non-number coercion', () => {
        for (const value of [NaN, Infinity, -Infinity, '12.3', '', null, undefined, true, false, 123n, {}, []]) {
            expect(() => encodeRaw('chargeCurrentLimit', value), String(value)).to.throw();
        }
    });

    it('returns independent payload buffers', () => {
        const first = encodeRaw('chargeCurrentLimit', 1);
        const second = encodeRaw('chargeCurrentLimit', 1);
        first[0] = 0xff;
        expect(second).to.deep.equal(bytes(10, 0));
    });
});

describe('VE.Direct HEX read-only scaled settings', () => {
    const currentFixtures = [
        ['00 00', 0],
        ['01 00', 0.1],
        ['2c 01', 30],
        ['7b 00', 12.3],
        ['ff ff', 6553.5],
    ];
    for (const [payload, expected] of currentFixtures) {
        it(`decodes maxBatteryCurrent fixture ${payload} independently`, () => {
            expect(decodeRaw('maxBatteryCurrent', hex(payload))).to.equal(expected);
        });
    }

    const voltageFixtures = [
        ['00 00', 0],
        ['01 00', 0.01],
        ['1d 00', 0.29],
        ['a0 05', 14.4],
        ['d2 04', 12.34],
        ['ff ff', 655.35],
    ];
    for (const [payload, expected] of voltageFixtures) {
        it(`decodes chargeVoltageSetpoint fixture ${payload} at exact 0.01 V scale`, () => {
            expect(decodeRaw('chargeVoltageSetpoint', hex(payload))).to.equal(expected);
        });
    }

    it('keeps maxBatteryCurrent read-only in the adapter', () => {
        expect(() => encodeRaw('maxBatteryCurrent', 30)).to.throw(/read-only/);
    });

    it('keeps chargeVoltageSetpoint read-only in this expansion stage', () => {
        expect(() => encodeRaw('chargeVoltageSetpoint', 14.4)).to.throw(/read-only/);
    });
});

describe('VE.Direct HEX strict names and payload widths', () => {
    it('rejects unknown, inherited and non-string register names', () => {
        for (const name of [
            'unknown',
            'DeviceMode',
            '',
            'constructor',
            '__proto__',
            'toString',
            0x0200,
            null,
            undefined,
        ]) {
            expect(() => decodeRaw(name, bytes(0)), String(name)).to.throw(/Unknown VE.Direct HEX register/);
            expect(() => encodeRaw(name, 0), String(name)).to.throw(/Unknown VE.Direct HEX register/);
        }
    });

    it('requires a real Buffer rather than coercible array-like input', () => {
        for (const payload of [null, undefined, '', '00', [], [0], new Uint8Array([0]), { length: 1 }, 0]) {
            expect(() => decodeRaw('deviceState', payload), String(payload)).to.throw(TypeError);
        }
    });

    const widths = [
        ['capabilities', 4],
        ['deviceMode', 1],
        ['deviceState', 1],
        ['remoteControlUsed', 4],
        ['networkMode', 1],
        ['chargeCurrentLimit', 2],
        ['maxBatteryCurrent', 2],
        ['chargeVoltageSetpoint', 2],
    ];
    for (const [name, width] of widths) {
        it(`enforces the exact ${width}-byte width for ${name}`, () => {
            const candidates = [Buffer.alloc(0), Buffer.alloc(Math.max(0, width - 1)), Buffer.alloc(width + 1)];
            for (const payload of candidates) {
                expect(() => decodeRaw(name, payload), `${name}: ${payload.length}`).to.throw(/exactly/);
            }
        });
    }
});

describe('VE.Direct HEX response flags', () => {
    it('accepts zero as the only success flag', () => {
        expect(isRegisterError(0)).to.equal(false);
    });

    it('detects each documented register error independently', () => {
        expect(isRegisterError(REGISTER_ERROR_FLAGS.unknownId)).to.equal(true);
        expect(isRegisterError(REGISTER_ERROR_FLAGS.notSupported)).to.equal(true);
        expect(isRegisterError(REGISTER_ERROR_FLAGS.parameterError)).to.equal(true);
        expect(isRegisterError(0x07)).to.equal(true);
    });

    it('fails closed for reserved non-zero response flags', () => {
        expect(isRegisterError(0x08)).to.equal(true);
        expect(isRegisterError(0x80)).to.equal(true);
        expect(isRegisterError(0xff)).to.equal(true);
    });

    it('rejects invalid, non-finite or coerced flag bytes', () => {
        for (const flags of [-1, 256, 1.5, NaN, Infinity, -Infinity, '0', '', null, undefined, false, 0n]) {
            expect(() => isRegisterError(flags), String(flags)).to.throw();
        }
    });
});
