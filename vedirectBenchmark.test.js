'use strict';

const { expect } = require('chai');
const { writeCommand, parseProcStat, durationSeconds } = require('./tools/vedirect-benchmark');

describe('VE.Direct benchmark helpers', () => {
    it('counts only actual state writes, not reads or publishes', () => {
        expect(writeCommand('set')).to.equal(true);
        expect(writeCommand('SETEX')).to.equal(true);
        expect(writeCommand('mset')).to.equal(true);
        expect(writeCommand('get')).to.equal(false);
        expect(writeCommand('publish')).to.equal(false);
        expect(writeCommand('expire')).to.equal(false);
    });

    it('parses user and system CPU jiffies from proc stat', () => {
        const result = parseProcStat('1234 (io.vedirect.0) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16');
        expect(result.userJiffies).to.equal(11);
        expect(result.systemJiffies).to.equal(12);
        expect(() => parseProcStat('invalid')).to.throw(/Invalid/);
    });

    it('accepts only bounded integer benchmark durations', () => {
        expect(durationSeconds(30)).to.equal(30);
        expect(durationSeconds('60')).to.equal(60);
        for (const value of [0, 4, 301, 1.5, 'abc']) {
            expect(() => durationSeconds(value)).to.throw();
        }
    });
});
