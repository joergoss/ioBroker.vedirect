'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const { READ_FIELDS, probeRegisters } = require('./tools/hex-get-probe');

describe('Read-only VE.Direct HEX hardware probe', () => {
    it('uses only Get operations for every whitelisted register', async () => {
        const com = { isOpen: sinon.stub().returns(true) };
        const client = { getField: sinon.stub().callsFake(name => Promise.resolve(`value:${name}`)) };
        const result = await probeRegisters(com, client);
        expect(client.getField.getCalls().map(call => call.args[0])).to.deep.equal(READ_FIELDS);
        expect(result.errors).to.deep.equal({});
        expect(result.values.capabilities).to.equal('value:capabilities');
        expect(result.values.chargeCurrentLimit).to.equal('value:chargeCurrentLimit');
    });

    it('reports an individual read error and continues independent Gets', async () => {
        const com = { isOpen: sinon.stub().returns(true) };
        const client = { getField: sinon.stub().callsFake(name => Promise.resolve(name)) };
        client.getField.withArgs('networkMode').rejects(new Error('Unknown ID'));
        const result = await probeRegisters(com, client);
        expect(client.getField.callCount).to.equal(READ_FIELDS.length);
        expect(result.errors.networkMode).to.equal('Unknown ID');
        expect(result.values.deviceMode).to.equal('deviceMode');
    });

    it('stops after a fatal disconnect instead of issuing further requests', async () => {
        const com = { isOpen: sinon.stub().returns(false) };
        const client = { getField: sinon.stub().rejects(new Error('port closed')) };
        const result = await probeRegisters(com, client);
        expect(client.getField.calledOnceWith(READ_FIELDS[0])).to.equal(true);
        expect(result.values).to.deep.equal({});
        expect(result.errors[READ_FIELDS[0]]).to.equal('port closed');
    });
});
