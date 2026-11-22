'use strict';

const net = require('node:net');
const { performance } = require('node:perf_hooks');
const utils = require('@iobroker/adapter-core');
const { VeDirectCom } = require('./lib/veDirectCom');
const { normalizeTcpTarget } = require('./lib/veDirectTcpPort');
const { VE_DIRECT_FIELDS } = require('./lib/veDirect/fields');
const { DIAGNOSTIC_FRAME_PUBLISH_MS, DIAGNOSTIC_STATES } = require('./lib/veDirect/diagnostics');
const { CAPABILITY_BITS, NETWORK_MODES, encodeRaw, hasCapability } = require('./lib/veDirect/hexFields');

const WATCHDOG_INTERVAL_MS = 1000;
const DATA_TIMEOUT_MS = 10000;
const RECONNECT_COOLDOWN_MS = 5000;
const ERROR_LOG_COOLDOWN_MS = 60000;
const UNLOAD_DRAIN_TIMEOUT_MS = 5000;
const SAFE_MASKED_TRANSPORT_ERROR_PATTERNS = [
    /^(?:DNS|open|route|connect|read|write|drain|close|timeout) <target> failed$/,
    /^(?:DNS|open|route|connect|read|write|drain|close|timeout) <address> failed$/,
    /^<url>$/,
];
const SAFE_TRANSPORT_ERROR_MESSAGES = new Set([
    'Serial port closed unexpectedly',
    'Serial port closed while opening',
    'Serial port session changed or closed while writing',
    'Serial port is not ready for writing',
    'Serial open cancelled by close request',
    'TCP socket closed before the connection opened',
    'TCP connection closed before the connection opened',
    'TCP port is not open for writing',
    'TCP port is not open for draining',
    'VE.Direct connection lost',
    'VE.Direct adapter is unloading',
    'VE.Direct serial port closed',
    'no such device',
    'offline',
    'remote close',
]);

class Vedirect extends utils.Adapter {
    constructor(options = {}) {
        super({ ...options, name: 'vedirect' });
        this.com = new VeDirectCom();
        this.serialPortPath = '';
        this.connectionTarget = undefined;
        this.expireSeconds = 0;
        this.samplingSeconds = 0;
        this.lastFrameTime = 0;
        this.lastFrameMonotonic = 0;
        this.lastOpenAttemptMonotonic = 0;
        this.lastValidFrameAt = 0;
        this.lastValidFramePublishedAt = 0;
        this.lastValidFrameOperationSequence = 0;
        this.lastValidFramePublishOperation = 0;
        this.successfulOpenCount = 0;
        this.reconnectCount = 0;
        this.transportType = '';
        this.lastTransportError = '';
        this.diagnosticValues = new Map();
        this.diagnosticPublishedValues = new Map();
        this.diagnosticEntries = new Map();
        this.diagnosticDrains = new Map();
        this.diagnosticOperationSequence = 0;
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
        this.transportType = this.config.byTCPIP === true ? 'tcp' : 'serial';
        await this.initializeDiagnostics();
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
        this.currentLimitMax = this.currentLimitControlEnabled
            ? this.nonNegativeConfig(this.config.currentLimitMax, 'currentLimitMax')
            : 0;
        this.currentLimitRefreshSeconds = this.currentLimitControlEnabled
            ? this.nonNegativeConfig(
                  this.config.currentLimitRefreshSeconds === undefined ? 20 : this.config.currentLimitRefreshSeconds,
                  'currentLimitRefreshSeconds',
              )
            : 20;
        if (this.currentLimitControlEnabled && this.currentLimitMax <= 0) {
            throw new Error('currentLimitMax must be greater than 0 when current limit control is enabled');
        }
        if (
            this.currentLimitControlEnabled &&
            (!Number.isInteger(this.currentLimitRefreshSeconds) ||
                this.currentLimitRefreshSeconds < 5 ||
                this.currentLimitRefreshSeconds > 50)
        ) {
            throw new Error(
                'currentLimitRefreshSeconds must be an integer between 5 and 50 when current limit control is enabled',
            );
        }
        if (this.currentLimitMax > 0) {
            encodeRaw('chargeCurrentLimit', this.currentLimitMax);
        }
        await this.initControlObjects();
        if (this.unloaded) {
            return;
        }
        await this.writeState('control.currentLimitActive', false);
        if (this.unloaded) {
            return;
        }
        if (this.hexReadEnabled) {
            const { VeDirectHexClient } = require('./lib/veDirectHexClient');
            this.hexClient = new VeDirectHexClient(this.com);
            this.hexClient.onError = error => {
                this.logThrottled('VE.Direct HEX client close error: ', error);
                if (!this.unloaded) {
                    void this.safeSetConnectionState(false);
                }
            };
            if (this.chargerControlEnabled || this.currentLimitControlEnabled) {
                await this.subscribeStatesAsync('control.*');
            }
        }
        if (this.unloaded) {
            return;
        }
        if (!this.configureConnectionTarget()) {
            this.log.error('Configure a valid VE.Direct serial port before starting the adapter');
            return;
        }
        if (this.unloaded) {
            return;
        }

        this.com.onValidFrame = () => {
            if (this.unloaded) {
                return;
            }
            this.lastFrameTime = Date.now();
            this.lastFrameMonotonic = this.monotonicNow();
            this.lastValidFrameAt = this.lastFrameTime;
            void this.publishLastValidFrame();
            void this.safeSetConnectionState(true);
            void this.ensureHexBootstrap();
        };
        this.com.onFrame = frame => this.acceptFrame(frame);
        this.com.onError = error => {
            void this.recordTransportError(error);
            this.logThrottled('VE.Direct connection error: ', error);
        };
        this.com.onParserError = counters => {
            void this.recordParserError(counters);
        };
        const previousPortClosed = this.com.onPortClosed;
        this.com.onPortClosed = error => {
            void this.recordTransportError(error);
            if (previousPortClosed) {
                try {
                    previousPortClosed(error);
                } catch (callbackError) {
                    this.logThrottled('VE.Direct HEX close handler failed: ', callbackError);
                }
            }
            void this.safeSetConnectionState(false).catch(stateError => {
                if (!this.unloaded) {
                    this.logThrottled('VE.Direct disconnect handling failed: ', stateError);
                }
            });
        };
        if (this.unloaded) {
            return;
        }
        void this.watchDog();
        this.watchDogInterval = setInterval(() => void this.watchDog(), WATCHDOG_INTERVAL_MS);
    }

    configureConnectionTarget() {
        if (this.config.byTCPIP === true) {
            this.transportType = 'tcp';
            this.serialPortPath = '';
            this.connectionTarget = normalizeTcpTarget({
                host: this.config.tcpHost,
                port: this.config.tcpPort,
            });
            return this.connectionTarget;
        }
        this.transportType = 'serial';
        this.serialPortPath = String(this.config.USBDevice || '').trim();
        this.connectionTarget =
            this.serialPortPath && this.serialPortPath !== '/dev/xxx' ? this.serialPortPath : undefined;
        return this.connectionTarget;
    }

    async initializeDiagnostics() {
        this.lastValidFrameAt = 0;
        this.lastValidFramePublishedAt = 0;
        this.lastValidFrameOperationSequence = 0;
        this.lastValidFramePublishOperation = 0;
        this.successfulOpenCount = 0;
        this.reconnectCount = 0;
        this.lastTransportError = '';
        this.diagnosticValues.clear();
        this.diagnosticPublishedValues.clear();
        this.diagnosticEntries.clear();
        this.diagnosticDrains.clear();
        const values = [
            ['info.transport', this.transportType],
            ['info.lastValidFrameAt', this.lastValidFrameAt],
            ['info.reconnectCount', this.reconnectCount],
            ['info.checksumErrors', 0],
            ['info.parserErrors', 0],
            ['info.lastTransportError', this.lastTransportError],
        ];
        for (const [id, value] of values) {
            await this.writeDiagnosticState(id, value, true);
        }
    }

    writeDiagnosticState(id, value, force = false) {
        let entry = this.diagnosticEntries.get(id);
        if (!entry) {
            entry = { latest: undefined, version: 0, dirty: false, force: false, drain: undefined };
            this.diagnosticEntries.set(id, entry);
        }
        if (!force && entry.latest === value && (entry.dirty || this.diagnosticPublishedValues.get(id) === value)) {
            return entry.drain || Promise.resolve(true);
        }
        entry.latest = value;
        entry.version = ++this.diagnosticOperationSequence;
        entry.dirty = true;
        entry.force = force;
        this.diagnosticValues.set(id, value);
        if (!entry.drain) {
            const operation = this.drainDiagnosticState(id, entry);
            entry.drain = operation;
            this.diagnosticDrains.set(id, operation);
            void operation.then(() => {
                if (this.diagnosticDrains.get(id) === operation) {
                    this.diagnosticDrains.delete(id);
                }
                if (entry.drain === operation) {
                    entry.drain = undefined;
                }
            });
        }
        return entry.drain;
    }

    async drainDiagnosticState(id, entry) {
        let latestSucceeded = true;
        while (entry.dirty) {
            const version = entry.version;
            const value = entry.latest;
            const force = entry.force;
            let succeeded;
            try {
                await this.writeState(id, value, force ? undefined : {});
                succeeded = true;
                this.diagnosticPublishedValues.set(id, value);
            } catch (error) {
                succeeded = false;
                if (!this.unloaded) {
                    this.logThrottled(`Could not publish ${id}: `, error);
                }
            }
            if (entry.version === version) {
                entry.dirty = false;
                entry.force = false;
                latestSucceeded = succeeded;
                if (!succeeded) {
                    this.diagnosticValues.delete(id);
                }
            }
        }
        entry.drain = undefined;
        return latestSucceeded;
    }

    drainDiagnostics() {
        return Promise.all([...this.diagnosticDrains.values()]).then(() => undefined);
    }

    publishLastValidFrame(force = false) {
        const timestamp = this.lastValidFrameAt;
        const actualPublished = this.diagnosticPublishedValues.get('info.lastValidFrameAt');
        const lastPublished = Math.max(
            this.lastValidFramePublishedAt,
            typeof actualPublished === 'number' ? actualPublished : 0,
        );
        if (timestamp === 0 || timestamp <= lastPublished) {
            return Promise.resolve();
        }
        if (!force && timestamp - lastPublished < DIAGNOSTIC_FRAME_PUBLISH_MS) {
            return Promise.resolve();
        }
        if (this.lastValidFramePublishOperation !== 0) {
            // Reuse the one existing completion observer. Only the latest value
            // is queued; no additional Promise observer is created per frame.
            void this.writeDiagnosticState('info.lastValidFrameAt', timestamp);
            return this.diagnosticDrains.get('info.lastValidFrameAt') || Promise.resolve();
        }
        const operation = ++this.lastValidFrameOperationSequence;
        this.lastValidFramePublishOperation = operation;
        return this.writeDiagnosticState('info.lastValidFrameAt', timestamp).then(success => {
            if (this.lastValidFramePublishOperation === operation) {
                this.lastValidFramePublishOperation = 0;
                if (success) {
                    const published = this.diagnosticPublishedValues.get('info.lastValidFrameAt');
                    if (typeof published === 'number') {
                        this.lastValidFramePublishedAt = Math.max(this.lastValidFramePublishedAt, published);
                    }
                }
            }
        });
    }

    recordTransportOpen() {
        if (this.unloaded) {
            return;
        }
        this.successfulOpenCount++;
        if (this.successfulOpenCount > 1) {
            this.reconnectCount = this.successfulOpenCount - 1;
            void this.writeDiagnosticState('info.reconnectCount', this.reconnectCount);
        }
    }

    recordTransportError(error) {
        if (this.unloaded) {
            return Promise.resolve();
        }
        const text = this.sanitizeTransportError(error);
        if (!text) {
            return Promise.resolve();
        }
        this.lastTransportError = text;
        return this.writeDiagnosticState('info.lastTransportError', text);
    }

    sanitizeTransportError(error) {
        if (!error) {
            return '';
        }
        const code = /** @type {NodeJS.ErrnoException} */ (error).code;
        if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(code)) {
            return code;
        }
        let text = error instanceof Error ? error.message : String(error);
        let masked = false;
        const replace = (pattern, replacement) => {
            const next = text.replace(pattern, replacement);
            if (next !== text) {
                masked = true;
                text = next;
            }
        };
        replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>');
        for (const target of [this.serialPortPath, this.config.USBDevice, this.config.tcpHost]) {
            if (typeof target !== 'string' || target.trim().length === 0) {
                continue;
            }
            const isHostname = target === this.config.tcpHost;
            const normalized = isHostname ? target.trim().replace(/\.+$/, '') : target.trim();
            if (!normalized) {
                continue;
            }
            const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            replace(new RegExp(`${escaped}${isHostname ? '\\.?' : ''}`, 'gi'), '<target>');
        }
        text = text.replace(/\[([0-9a-f:.]+(?:%[a-z0-9]+)?)\](?::\d{1,5})?/gi, (candidate, scoped) => {
            if (net.isIP(scoped.split('%')[0]) === 6) {
                masked = true;
                return '<address>';
            }
            return candidate;
        });
        text = text.replace(/(?:[0-9a-f]{0,4}:){2,}[0-9a-f:.]*(?:%[a-z0-9]+)?/gi, candidate => {
            if (net.isIP(candidate.split('%')[0]) === 6) {
                masked = true;
                return '<address>';
            }
            return candidate;
        });
        text = text.replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g, candidate => {
            if (net.isIP(candidate.replace(/:\d{1,5}$/, '')) === 4) {
                masked = true;
                return '<address>';
            }
            return candidate;
        });
        // Publish a fallback message only when masking actually removed a target
        // and the complete result matches a strict safe template, or when the
        // complete static message is positively known to contain no target.
        if (
            SAFE_TRANSPORT_ERROR_MESSAGES.has(text) ||
            (masked && SAFE_MASKED_TRANSPORT_ERROR_PATTERNS.some(pattern => pattern.test(text)))
        ) {
            return text.slice(0, 512);
        }
        return error instanceof Error && error.name ? error.name : 'Error';
    }

    recordParserError(counters) {
        // Both writes reuse their existing drain. Do not create Promise.all()
        // observers for every parser event while a database write is pending.
        void this.writeDiagnosticState('info.checksumErrors', counters.checksumErrors);
        void this.writeDiagnosticState('info.parserErrors', counters.invalidFrames + counters.invalidHexMessages);
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
        for (const definition of DIAGNOSTIC_STATES) {
            const { id, ...metadata } = definition;
            const diagnosticCommon = { ...metadata, read: true, write: false };
            await this.setObjectNotExistsAsync(id, { type: 'state', common: diagnosticCommon, native: {} });
            if (this.unloaded) {
                return;
            }
            await this.extendObjectAsync(id, { common: diagnosticCommon });
        }
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
                if (this.unloaded || generation !== this.connectionGeneration) {
                    return;
                }
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

    monotonicNow() {
        return performance.now();
    }

    isFresh() {
        const age = this.monotonicNow() - this.lastFrameMonotonic;
        return this.lastFrameTime > 0 && this.lastFrameMonotonic > 0 && age >= 0 && age < DATA_TIMEOUT_MS;
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
        if (this.unloaded || !this.connectionTarget) {
            return;
        }
        if (this.isFresh() && this.com.isOpen() && this.connectionRequested !== false) {
            return;
        }
        await this.safeSetConnectionState(false, false);
        if (this.unloaded || (this.isFresh() && this.com.isOpen() && this.connectionRequested !== false)) {
            return;
        }
        const now = this.monotonicNow();
        const cooldownAge = now - this.lastOpenAttemptMonotonic;
        if (
            this.lastOpenAttempt > 0 &&
            this.lastOpenAttemptMonotonic > 0 &&
            cooldownAge >= 0 &&
            cooldownAge < RECONNECT_COOLDOWN_MS
        ) {
            return;
        }
        this.lastOpenAttempt = Date.now();
        this.lastOpenAttemptMonotonic = now;
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
            await this.com.open(this.connectionTarget);
            this.recordTransportOpen();
        } catch (error) {
            if (!this.unloaded) {
                void this.recordTransportError(error);
                this.logThrottled('Could not open/reopen VE.Direct connection: ', error);
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
            monotonicReceivedAt: this.monotonicNow(),
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
                await this.publishFrame(batch.values, batch.generation, batch.receivedAt, batch.monotonicReceivedAt);
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

    canPublishFrame(generation, receivedAt, monotonicReceivedAt = this.monotonicNow()) {
        const wallAge = Date.now() - receivedAt;
        const monotonicAge = this.monotonicNow() - monotonicReceivedAt;
        return (
            !this.unloaded &&
            this.connectionRequested !== false &&
            generation === this.connectionGeneration &&
            wallAge >= 0 &&
            wallAge < DATA_TIMEOUT_MS &&
            monotonicAge >= 0 &&
            monotonicAge < DATA_TIMEOUT_MS
        );
    }

    async publishFrame(
        frame,
        generation = this.connectionGeneration,
        receivedAt = Date.now(),
        monotonicReceivedAt = this.monotonicNow(),
    ) {
        if (!this.canPublishFrame(generation, receivedAt, monotonicReceivedAt)) {
            return;
        }
        for (const [key, value] of Object.entries(frame)) {
            if (!this.canPublishFrame(generation, receivedAt, monotonicReceivedAt)) {
                return;
            }
            const field = VE_DIRECT_FIELDS[key];
            if (!field) {
                continue;
            }
            try {
                await this.ensureStateObject(field);
                if (!this.canPublishFrame(generation, receivedAt, monotonicReceivedAt)) {
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
        const generation = this.connectionGeneration;
        try {
            this.assertControlSession(generation);
            if (localId === 'control.chargerOn') {
                if (!this.chargerControlEnabled || typeof state.val !== 'boolean') {
                    throw new Error('Charger control is disabled or requires a strict boolean value');
                }
                const actual = await this.hexClient.setField('deviceMode', state.val);
                this.assertControlSession(generation);
                await this.writeState('control.chargerOn', actual);
                this.assertControlSession(generation);
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

    assertControlSession(generation) {
        if (this.unloaded) {
            throw new Error('VE.Direct adapter is unloading');
        }
        if (
            generation !== this.connectionGeneration ||
            this.connectionRequested === false ||
            !this.isFresh() ||
            !this.com.isOpen()
        ) {
            throw new Error('VE.Direct control requires fresh valid TEXT data and an unchanged open session');
        }
    }

    async ensureExternalControlCapability(generation = this.connectionGeneration) {
        this.assertControlSession(generation);
        if (this.externalControlSupported === undefined) {
            if (!this.hexClient) {
                throw new Error('HEX client is not available');
            }
            const capabilities = await this.hexClient.getField('capabilities');
            this.assertControlSession(generation);
            if (typeof capabilities !== 'number') {
                throw new TypeError('Capabilities response is not numeric');
            }
            this.externalControlSupported = hasCapability(capabilities, CAPABILITY_BITS.externalControl);
            await this.writeState('control.capabilities', capabilities);
            this.assertControlSession(generation);
            await this.writeState('control.externalControlSupported', this.externalControlSupported);
            this.assertControlSession(generation);
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
        const generation = this.connectionGeneration;
        this.assertControlSession(generation);
        const client = this.hexClient;
        await this.ensureExternalControlCapability(generation);
        this.assertControlSession(generation);
        // Establish and verify the actual limit before enabling external control.
        // A failed limit therefore never leaves the device externally controlled;
        // no ambiguous rollback write is needed or attempted.
        const actual = await client.setField('chargeCurrentLimit', value);
        this.assertControlSession(generation);
        if (typeof actual !== 'number' || actual !== value) {
            throw new Error(`Charge current readback ${actual} A differs from requested ${value} A`);
        }
        await this.writeState('control.chargeCurrentLimit', actual);
        this.assertControlSession(generation);
        const mode = await client.setField('networkMode', NETWORK_MODES.external);
        this.assertControlSession(generation);
        if (mode !== 'external') {
            throw new Error(`Network mode readback is ${String(mode)}, expected external`);
        }
        await this.writeState('control.networkMode', mode);
        this.assertControlSession(generation);
        this.desiredCurrentLimit = actual;
        this.currentLimitActive = true;
        if (restartTimer) {
            this.startCurrentLimitSupervisor();
        }
        await this.writeState('control.currentLimitActive', true);
        this.assertControlSession(generation);
        await this.writeState('control.lastError', '');
    }

    startCurrentLimitSupervisor() {
        if (this.unloaded || !this.currentLimitActive) {
            return;
        }
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
        const generation = this.connectionGeneration;
        let failure;
        try {
            if (!this.hexClient) {
                throw new Error('HEX client is not available');
            }
            this.assertControlSession(generation);
            const mode = await this.hexClient.setField('networkMode', NETWORK_MODES.standalone);
            this.assertControlSession(generation);
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

    async safeSetConnectionState(connected, awaitStateWrite = true) {
        if (!connected) {
            this.clearPendingSample();
            this.pendingFrameBatch = null;
            const supervisorWasActive = this.currentLimitActive || this.currentLimitTimer !== undefined;
            if (this.currentLimitTimer) {
                clearInterval(this.currentLimitTimer);
                this.currentLimitTimer = undefined;
            }
            this.currentLimitActive = false;
            this.desiredCurrentLimit = undefined;
            this.hexBootstrappedGeneration = -1;
            this.externalControlSupported = undefined;
            if (this.hexClient) {
                this.hexClient.cancel(new Error('VE.Direct connection lost'));
            }
            if (supervisorWasActive) {
                const supervisorWrite = this.writeState('control.currentLimitActive', false);
                if (awaitStateWrite) {
                    await supervisorWrite;
                } else {
                    void supervisorWrite.catch(error => {
                        this.logThrottled('Could not deactivate current-limit supervisor: ', error);
                    });
                }
            }
            if (this.connectionRequested !== false) {
                this.connectionGeneration++;
            }
        }
        if (this.connectionRequested === connected) {
            if (!connected) {
                void this.publishLastValidFrame(true);
            }
            return;
        }
        this.connectionRequested = connected;
        const onError = error => {
            if (this.connectionRequested === connected) {
                this.connectionRequested = undefined;
            }
            this.logThrottled('Could not update info.connection: ', error);
        };
        try {
            const connectionWrite = this.writeState('info.connection', connected);
            if (!connected) {
                this.connectionState = false;
                void this.publishLastValidFrame(true);
            }
            if (!awaitStateWrite) {
                void connectionWrite.then(() => {
                    if (this.connectionRequested === connected) {
                        this.connectionState = connected;
                    }
                }, onError);
                return;
            }
            await connectionWrite;
            if (this.connectionRequested === connected) {
                this.connectionState = connected;
            }
        } catch (error) {
            onError(error);
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
        this.com.onParserError = undefined;
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
        await this.settleWithin(this.drainDiagnostics(), deadline);
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
