'use strict';

const { expect } = require('chai');
const { DIAGNOSTIC_FRAME_PUBLISH_MS, DIAGNOSTIC_STATES } = require('./lib/veDirect/diagnostics');

const languages = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];

describe('VE.Direct read-only diagnostics registry', () => {
    it('defines exactly six additive info states with bounded event-only publication', () => {
        expect(DIAGNOSTIC_FRAME_PUBLISH_MS).to.equal(30000);
        expect(DIAGNOSTIC_STATES.map(definition => definition.id)).to.deep.equal([
            'info.transport',
            'info.lastValidFrameAt',
            'info.reconnectCount',
            'info.checksumErrors',
            'info.parserErrors',
            'info.lastTransportError',
        ]);
        expect(new Set(DIAGNOSTIC_STATES.map(definition => definition.id)).size).to.equal(6);
        expect(DIAGNOSTIC_FRAME_PUBLISH_MS).to.be.greaterThanOrEqual(10000);
    });

    it('provides complete translations and current read-only-compatible metadata', () => {
        for (const definition of DIAGNOSTIC_STATES) {
            expect(Object.keys(definition.name).sort()).to.deep.equal([...languages].sort());
            for (const language of languages) {
                expect(definition.name[language], `${definition.id}: ${language}`).to.be.a('string').and.not.equal('');
            }
            expect(definition.role).to.be.oneOf(['text', 'value', 'value.time']);
            expect(definition.type).to.be.oneOf(['string', 'number']);
            if (definition.type === 'number') {
                expect(Number.isFinite(definition.def)).to.equal(true);
                expect(definition.def).to.be.at.least(0);
                expect(definition.min).to.equal(0);
            } else {
                expect(definition.def).to.equal('');
            }
        }
        expect(DIAGNOSTIC_STATES.find(definition => definition.id === 'info.lastValidFrameAt')).to.include({
            role: 'value.time',
            unit: 'ms',
            def: 0,
        });
    });
});
