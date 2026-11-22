'use strict';

const { decodeVeDirectField } = require('./fields.js');

const COLON = 0x3a;
const LF = 0x0a;
const CR = 0x0d;
const TAB = 0x09;
const MAX_FRAME_BYTES = 8192;
const MAX_LINE_BYTES = 128;
const MAX_HEX_FRAME_BYTES = 256;
const CHECKSUM_LABEL = Buffer.from('Checksum\t', 'ascii');
const HEX_COMMAND_BYTES = new Set([0x31, 0x33, 0x34, 0x35, 0x37, 0x38, 0x41]);

/**
 * Atomic, byte-oriented VE.Direct TEXT parser following the official FAQ
 * state priorities. A checksum byte is never interpreted as HEX. An
 * asynchronous HEX message discards an interrupted TEXT block; the next
 * complete block resynchronizes the parser.
 */
class VeDirectParser {
    constructor() {
        /** @type {((frame: Record<string, any>) => void)|undefined} */
        this.onFrame = undefined;
        /** @type {(() => void)|undefined} */
        this.onValidFrame = undefined;
        /** @type {((counters: {checksumErrors: number, invalidFrames: number, invalidHexMessages: number}) => void)|undefined} */
        this.onFrameError = undefined;
        /** @type {((frame: Buffer) => void)|undefined} */
        this.onHexMessage = undefined;
        /** @type {'idle'|'text'|'checksum'|'hex'|'orphanColon'|'discard'} */
        this.state = 'idle';
        /** @type {number[]} */
        this.line = [];
        /** @type {Record<string, any>} */
        this.records = {};
        this.checksum = 0;
        this.frameBytes = 0;
        this.malformed = false;
        this.overflow = false;
        this.idleSawCR = false;
        this.idleHadGarbage = false;
        this.candidateFromGarbage = false;
        /** @type {number|undefined} */
        this.hexInterruptedTextChecksum = undefined;
        this.hexInterruptedTextLabelBytes = 0;
        this.hexOverflow = false;
        this.discardIndex = 0;
        this.discardAwaitChecksum = false;
        this.discardAfterHex = false;
        /** @type {number|undefined} */
        this.discardAfterHexChecksum = undefined;
        this.discardSawCR = false;
        /** @type {number|undefined} */
        this.previousTextByte = undefined;
        this.checksumErrors = 0;
        this.invalidFrames = 0;
        this.unknownFields = 0;
        this.invalidValues = 0;
        this.hexMessages = 0;
        this.invalidHexMessages = 0;
        this.hexOverflow = false;
        this.reset();
    }

    receive(data) {
        for (const byte of data) {
            if (this.state === 'discard') {
                this.receiveDiscardByte(byte);
                continue;
            }
            if (this.state === 'orphanColon') {
                if (HEX_COMMAND_BYTES.has(byte)) {
                    this.enterHex();
                    this.receiveHexByte(byte);
                } else {
                    this.state = 'idle';
                    if (byte === COLON) {
                        this.enterHex();
                    } else {
                        this.receiveIdleByte(byte);
                    }
                }
                continue;
            }
            if (this.state === 'hex') {
                this.receiveHexByte(byte);
                continue;
            }

            // The official reference gives CHECKSUM precedence over colon/HEX.
            if (byte === COLON && this.state !== 'checksum') {
                if (this.state === 'idle') {
                    // An orphan checksum colon and a real HEX start are only
                    // distinguishable by the following byte.
                    this.state = 'orphanColon';
                    this.idleHadGarbage = false;
                    continue;
                }
                if (
                    this.state === 'text' &&
                    this.candidateFromGarbage &&
                    this.line.length === 0 &&
                    Object.keys(this.records).length === 0
                ) {
                    // A checksum colon can be followed by the remainder of an
                    // ambiguous HEX message. Discard that orphan instead of
                    // swallowing the next block.
                    this.state = 'orphanColon';
                    this.candidateFromGarbage = false;
                    this.idleHadGarbage = false;
                    continue;
                }
                this.enterHex();
                continue;
            }

            switch (this.state) {
                case 'idle':
                    this.receiveIdleByte(byte);
                    break;
                case 'text':
                    this.receiveTextByte(byte);
                    break;
                case 'checksum':
                    this.addToChecksum(byte);
                    this.completeFrame();
                    break;
            }
        }
    }

    enterHex() {
        this.hexInterruptedTextChecksum = this.state === 'text' && this.frameBytes > 0 ? this.checksum : undefined;
        this.hexInterruptedTextLabelBytes = 0;
        if (this.state === 'text') {
            const interruptedLine = Buffer.from(this.line);
            if (
                interruptedLine.length <= CHECKSUM_LABEL.length &&
                interruptedLine.equals(CHECKSUM_LABEL.subarray(0, interruptedLine.length))
            ) {
                this.hexInterruptedTextLabelBytes = interruptedLine.length;
            }
        }
        this.state = 'hex';
        this.line = [COLON];
        this.hexOverflow = false;
        this.records = {};
        this.checksum = 0;
        this.frameBytes = 0;
        this.malformed = false;
        this.overflow = false;
        this.idleSawCR = false;
        this.idleHadGarbage = false;
        this.candidateFromGarbage = false;
    }

    receiveHexByte(byte) {
        if (this.line.length < MAX_HEX_FRAME_BYTES) {
            this.line.push(byte);
        } else {
            this.hexOverflow = true;
        }
        if (byte === LF) {
            this.completeHexMessage();
        }
    }

    completeHexMessage() {
        const raw = Buffer.from(this.line);
        const interruptedChecksum = this.hexInterruptedTextChecksum;
        const interruptedLabelBytes = this.hexInterruptedTextLabelBytes;
        const overflow = this.hexOverflow;
        this.hexInterruptedTextChecksum = undefined;
        this.hexInterruptedTextLabelBytes = 0;
        this.hexOverflow = false;
        this.idleSawCR = false;
        this.line = [];
        if (interruptedChecksum !== undefined) {
            this.enterDiscard(false, true, interruptedChecksum, interruptedLabelBytes);
        } else {
            this.state = 'idle';
        }
        if (overflow) {
            this.invalidHexMessages++;
            this.reportFrameError();
            return;
        }
        this.hexMessages++;
        if (this.onHexMessage) {
            this.onHexMessage(raw);
        }
    }

    /**
     * @param {boolean} [countInvalid] Count the interrupted block as invalid.
     * @param {boolean} [afterHex] Allow an immediate post-HEX candidate.
     * @param {number} [interruptedChecksum] Checksum of the interrupted TEXT prefix.
     * @param {number} [interruptedLabelBytes] Already received prefix length of Checksum\t.
     */
    enterDiscard(countInvalid = true, afterHex = false, interruptedChecksum = undefined, interruptedLabelBytes = 0) {
        if (countInvalid && !this.overflow) {
            this.invalidFrames++;
            this.reportFrameError();
        }
        this.state = 'discard';
        this.line = [];
        this.records = {};
        this.checksum = 0;
        this.frameBytes = 0;
        this.malformed = false;
        this.overflow = false;
        this.idleSawCR = false;
        this.idleHadGarbage = false;
        this.candidateFromGarbage = false;
        this.discardIndex = interruptedLabelBytes;
        this.discardAwaitChecksum = interruptedLabelBytes === CHECKSUM_LABEL.length;
        this.discardAfterHex = afterHex;
        this.discardAfterHexChecksum = interruptedChecksum;
        this.discardSawCR = false;
    }

    receiveDiscardByte(byte) {
        if (this.discardAwaitChecksum) {
            this.reset();
            return;
        }
        if (this.discardAfterHex) {
            if (this.discardSawCR) {
                const interruptedChecksum = this.discardAfterHexChecksum;
                this.discardAfterHex = false;
                this.discardAfterHexChecksum = undefined;
                this.discardSawCR = false;
                if (byte === LF) {
                    // Only an immediate CRLF can start a fresh candidate. If the
                    // interrupted prefix summed to zero, an old valid remainder
                    // is checksum-identical to a fresh block and must stay
                    // discarded. Other prefixes make an old remainder fail its
                    // checksum; later line endings never restart a block.
                    if (interruptedChecksum !== 0) {
                        this.startFrame(true);
                    }
                    return;
                }
            } else if (byte === CR) {
                this.discardSawCR = true;
                return;
            } else {
                this.discardAfterHex = false;
                this.discardAfterHexChecksum = undefined;
            }
        }
        if (byte === CHECKSUM_LABEL[this.discardIndex]) {
            this.discardIndex++;
            if (this.discardIndex === CHECKSUM_LABEL.length) {
                this.discardAwaitChecksum = true;
            }
        } else {
            this.discardIndex = byte === CHECKSUM_LABEL[0] ? 1 : 0;
        }
    }

    reset() {
        this.state = 'idle';
        this.checksum = 0;
        this.frameBytes = 0;
        this.line = [];
        this.records = {};
        this.malformed = false;
        this.overflow = false;
        this.idleSawCR = false;
        this.idleHadGarbage = false;
        this.candidateFromGarbage = false;
        this.hexInterruptedTextChecksum = undefined;
        this.hexInterruptedTextLabelBytes = 0;
        this.hexOverflow = false;
        this.discardIndex = 0;
        this.discardAwaitChecksum = false;
        this.discardAfterHex = false;
        this.discardAfterHexChecksum = undefined;
        this.discardSawCR = false;
        this.previousTextByte = undefined;
    }

    receiveIdleByte(byte) {
        if (byte === CR) {
            this.idleSawCR = true;
            return;
        }
        if (byte === LF) {
            const fromGarbage = this.idleHadGarbage;
            this.startFrame(this.idleSawCR);
            this.candidateFromGarbage = fromGarbage;
            this.idleHadGarbage = false;
            return;
        }
        this.idleSawCR = false;
        this.idleHadGarbage = true;
    }

    startFrame(withCR) {
        this.state = 'text';
        this.checksum = withCR ? (CR + LF) & 0xff : LF;
        this.frameBytes = withCR ? 2 : 1;
        this.line = [];
        this.records = {};
        this.malformed = false;
        this.overflow = false;
        this.idleSawCR = false;
        this.idleHadGarbage = false;
        this.candidateFromGarbage = false;
        this.previousTextByte = undefined;
    }

    receiveTextByte(byte) {
        this.addToChecksum(byte);
        if (this.frameBytes > MAX_FRAME_BYTES) {
            this.markOverflow();
        }
        if (!this.overflow && this.line.length < MAX_LINE_BYTES) {
            this.line.push(byte);
        } else {
            this.markOverflow();
        }

        if (byte === LF) {
            let content = this.line.slice(0, -1);
            if (content[content.length - 1] === CR) {
                content = content.slice(0, -1);
            }
            const orphanBinaryByte = content.length === 1 && content[0] > 0x7f;
            const emptyLine = this.line.every(lineByte => lineByte === LF || lineByte === CR);
            const validStructure = this.finishLine();
            this.line = [];
            if (emptyLine && !this.malformed && !this.overflow && Object.keys(this.records).length === 0) {
                // A redundant leading line ending can be the frame prefix after
                // an orphan LF. Never use this to rehabilitate invalid values.
                this.startFrame(this.previousTextByte === CR);
                return;
            }
            if (
                orphanBinaryByte &&
                this.candidateFromGarbage &&
                !this.malformed &&
                !this.overflow &&
                Object.keys(this.records).length === 0
            ) {
                this.startFrame(this.previousTextByte === CR);
                return;
            }
            if (!validStructure) {
                this.enterDiscard();
                return;
            }
            this.previousTextByte = byte;
            return;
        }

        this.previousTextByte = byte;
        if (Buffer.from(this.line).equals(CHECKSUM_LABEL)) {
            this.state = 'checksum';
        }
    }

    addToChecksum(byte) {
        this.checksum = (this.checksum + byte) & 0xff;
        this.frameBytes++;
    }

    markOverflow() {
        if (!this.overflow) {
            this.invalidFrames++;
            this.reportFrameError();
        }
        this.overflow = true;
    }

    finishLine() {
        if (this.overflow) {
            return false;
        }
        let line = this.line;
        if (line[line.length - 1] === LF) {
            line = line.slice(0, -1);
        }
        if (line[line.length - 1] === CR) {
            line = line.slice(0, -1);
        }
        if (line.length === 0) {
            return false;
        }
        const tab = line.indexOf(TAB);
        if (tab <= 0) {
            return false;
        }
        if (line.some(byte => byte > 0x7f)) {
            // TEXT labels/values are ASCII. Do not let Node clear high bits and
            // accidentally turn a non-ASCII byte into a valid digit or label.
            this.invalidValues++;
            this.malformed = true;
            return true;
        }
        const label = Buffer.from(line.slice(0, tab)).toString('ascii');
        const value = Buffer.from(line.slice(tab + 1)).toString('ascii');
        try {
            const decoded = decodeVeDirectField(label, value);
            if (decoded === null) {
                this.unknownFields++;
            } else {
                Object.assign(this.records, decoded);
            }
        } catch {
            this.invalidValues++;
            this.malformed = true;
        }
        return true;
    }

    /** Publish cumulative counters after a real parser rejection event. */
    reportFrameError() {
        if (this.onFrameError) {
            this.onFrameError({
                checksumErrors: this.checksumErrors,
                invalidFrames: this.invalidFrames,
                invalidHexMessages: this.invalidHexMessages,
            });
        }
    }

    completeFrame() {
        try {
            if (this.checksum !== 0) {
                this.checksumErrors++;
                this.reportFrameError();
            } else if (this.malformed || this.overflow) {
                this.invalidFrames++;
                this.reportFrameError();
            } else {
                if (this.onValidFrame) {
                    this.onValidFrame();
                }
                if (Object.keys(this.records).length > 0 && this.onFrame) {
                    // Publish a snapshot only after the complete frame passed
                    // checksum and value validation.
                    this.onFrame({ ...this.records });
                }
            }
        } finally {
            // Callback failures must never leave a partially received frame in
            // the parser. Deliberately keep diagnostic counters cumulative.
            this.reset();
        }
    }
}

module.exports = { VeDirectParser };
