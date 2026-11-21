'use strict';

const { expect } = require('chai');
const { parseArgs, resourceGrowthErrors } = require('./helpers');
const { makeFrame, SoakRunner } = require('./run');
const { VeDirectParser } = require('../../lib/veDirect/veDirectParser');

describe('VE.Direct soak helpers', () => {
    it('parses bounded short and long-run options', () => {
        expect(parseArgs([])).to.deep.equal({ scenario: 'short', durationSeconds: 3600, sampleSeconds: 10, output: undefined });
        expect(parseArgs(['--scenario=cycle', '--duration', '300', '--sample=5', '--output', 'report.json'])).to.deep.equal({
            scenario: 'cycle',
            durationSeconds: 300,
            sampleSeconds: 5,
            output: 'report.json',
        });
        for (const args of [
            ['--scenario=unknown'],
            ['--duration=29'],
            ['--duration=86401'],
            ['--sample=0'],
            ['--sample=301'],
            ['--output='],
            ['--unknown'],
        ]) {
            expect(() => parseArgs(args), args.join(' ')).to.throw();
        }
    });

    it('accepts bounded resource growth and rejects heap/socket/timer growth', () => {
        const baseline = { heapUsedMb: 40, rssMb: 60, resources: { TCPSocketWrap: 2, TCPServerWrap: 1, Timeout: 4, Immediate: 3 } };
        expect(
            resourceGrowthErrors(baseline, {
                heapUsedMb: 45,
                rssMb: 70,
                resources: { TCPSocketWrap: 2, TCPServerWrap: 1, Timeout: 5, Immediate: 5 },
            }),
        ).to.deep.equal([]);
        const errors = resourceGrowthErrors(baseline, {
            heapUsedMb: 60,
            rssMb: 100,
            resources: { TCPSocketWrap: 5, TCPServerWrap: 2, Timeout: 8, Immediate: 10 },
        });
        expect(errors).to.have.lengthOf(6);
        expect(errors.join('\n')).to.include('heapUsed');
        expect(errors.join('\n')).to.include('RSS');
        expect(errors.join('\n')).to.include('TCPSocketWrap');
        expect(errors.join('\n')).to.include('TCPServerWrap');
        expect(errors.join('\n')).to.include('Timeout');
        expect(errors.join('\n')).to.include('Immediate');
        const legacyErrors = resourceGrowthErrors(baseline, {
            heapUsedMb: 40,
            rssMb: 60,
            resources: { TCPSocket: 1, TCPServer: 1 },
        });
        expect(legacyErrors).to.have.lengthOf(2);
    });

    it('bounds report sample retention independently of run duration', () => {
        const runner = new SoakRunner({ scenario: 'short', durationSeconds: 3600, sampleSeconds: 10 });
        for (let index = 0; index < 2005; index++) {
            runner.sample('bounded', []);
        }
        expect(runner.samples).to.have.lengthOf(2000);
        expect(runner.droppedSamples).to.equal(5);
        expect(runner.samples[0].label).to.equal('bounded');
        expect(runner.samples[1999].label).to.equal('bounded');
    });

    it('generates checksum-valid changing VE.Direct frames', () => {
        const frames = [];
        const parser = new VeDirectParser();
        parser.onFrame = frame => frames.push(frame);
        parser.receive(Buffer.concat([makeFrame(13001), makeFrame(13002)]));
        expect(frames).to.deep.equal([
            { V: 13.001, VPV: 1 },
            { V: 13.002, VPV: 1 },
        ]);
    });
});
