'use strict';

const utils = require('@iobroker/adapter-core');
const { VeDirectCom } = require('./lib/veDirectCom');
const { VE_DIRECT_FIELDS } = require('./lib/veDirect/fields');
const { CAPABILITY_BITS, NETWORK_MODES, encodeRaw, hasCapability } = require('./lib/veDirect/hexFields');

const WATCHDOG_INTERVAL_MS = 1000;
const DATA_TIMEOUT_MS = 10000;
const RECONNECT_COOLDOWN_MS = 5000;
const ERROR_LOG_COOLDOWN_MS = 60000;
const UNLOAD_DRAIN_TIMEOUT_MS = 5000;

class Vedirect extends utils.Adapter {
    constructor(options = {}) {
        super({ ...options, name: 'vedirect' });
        this.com = new VeDirectCom();
        this.serialPortPath = '';
        this.expireSeconds = 0;
        this.samplingSeconds = 0;
        this.lastFrameTime = 0;
        this.lastOpenAttempt = 0;
        this.watchDogInterval = undefined;
        this.activeWatchDog = undefined;
        this.readyPromise = undefined;
        this.unloadPromise = undefined;
        this.unloaded = false;
        this.frameQueue = Promise.resolve();
        this.pendingFrameBatch = null;
        this.frameDrainActive = false;
        this.connectionGeneration = 0;
        this.pendingSample = null;
        this.sampleTimer = undefined;
        this.unloadTimeoutMs = UNLOAD_DRAIN_TIMEOUT_MS;
        this.connectionState = undefined;
        this.connectionRequested = undefined;
        this.stateQueues = new Map();
        this.objectPromises = new Map();
        this.errorLogTimes = new Map();
        this.hexClient = undefined;
        this.hexReadEnabled = false;
        this.chargerControlEnabled = false;
        this.currentLimitControlEnabled = false;
        this.currentLimitMax = 0;
        this.currentLimitRefreshSeconds = 20;
        this.externalControlSupported = undefined;
        this.hexBootstrapPromise = undefined;
        this.hexBootstrappedGeneration = -1;
        this.nextHexBootstrapAt = 0;
        this.currentLimitOperation = undefined;
        this.currentLimitTimer = undefined;
        this.currentLimitActive = false;
        this.desiredCurrentLimit = undefined;
        this.supervisorRunning = false;
        this.on('ready', this.handleReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.on('stateChange', (id, state) => {
            void this.performStateChange(id, state).catch(error => {
                if (!this.unloaded) {
                    this.logThrottled('VE.Direct control write failed: ', error);
                }
            });
        });
    }

    handleReady() {
        if (this.readyPromise) {
            return;
        }
        const operation = this.onReady().catch(async error => {
            this.log.error(`Could not initialize VE.Direct adapter: ${this.errorText(error)}`);
            await this.safeSetConnectionState(false);
        });
        this.readyPromise = operation;
        void operation.catch(error => this.log.error(`VE.Direct ready handler failed: ${this.errorText(error)}`));
    }

    async onReady() {
        if (this.unloaded) {
            return;
        }
        await this.initConnectionObject();
        if (this.unloaded) {
            return;
        }
        await this.safeSetConnectionState(false);
        if (this.unloaded) {
            return;
        }

        this.expireSeconds = this.nonNegativeConfig(this.config.expireTime, 'expireTime');
        this.samplingSeconds = this.nonNegativeConfig(this.config.messageBuffer, 'messageBuffer');
        this.chargerControlEnabled = this.config.chargerControlEnabled === true;
        this.currentLimitControlEnabled = this.config.currentLimitControlEnabled === true;
        this.hexReadEnabled =
            this.config.hexReadEnabled === true || this.chargerControlEnabled || this.currentLimitControlEnabled;
        this.currentLimitMax = this.nonNegativeConfig(this.config.currentLimitMax, 'currentLimitMax');
        this.currentLimitRefreshSeconds = this.nonNegativeConfig(
            this.config.currentLimitRefreshSeconds === undefined ? 20 : this.config.currentLimitRefreshSeconds,
            'currentLimitRefreshSeconds',
        );
        if (this.currentLimitControlEnabled && this.currentLimitMax <= 0) {
            throw new Error('currentLimitMax must be greater than 0 when current limit control is enabled');
        }
        if (
            this.currentLimitControlEnabled &&
            (this.currentLimitRefreshSeconds < 5 || this.currentLimitRefreshSeconds > 50)
        ) {
            throw new Error(
                'currentLimitRefreshSeconds must be between 5 and 50 when current limit control is enabled',
            );
        }
        if (this.currentLimitMax > 0) {
            encodeRaw('chargeCurrentLimit', this.currentLimitMax);
        }
        await this.initControlObjects();
        await this.writeState('control.currentLimitActive', false);
        if (this.hexReadEnabled) {
            const { VeDirectHexClient } = require('./lib/veDirectHexClient');
            this.hexClient = new VeDirectHexClient(this.com);
            this.hexClient.onError = error => this.logThrottled('VE.Direct HEX client close error: ', error);
            if (this.chargerControlEnabled || this.currentLimitControlEnabled) {
                await this.subscribeStatesAsync('control.*');
            }
        }
        this.serialPortPath = String(this.config.USBDevice || '').trim();
        if (!this.serialPortPath || this.serialPortPath === '/dev/xxx') {
            this.log.error('Configure a valid VE.Direct serial port before starting the adapter');
            return;
        }

        this.com.onValidFrame = () => {
            this.lastFrameTime = Date.now();
            void this.safeSetConnectionState(true);
            void this.ensureHexBootstrap();
        };
        this.com.onFrame = frame => this.acceptFrame(frame);
        this.com.onError = error => this.logThrottled('VE.Direct serial error: ', error);
        if (this.unloaded) {
            return;
        }
        void this.watchDog();
        this.watchDogInterval = setInterval(() => void this.watchDog(), WATCHDOG_INTERVAL_MS);
    }

    async initConnectionObject() {
        /** @type {ioBroker.StateCommon} */
        const common = {
            name: 'Fresh checksum-valid VE.Direct frame received',
            type: 'boolean',
            role: 'indicator.connected',
            read: true,
            write: false,
            def: false,
        };
        await this.setObjectNotExistsAsync('info.connection', { type: 'state', common, native: {} });
        if (this.unloaded) {
            return;
        }
        await this.extendObjectAsync('info.connection', { common });
    }

    async initControlObjects() {
        await this.setObjectNotExistsAsync('control', {
            type: 'channel',
            common: { name: 'Optional validated VE.Direct HEX access' },
            native: {},
        });
        /** @type {Array<[string, string, ioBroker.StateCommon['type'], string, boolean, string]>} */
        const states = [
            ['control.capabilities', 'VE.Direct capability bits', 'number', 'value', false, ''],
            ['control.externalControlSupported', 'External control capability', 'boolean', 'indicator', false, ''],
            ['control.chargerOn', 'Charger soft on/off switch', 'boolean', 'switch', this.chargerControlEnabled, ''],
            ['control.deviceState', 'Raw device operating state', 'number', 'value', false, ''],
            ['control.remoteControlUsed', 'Remote control bit mask', 'number', 'value', false, ''],
            ['control.networkMode', 'Decoded network mode', 'string', 'text', false, ''],
            [
                'control.maximumBatteryCurrent',
                'Persistent maximum battery current',
                'number',
                'value.current',
                false,
                'A',
            ],
            [
                'control.chargeCurrentLimit',
                'Dynamically verified charge current limit',
                'number',
                'level.current',
                this.currentLimitControlEnabled,
                'A',
            ],
            [
                'control.currentLimitActive',
                'Adapter current-limit supervisor active',
                'boolean',
                'switch',
                this.currentLimitControlEnabled,
                '',
            ],
            [
                'control.chargeVoltageSetpoint',
                'Remote charge voltage setpoint (read-only)',
                'number',
                'value.voltage',
                false,
                'V',
            ],
            ['control.lastError', 'Last validated HEX access error', 'string', 'text', false, ''],
        ];
        for (const [id, name, type, role, write, unit] of states) {
            /** @type {ioBroker.StateCommon} */
            const common = { name, type, role, read: true, write, unit };
            if (id === 'control.chargeCurrentLimit') {
                common.min = 0;
                if (this.currentLimitControlEnabled) {
                    common.max = this.currentLimitMax;
                }
            }
            await this.setObjectNotExistsAsync(id, { type: 'state', common, native: {} });
            if (this.unloaded) {
                return;
            }
            await this.extendObjectAsync(id, { common });
        }
    }

    ensureHexBootstrap() {
        if (!this.hexClient || this.unloaded || !this.isFresh()) {
            return Promise.resolve();
        }
        const generation = this.connectionGeneration;
        if (
            this.hexBootstrappedGeneration === generation ||
            this.hexBootstrapPromise ||
            Date.now() < this.nextHexBootstrapAt
        ) {
            return this.hexBootstrapPromise || Promise.resolve();
        }
        const operation = this.refreshHexState(generation)
            .then(() => {
                this.hexBootstrappedGeneration = generation;
            })
            .catch(error => {
                this.nextHexBootstrapAt = Date.now() + 30000;
                if (!this.unloaded) {
                    this.logThrottled('VE.Direct HEX bootstrap failed: ', error);
                }
            });
        this.hexBootstrapPromise = operation;
        const clear = () => {
            if (this.hexBootstrapPromise === operation) {
                this.hexBootstrapPromise = undefined;
            }
        };
        void operation.then(clear, clear);
        return operation;
    }

    async refreshHexState(generation = this.connectionGeneration) {
        if (!this.hexClient || generation !== this.connectionGeneration) {
            return;
        }
        const fields = [
            ['capabilities', 'control.capabilities'],
            ['deviceMode', 'control.chargerOn'],
            ['deviceState', 'control.deviceState'],
            ['remoteControlUsed', 'control.remoteControlUsed'],
            ['networkMode', 'control.networkMode'],
            ['maxBatteryCurrent', 'control.maximumBatteryCurrent'],
            ['chargeCurrentLimit', 'control.chargeCurrentLimit'],
            ['chargeVoltageSetpoint', 'control.chargeVoltageSetpoint'],
        ];
        const errors = [];
        for (const [name, stateId] of fields) {
            if (this.unloaded || generation !== this.connectionGeneration) {
                return;
            }
            try {
                const value = await this.hexClient.getField(name);
                if (this.unloaded || generation !== this.connectionGeneration) {
                    return;
                }
                await this.writeState(stateId, value);
                if (name === 'capabilities') {
                    if (typeof value !== 'number') {
                        throw new TypeError('Capabilities response is not numeric');
                    }
                    this.externalControlSupported = hasCapability(value, CAPABILITY_BITS.externalControl);
                    await this.writeState('control.externalControlSupported', this.externalControlSupported);
                }
            } catch (error) {
                errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
                this.logThrottled(`Could not read VE.Direct HEX register ${name}: `, error);
            }
        }
        if (!this.unloaded && generation === this.connectionGeneration) {
            await this.writeState('control.lastError', errors.join('; '));
        }
    }

    nonNegativeConfig(value, name) {
        if (value == null || value === '') {
            return 0;
        }
        const number = Number(value);
        if (!Number.isFinite(number) || number < 0) {
            throw new Error(`${name} must be a finite non-negative number`);
        }
        return number;
    }

    isFresh() {
        return this.lastFrameTime > 0 && Date.now() - this.lastFrameTime < DATA_TIMEOUT_MS;
    }

    watchDog() {
        if (this.activeWatchDog) {
            return this.activeWatchDog;
        }
        const operation = this.performWatchDog();
        this.activeWatchDog = operation;
        const clear = () => {
            if (this.activeWatchDog === operation) {
                this.activeWatchDog = undefined;
            }
        };
        void operation.then(clear, clear);
        return operation;
    }

    async performWatchDog() {
        if (this.unloaded || !this.serialPortPath) {
            return;
        }
        if (this.isFresh() && this.com.isOpen()) {
            return;
        }
        await this.safeSetConnectionState(false);
        if (this.unloaded || (this.isFresh() && this.com.isOpen())) {
            return;
        }
        const now = Date.now();
        if (now - this.lastOpenAttempt < RECONNECT_COOLDOWN_MS) {
            return;
        }
        this.lastOpenAttempt = now;
        try {
            if (this.com.isOpen()) {
                await this.com.close();
                if (this.unloaded) {
                    return;
                }
            }
            if (this.unloaded) {
                return;
            }
            await this.com.open(this.serialPortPath);
        } catch (error) {
            if (!this.unloaded) {
                this.logThrottled('Could not open/reopen VE.Direct port: ', error);
                await this.safeSetConnectionState(false);
            }
        }
    }

    acceptFrame(frame) {
        if (this.unloaded) {
            return;
        }
        const snapshot = { ...frame };
        if (this.samplingSeconds === 0) {
            this.enqueueFrame(snapshot);
            return;
        }
        this.pendingSample = { ...(this.pendingSample || {}), ...snapshot };
        if (this.sampleTimer) {
            return;
        }
        this.sampleTimer = setTimeout(() => {
            this.sampleTimer = undefined;
            const pending = this.pendingSample;
            this.pendingSample = null;
            if (pending && !this.unloaded) {
                this.enqueueFrame(pending);
            }
        }, this.samplingSeconds * 1000);
    }

    enqueueFrame(frame) {
        if (this.unloaded) {
            return;
        }
        const previous = this.pendingFrameBatch;
        this.pendingFrameBatch = {
            values: { ...((previous && previous.values) || {}), ...frame },
            generation: this.connectionGeneration,
            receivedAt: Date.now(),
        };
        this.startFrameDrain();
    }

    startFrameDrain() {
        if (this.frameDrainActive || this.unloaded) {
            return;
        }
        this.frameDrainActive = true;
        const operation = this.drainFrames();
        this.frameQueue = operation;
        const clear = () => {
            this.frameDrainActive = false;
            if (this.pendingFrameBatch && !this.unloaded) {
                this.startFrameDrain();
            }
        };
        void operation.then(clear, clear);
    }

    async drainFrames() {
        while (this.pendingFrameBatch && !this.unloaded) {
            const batch = this.pendingFrameBatch;
            this.pendingFrameBatch = null;
            try {
                await this.publishFrame(batch.values, batch.generation, batch.receivedAt);
            } catch (error) {
                this.logThrottled('Could not process VE.Direct frame: ', error);
            }
        }
    }

    clearPendingSample() {
        if (this.sampleTimer) {
            clearTimeout(this.sampleTimer);
            this.sampleTimer = undefined;
        }
        this.pendingSample = null;
    }

    canPublishFrame(generation, receivedAt) {
        return (
            !this.unloaded &&
            this.connectionRequested !== false &&
            generation === this.connectionGeneration &&
            Date.now() - receivedAt < DATA_TIMEOUT_MS
        );
    }

    async publishFrame(frame, generation = this.connectionGeneration, receivedAt = Date.now()) {
        if (!this.canPublishFrame(generation, receivedAt)) {
            return;
        }
        for (const [key, value] of Object.entries(frame)) {
            if (!this.canPublishFrame(generation, receivedAt)) {
                return;
            }
            const field = VE_DIRECT_FIELDS[key];
            if (!field) {
                continue;
            }
            try {
                await this.ensureStateObject(field);
                if (!this.canPublishFrame(generation, receivedAt)) {
                    return;
                }
                await this.writeState(key, value, field);
            } catch (error) {
                this.logThrottled(`Could not publish ${key}: `, error);
            }
        }
    }

    ensureStateObject(field) {
        const existing = this.objectPromises.get(field.id);
        if (existing) {
            return existing;
        }
        const operation = (async () => {
            /** @type {ioBroker.StateCommon} */
            const common = {
                name: field.label,
                type: field.type,
                role: field.role,
                read: true,
                write: false,
                unit: field.unit,
                desc: field.descr,
            };
            await this.setObjectNotExistsAsync(field.id, { type: 'state', common, native: {} });
            if (this.unloaded) {
                return;
            }
            await this.extendObjectAsync(field.id, { common });
        })();
        this.objectPromises.set(field.id, operation);
        void operation.catch(() => this.objectPromises.delete(field.id));
        return operation;
    }

    writeState(key, value, field) {
        const previous = this.stateQueues.get(key) || Promise.resolve();
        const result = previous
            .catch(() => undefined)
            .then(async () => {
                if (field && this.expireSeconds > 0 && field.expire) {
                    await this.setStateAsync(key, { val: value, ack: true, expire: this.expireSeconds });
                } else if (field) {
                    await this.setStateChangedAsync(key, { val: value, ack: true });
                } else {
                    await this.setStateAsync(key, { val: value, ack: true });
                }
            })
            .then(() => undefined);
        const tracked = result.then(
            () => undefined,
            () => undefined,
        );
        this.stateQueues.set(key, tracked);
        void tracked.then(() => {
            if (this.stateQueues.get(key) === tracked) {
                this.stateQueues.delete(key);
            }
        });
        return result;
    }

    async performStateChange(id, state) {
        const prefix = `${this.namespace}.control.`;
        if (typeof id !== 'string' || !id.startsWith(prefix) || !state || state.ack !== false || state.val == null) {
            return;
        }
        if (this.unloaded || !this.hexClient) {
            return;
        }
        const localId = id.slice(this.namespace.length + 1);
        try {
            if (!this.isFresh() || this.connectionRequested === false) {
                throw new Error('VE.Direct control requires an open connection with fresh valid TEXT data');
            }
            if (localId === 'control.chargerOn') {
                if (!this.chargerControlEnabled || typeof state.val !== 'boolean') {
                    throw new Error('Charger control is disabled or requires a strict boolean value');
                }
                const actual = await this.hexClient.setField('deviceMode', state.val);
                if (this.unloaded) {
                    throw new Error('VE.Direct adapter is unloading');
                }
                await this.writeState('control.chargerOn', actual);
                await this.writeState('control.lastError', '');
                return;
            }
            if (localId === 'control.chargeCurrentLimit') {
                if (!this.currentLimitControlEnabled) {
                    throw new Error('Current limit control is disabled');
                }
                const value = this.validateCurrentLimit(state.val);
                await this.queueCurrentLimitOperation(() => this.applyCurrentLimit(value));
                return;
            }
            if (localId === 'control.currentLimitActive') {
                if (!this.currentLimitControlEnabled || typeof state.val !== 'boolean') {
                    throw new Error('Current limit supervisor control is disabled or requires a boolean');
                }
                if (state.val) {
                    if (this.desiredCurrentLimit === undefined) {
                        throw new Error('Set a verified charge current limit before activating the supervisor');
                    }
                    await this.queueCurrentLimitOperation(() => this.applyCurrentLimit(this.desiredCurrentLimit));
                } else {
                    await this.queueCurrentLimitOperation(() => this.stopCurrentLimit());
                }
            }
        } catch (error) {
            if (!this.unloaded) {
                await this.writeState('control.lastError', error instanceof Error ? error.message : String(error));
            }
            throw error;
        }
    }

    validateCurrentLimit(value) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > this.currentLimitMax) {
            throw new RangeError(
                `Charge current limit must be a finite number in the range 0..${this.currentLimitMax} A`,
            );
        }
        encodeRaw('chargeCurrentLimit', value);
        return value;
    }

    async ensureExternalControlCapability() {
        if (this.externalControlSupported === undefined) {
            if (!this.hexClient) {
                throw new Error('HEX client is not available');
            }
            const capabilities = await this.hexClient.getField('capabilities');
            if (this.unloaded) {
                throw new Error('VE.Direct adapter is unloading');
            }
            if (typeof capabilities !== 'number') {
                throw new TypeError('Capabilities response is not numeric');
            }
            this.externalControlSupported = hasCapability(capabilities, CAPABILITY_BITS.externalControl);
            await this.writeState('control.capabilities', capabilities);
            await this.writeState('control.externalControlSupported', this.externalControlSupported);
        }
        if (!this.externalControlSupported) {
            throw new Error('The connected device does not advertise external-control support');
        }
    }

    queueCurrentLimitOperation(operation) {
        if (this.currentLimitOperation) {
            return Promise.reject(new Error('Another VE.Direct current-limit operation is still pending'));
        }
        const result = Promise.resolve().then(operation);
        this.currentLimitOperation = result;
        const clear = () => {
            if (this.currentLimitOperation === result) {
                this.currentLimitOperation = undefined;
            }
        };
        void result.then(clear, clear);
        return result;
    }

    async applyCurrentLimit(value, restartTimer = true) {
        this.validateCurrentLimit(value);
        if (!this.hexClient) {
            throw new Error('HEX client is not available');
        }
        const client = this.hexClient;
        await this.ensureExternalControlCapability();
        if (this.unloaded) {
            throw new Error('VE.Direct adapter is unloading');
        }
        const mode = await client.setField('networkMode', NETWORK_MODES.external);
        if (this.unloaded) {
            throw new Error('VE.Direct adapter is unloading');
        }
        if (mode !== 'external') {
            throw new Error(`Network mode readback is ${String(mode)}, expected external`);
        }
        await this.writeState('control.networkMode', mode);
        if (this.unloaded) {
            throw new Error('VE.Direct adapter is unloading');
        }
        const actual = await client.setField('chargeCurrentLimit', value);
        if (this.unloaded) {
            throw new Error('VE.Direct adapter is unloading');
        }
        if (typeof actual !== 'number' || actual !== value) {
            throw new Error(`Charge current readback ${actual} A differs from requested ${value} A`);
        }
        await this.writeState('control.chargeCurrentLimit', actual);
        this.desiredCurrentLimit = actual;
        this.currentLimitActive = true;
        if (restartTimer) {
            this.startCurrentLimitSupervisor();
        }
        await this.writeState('control.currentLimitActive', true);
        await this.writeState('control.lastError', '');
    }

    startCurrentLimitSupervisor() {
        if (this.currentLimitTimer) {
            clearInterval(this.currentLimitTimer);
        }
        this.currentLimitTimer = setInterval(
            () => void this.runCurrentLimitSupervisor(),
            this.currentLimitRefreshSeconds * 1000,
        );
    }

    async runCurrentLimitSupervisor() {
        if (
            this.supervisorRunning ||
            !this.currentLimitActive ||
            this.desiredCurrentLimit === undefined ||
            this.unloaded
        ) {
            return;
        }
        this.supervisorRunning = true;
        const desiredCurrentLimit = this.desiredCurrentLimit;
        try {
            if (!this.isFresh() || !this.hexClient) {
                return;
            }
            await this.queueCurrentLimitOperation(() => this.applyCurrentLimit(desiredCurrentLimit, false));
        } catch (error) {
            if (!this.unloaded) {
                await this.writeState('control.lastError', error instanceof Error ? error.message : String(error));
                this.logThrottled('Could not refresh VE.Direct charge current limit: ', error);
            }
        } finally {
            this.supervisorRunning = false;
        }
    }

    async stopCurrentLimit() {
        if (this.currentLimitTimer) {
            clearInterval(this.currentLimitTimer);
            this.currentLimitTimer = undefined;
        }
        this.currentLimitActive = false;
        if (this.unloaded) {
            return;
        }
        let failure;
        try {
            if (!this.hexClient) {
                throw new Error('HEX client is not available');
            }
            const mode = await this.hexClient.setField('networkMode', NETWORK_MODES.standalone);
            if (mode !== 'standalone') {
                throw new Error(`Network mode readback is ${String(mode)}, expected standalone`);
            }
            await this.writeState('control.networkMode', mode);
            await this.writeState('control.lastError', '');
        } catch (error) {
            failure = error;
            await this.writeState('control.lastError', error instanceof Error ? error.message : String(error));
        }
        await this.writeState('control.currentLimitActive', false);
        if (failure) {
            throw failure;
        }
    }

    async safeSetConnectionState(connected) {
        if (!connected) {
            this.clearPendingSample();
            this.pendingFrameBatch = null;
            this.hexBootstrappedGeneration = -1;
            this.externalControlSupported = undefined;
            if (this.hexClient) {
                this.hexClient.cancel(new Error('VE.Direct connection lost'));
            }
            if (this.connectionRequested !== false) {
                this.connectionGeneration++;
            }
        }
        if (this.connectionRequested === connected) {
            return;
        }
        this.connectionRequested = connected;
        try {
            await this.writeState('info.connection', connected);
            this.connectionState = connected;
        } catch (error) {
            if (this.connectionRequested === connected) {
                this.connectionRequested = undefined;
            }
            this.logThrottled('Could not update info.connection: ', error);
        }
    }

    logThrottled(prefix, error) {
        const text = this.errorText(error);
        const key = `${prefix}\u0000${text}`;
        const now = Date.now();
        const previous = this.errorLogTimes.get(key);
        if (previous !== undefined && now - previous < ERROR_LOG_COOLDOWN_MS) {
            return;
        }
        this.errorLogTimes.set(key, now);
        this.log.error(`${prefix}${text}`);
    }

    onUnload(callback) {
        if (this.unloadPromise) {
            void this.unloadPromise.then(callback, callback);
            return;
        }
        this.unloaded = true;
        if (this.watchDogInterval) {
            clearInterval(this.watchDogInterval);
            this.watchDogInterval = undefined;
        }
        this.clearPendingSample();
        this.pendingFrameBatch = null;
        if (this.currentLimitTimer) {
            clearInterval(this.currentLimitTimer);
            this.currentLimitTimer = undefined;
        }
        this.currentLimitActive = false;
        if (this.hexClient) {
            this.hexClient.cancel(new Error('VE.Direct adapter is unloading'));
        }
        this.com.onFrame = undefined;
        this.com.onValidFrame = undefined;
        this.com.onHexMessage = undefined;
        this.com.onPortClosed = undefined;
        const operation = this.performUnload(this.activeWatchDog, this.readyPromise);
        this.unloadPromise = operation;
        let unloadCallbackInvoked = false;
        const finish = error => {
            if (unloadCallbackInvoked) {
                return;
            }
            unloadCallbackInvoked = true;
            if (error) {
                this.log.error(`Error during VE.Direct unload: ${this.errorText(error)}`);
            }
            callback();
        };
        void operation.then(() => finish(), finish);
    }

    async performUnload(pendingWatchDog, pendingReady) {
        const deadline = Date.now() + this.unloadTimeoutMs;
        const pending = [
            this.com.close().catch(error => this.log.error(`Error closing VE.Direct port: ${this.errorText(error)}`)),
        ];
        if (pendingWatchDog) {
            pending.push(pendingWatchDog.catch(() => undefined));
        }
        if (pendingReady) {
            pending.push(pendingReady.catch(() => undefined));
        }
        if (this.hexBootstrapPromise) {
            pending.push(this.hexBootstrapPromise.catch(() => undefined));
        }
        if (this.currentLimitOperation) {
            pending.push(this.currentLimitOperation.catch(() => undefined));
        }
        await this.settleWithin(Promise.all(pending), deadline);
        await this.settleWithin(this.writeState('control.currentLimitActive', false), deadline);
        await this.settleWithin(this.safeSetConnectionState(false), deadline);
        await this.settleWithin(Promise.all([...this.stateQueues.values(), this.frameQueue]), deadline);
    }

    settleWithin(promise, deadline) {
        const remaining = Math.max(0, deadline - Date.now());
        /** @type {Promise<void>} */
        const settled = new Promise(resolve => {
            const timer = setTimeout(resolve, remaining);
            promise.then(
                () => {
                    clearTimeout(timer);
                    resolve();
                },
                () => {
                    clearTimeout(timer);
                    resolve();
                },
            );
        });
        return settled;
    }

    errorText(error) {
        return error instanceof Error ? error.stack || error.message : String(error);
    }
}

// @ts-expect-error module.parent exists in the CommonJS runtime.
if (module.parent) {
    module.exports = options => new Vedirect(options);
    module.exports.Vedirect = Vedirect;
} else {
    new Vedirect();
}
