#!/usr/bin/env python3
"""Two independent VE.Direct MPPTs on real POSIX PTY master endpoints.

The Node test suite owns this process and speaks newline-delimited JSON on
stdin/stdout. PTY bytes never share those stdio streams. Every response has
{"type":"result", "id":..., "ok":...}; asynchronous diagnostics have
"type":"event". Supported operations are:

  state                         register bytes and decoded request history
  configure                     one-shot behavior for the next device request
  text                          send one independently checksummed TEXT frame
  disconnect / reconnect        destroy and recreate one complete PTY pair
  shutdown                      close every PTY and exit

A configure command takes device ("a"/"b") and behavior:
  mode: normal, hang, general_error, unknown, register_error, bad_checksum
  delayMs: response delay local to this device's worker thread
  flags: register error flags for register_error (default: parameter error)
  chunks / chunkDelayMs: deterministic write fragmentation for TEXT and HEX
  prefixText: optional {voltageMv, currentMa} frame sent before the HEX reply
  responseValueHex: optional Set acknowledgement value without changing RAM

The HEX implementation below is deliberately independent of the JavaScript
implementation. It uses its own ASCII nibble conversion and checksum codec and
checks an official, fixed protocol vector before opening any PTY.
"""

import json
import os
import select
import sys
import threading
import time
import tty


HEX_DIGITS = "0123456789ABCDEF"
REGISTER_WIDTHS = {
    0x0140: 4,  # capabilities
    0x0200: 1,  # device mode
    0x0201: 1,  # device state
    0x0202: 4,  # remote control used
    0x200E: 1,  # network mode
    0x2015: 2,  # charge current limit, 0.1 A
    0xEDF0: 2,  # maximum battery current, 0.1 A
    0x2001: 2,  # charge voltage setpoint, 0.01 V
}
WRITABLE = {0x0200, 0x200E, 0x2015}

_output_lock = threading.Lock()


def emit(message):
    with _output_lock:
        sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def event(name, **fields):
    emit({"type": "event", "name": name, **fields})


def encode_hex(command, payload=b""):
    """Encode :<one command nibble><payload bytes><checksum> LF."""
    if not isinstance(command, int) or command < 0 or command > 0x0F:
        raise ValueError("HEX command is not a nibble")
    checksum = (0x55 - command - sum(payload)) & 0xFF
    characters = [":", HEX_DIGITS[command]]
    for value in bytes(payload) + bytes([checksum]):
        characters.extend((HEX_DIGITS[value >> 4], HEX_DIGITS[value & 0x0F]))
    characters.append("\n")
    return "".join(characters).encode("ascii")


def hex_nibble(value):
    if 0x30 <= value <= 0x39:
        return value - 0x30
    if 0x41 <= value <= 0x46:
        return value - 0x41 + 10
    raise ValueError("only uppercase ASCII hex is valid")


def decode_hex(frame):
    """Decode and validate exactly one complete HEX frame."""
    if len(frame) < 5 or frame[0] != 0x3A or frame[-1] != 0x0A:
        raise ValueError("invalid HEX framing")
    body = frame[1:-1]
    if len(body) < 3 or (len(body) - 1) % 2:
        raise ValueError("invalid HEX body length")
    command = hex_nibble(body[0])
    decoded = bytearray()
    for offset in range(1, len(body), 2):
        decoded.append((hex_nibble(body[offset]) << 4) | hex_nibble(body[offset + 1]))
    if (command + sum(decoded)) & 0xFF != 0x55:
        raise ValueError("invalid HEX checksum")
    return command, bytes(decoded[:-1])


def register_response(command, register_id, flags=0, value=b""):
    payload = bytes((register_id & 0xFF, register_id >> 8, flags)) + value
    return encode_hex(command, payload)


def text_frame(voltage_mv, current_ma):
    """Build a VE.Direct TEXT block whose complete byte sum is zero."""
    body = bytearray(b"\r\n")
    body.extend(f"V\t{int(voltage_mv)}\r\nI\t{int(current_ma)}\r\n".encode("ascii"))
    body.extend(b"Checksum\t")
    body.append((-sum(body)) & 0xFF)
    if sum(body) & 0xFF:
        raise AssertionError("internal TEXT checksum error")
    return bytes(body)


def initial_registers(device):
    # Different fixed values make accidental response/register-bank sharing visible.
    charge_limit = 12 if device == "a" else 98
    return {
        0x0140: bytes((0x00, 0x80, 0x00, 0x00)),
        0x0200: bytes((1,)),
        0x0201: bytes((3 if device == "a" else 5,)),
        0x0202: bytes(4),
        0x200E: bytes((0 if device == "a" else 5,)),
        0x2015: charge_limit.to_bytes(2, "little"),
        0xEDF0: (150 if device == "a" else 250).to_bytes(2, "little"),
        0x2001: (1420 if device == "a" else 1480).to_bytes(2, "little"),
    }


def codec_self_test():
    # Victron VE.Direct HEX protocol Rev18, Battery Maximum Current 15.0 A.
    fixture = b":7F0ED009600DB\n"
    encoded = encode_hex(7, bytes((0xF0, 0xED, 0, 0x96, 0)))
    if encoded != fixture:
        raise AssertionError(f"independent HEX encoder mismatch: {encoded!r}")
    command, payload = decode_hex(fixture)
    if command != 7 or payload != bytes((0xF0, 0xED, 0, 0x96, 0)):
        raise AssertionError("independent HEX decoder mismatch")


class Emulator:
    def __init__(self, name, registers=None):
        self.name = name
        self.registers = dict(registers if registers is not None else initial_registers(name))
        self.requests = []
        self.behaviors = []
        self.master_fd, self.slave_fd = os.openpty()
        self.path = os.ttyname(self.slave_fd)
        # os.openpty() starts in the host's default line discipline. Raw mode on
        # the slave prevents canonical buffering/echo before SerialPort configures it.
        tty.setraw(self.slave_fd, when=termios_tcsanow())
        self.running = True
        self.behavior_lock = threading.Lock()
        self.write_lock = threading.Lock()
        self.thread = threading.Thread(target=self.run, name=f"mppt-{name}", daemon=True)
        self.thread.start()
        event("pty", device=name, path=self.path)

    def next_behavior(self):
        with self.behavior_lock:
            if self.behaviors:
                return self.behaviors.pop(0)
        return {
            "mode": "normal",
            "delayMs": 0,
            "flags": 4,
            "chunks": [],
            "chunkDelayMs": 0,
            "prefixText": None,
            "responseValueHex": None,
        }

    def configure(self, behavior):
        allowed = {"normal", "hang", "general_error", "unknown", "register_error", "bad_checksum"}
        mode = behavior.get("mode", "normal")
        if mode not in allowed:
            raise ValueError(f"unknown behavior mode {mode}")
        normalized = {
            "mode": mode,
            "delayMs": min(1000, max(0, int(behavior.get("delayMs", 0)))),
            "flags": min(255, max(0, int(behavior.get("flags", 4)))),
            "chunks": [min(256, max(1, int(v))) for v in behavior.get("chunks", [])][:128],
            "chunkDelayMs": min(50, max(0, int(behavior.get("chunkDelayMs", 0)))),
            "prefixText": behavior.get("prefixText"),
            "responseValueHex": behavior.get("responseValueHex"),
        }
        with self.behavior_lock:
            self.behaviors.append(normalized)
        return normalized

    def send_chunked(self, payload, chunks=None, delay_ms=0):
        chunks = chunks or []
        offset = 0
        index = 0
        with self.write_lock:
            while offset < len(payload):
                size = chunks[index % len(chunks)] if chunks else len(payload) - offset
                end = min(len(payload), offset + size)
                os.write(self.master_fd, payload[offset:end])
                offset = end
                index += 1
                if delay_ms and offset < len(payload):
                    time.sleep(delay_ms / 1000.0)

    def handle_request(self, command, payload):
        if command not in (7, 8) or len(payload) < 3:
            # A valid general Error response for syntactically valid unsupported requests.
            self.send_chunked(encode_hex(4, b"\x02"))
            return
        register_id = payload[0] | (payload[1] << 8)
        supplied_value = payload[3:]
        self.requests.append({
            "command": command,
            "registerId": register_id,
            "valueHex": supplied_value.hex(),
        })
        event(
            "request",
            device=self.name,
            command=command,
            registerId=register_id,
            valueHex=supplied_value.hex(),
        )
        behavior = self.next_behavior()
        if behavior["delayMs"]:
            time.sleep(behavior["delayMs"] / 1000.0)
        if behavior["mode"] == "hang":
            return
        if behavior["mode"] == "general_error":
            reply = encode_hex(4, b"\xAA")
        elif behavior["mode"] == "unknown":
            reply = encode_hex(3, b"\x02\x00")
        elif behavior["mode"] == "register_error":
            reply = register_response(command, register_id, behavior["flags"])
        else:
            if register_id not in REGISTER_WIDTHS:
                reply = register_response(command, register_id, 1)
            elif command == 8 and register_id not in WRITABLE:
                reply = register_response(command, register_id, 2)
            elif command == 8 and len(supplied_value) != REGISTER_WIDTHS[register_id]:
                reply = register_response(command, register_id, 4)
            else:
                value = self.registers[register_id]
                if command == 8:
                    self.registers[register_id] = supplied_value
                    value = supplied_value
                    override = behavior.get("responseValueHex")
                    if override is not None:
                        value = bytes.fromhex(override)
                reply = register_response(command, register_id, 0, value)
        if behavior["mode"] == "bad_checksum":
            # Preserve framing/uppercase hex while making the independent checksum fail.
            reply = reply[:-2] + (b"0" if reply[-2:-1] != b"0" else b"1") + b"\n"
        prefix = behavior.get("prefixText")
        if prefix:
            self.send_chunked(
                text_frame(prefix.get("voltageMv", 13000), prefix.get("currentMa", 1000)),
                behavior["chunks"],
                behavior["chunkDelayMs"],
            )
        self.send_chunked(reply, behavior["chunks"], behavior["chunkDelayMs"])
        event("response", device=self.name, command=command, registerId=register_id, wire=reply.decode("ascii"))

    def run(self):
        receive_buffer = bytearray()
        while self.running:
            try:
                readable, _, _ = select.select([self.master_fd], [], [], 0.05)
                if not readable:
                    continue
                data = os.read(self.master_fd, 4096)
                if not data:
                    return
                receive_buffer.extend(data)
                while True:
                    try:
                        start = receive_buffer.index(0x3A)
                    except ValueError:
                        receive_buffer.clear()
                        break
                    if start:
                        del receive_buffer[:start]
                    try:
                        end = receive_buffer.index(0x0A)
                    except ValueError:
                        break
                    frame = bytes(receive_buffer[: end + 1])
                    del receive_buffer[: end + 1]
                    try:
                        command, payload = decode_hex(frame)
                        self.handle_request(command, payload)
                    except Exception as error:
                        event("emulator_error", device=self.name, message=str(error))
            except (OSError, ValueError) as error:
                if self.running:
                    event("emulator_error", device=self.name, message=str(error))
                return

    def snapshot(self):
        return {
            "path": self.path,
            "registers": {f"{key:04X}": value.hex() for key, value in self.registers.items()},
            "requests": list(self.requests),
        }

    def close(self):
        if not self.running:
            return
        self.running = False
        for fd in (self.master_fd, self.slave_fd):
            try:
                os.close(fd)
            except OSError:
                pass
        if threading.current_thread() is not self.thread:
            self.thread.join(timeout=0.5)


def termios_tcsanow():
    # Importing termios is deliberately local to POSIX after os.openpty succeeded.
    import termios
    return termios.TCSANOW


def main():
    codec_self_test()
    devices = {name: Emulator(name) for name in ("a", "b")}
    emit({"type": "ready", "devices": {name: item.path for name, item in devices.items()}})
    try:
        for line in sys.stdin:
            message = None
            try:
                message = json.loads(line)
                request_id = message.get("id")
                operation = message.get("op")
                name = message.get("device")
                device = devices.get(name) if name else None
                if operation in {"state", "configure", "text", "disconnect", "reconnect"} and device is None:
                    raise ValueError("a valid device ('a' or 'b') is required")
                result = {}
                if operation == "state":
                    result = device.snapshot()
                elif operation == "configure":
                    result = {"behavior": device.configure(message.get("behavior", {}))}
                elif operation == "text":
                    settings = message.get("settings", {})
                    device.send_chunked(
                        text_frame(settings.get("voltageMv", 13000), settings.get("currentMa", 1000)),
                        message.get("chunks", []),
                        min(50, max(0, int(message.get("chunkDelayMs", 0)))),
                    )
                elif operation == "disconnect":
                    device.close()
                elif operation == "reconnect":
                    device.close()
                    devices[name] = Emulator(name, device.registers)
                    result = {"path": devices[name].path}
                elif operation == "shutdown":
                    emit({"type": "result", "id": request_id, "ok": True, "result": {}})
                    break
                else:
                    raise ValueError(f"unknown operation {operation}")
                emit({"type": "result", "id": request_id, "ok": True, "result": result})
            except Exception as error:
                emit({
                    "type": "result",
                    "id": message.get("id") if isinstance(message, dict) else None,
                    "ok": False,
                    "error": str(error),
                })
    finally:
        for device in devices.values():
            device.close()


if __name__ == "__main__":
    # The default SIGTERM/SIGINT behavior terminates the helper and lets the OS
    # reclaim every PTY if the owning Node process disappears.
    main()
