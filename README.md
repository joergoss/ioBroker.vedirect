![Logo](admin/vedirect.png)

# ioBroker.vedirect

[![Test and Release](https://github.com/joergoss/ioBroker.vedirect/actions/workflows/test-and-release.yml/badge.svg)](https://github.com/joergoss/ioBroker.vedirect/actions/workflows/test-and-release.yml)

By default, this is a read-only ioBroker adapter for Victron devices with a serial VE.Direct interface. It optionally supports strictly validated HEX reads and individually enabled SmartSolar control functions. This repository is a fork of [DrozmotiX/ioBroker.vedirect](https://github.com/DrozmotiX/ioBroker.vedirect) and includes fundamental protocol and lifecycle hardening.

A German version of this documentation is available in [README.de.md](README.de.md).

This adapter uses Sentry libraries to automatically report exceptions and code errors to the developers. For more details and for information on how to disable error reporting, see the [Sentry plugin documentation](https://github.com/ioBroker/plugin-sentry#plugin-sentry). Sentry reporting is used starting with js-controller 3.0.

## Features

- Byte-oriented, atomic parser according to **VE.Direct Protocol 3.34** and the official FAQ.
- Modulo-256 checksum with publication only after a valid, complete block.
- Coverage of all 256 binary checksum bytes, arbitrary serial chunk boundaries, and multiple blocks.
- Controlled handling of asynchronous HEX messages and resynchronization.
- Strict numeric validation; no silent partial `parseFloat` values, no `NaN`, and no invented zeroes.
- Instance-scoped SerialPort 12 lifecycle with open/set/close timeouts, reconnect, and late-callback protection.
- Optional direct raw TCP connections to serial servers without Telnet/RFC2217 encapsulation or additional runtime dependencies.
- Admin 5 `jsonConfig` UI with conditional serial/TCP fields, native save validation, and real-browser persistence tests.
- PTY/socat endpoints without a modem-control ioctl are accepted; other set errors remain fatal open errors.
- `info.connection` is based exclusively on fresh, valid blocks.
- Object migration before state writes and handled promise errors.
- Frame sampling without losing individual protocol fields.
- Multiple instances without global ports, parsers, timers, or buffers.
- Optional HEX read access with revision 18 checksums, exact response matching, and a fixed register whitelist.
- Optional charger on/off and dynamic charge-current control with read-after-write, safety limits, and an instance-scoped refresh supervisor.

## Supported devices and scope

The field registry covers the BMV, MPPT, Phoenix, and Orion fields included in the previous adapter, including SmartSolar, SmartShunt, and VE.Direct Phoenix data. Actual field availability depends on the product and firmware.

The adapter remains **read-only** by default. HEX reads and control functions are individually disabled in the default configuration. There is no generic raw-register, BMS/slave, voltage, persistent battery-setting, or load/relay control. Details and safety limits are documented in [docs/hex-control.md](docs/hex-control.md).

Official references:

- [VE.Direct Protocol 3.34](https://www.victronenergy.com/upload/documents/VE.Direct-Protocol-3.34.pdf)
- [VE.Direct Protocol FAQ](https://www.victronenergy.com/live/vedirect_protocol:faq)

For real-world operation of two SmartSolar MPPTs, including a state overview and possible future HEX write options, see [docs/two-mppt.md](docs/two-mppt.md).

## Configuration

### Serial interface

Enter the device path, for example `/dev/ttyUSB0` or a stable `/dev/serial/by-id/...` path. The adapter uses **19200 baud, 8N1**. No other process may use the same port when the adapter starts.

### Raw TCP serial server

Enable `byTCPIP` only for a direct, unmodified TCP byte stream from a serial server. Enter its hostname or IP address in `tcpHost` and its port in `tcpPort`; no local serial-device path is required in this mode. The serial bridge itself must still be configured for **19200 baud, 8N1**.

Raw TCP is unencrypted and unauthenticated. Use it only on a trusted network or through a separately secured tunnel, and never expose it unprotected to the internet. Telnet/RFC2217 negotiation, TLS, WebSockets, HTTP, and MQTT are not supported. The serial server and its single-client connection must not be shared with another adapter process or serial monitor.

TCP uses the same checksum-valid parser, freshness checks, bounded lifecycle, reconnect handling, and optional HEX transaction rules as a local serial connection. See [docs/raw-tcp.md](docs/raw-tcp.md) for configuration, security, and validation limits. A read-only endpoint diagnostic is available as `node tools/raw-tcp-probe.js <host> <port> [seconds]`; it reports real frame evidence and verifies that no bytes were written.

### State expiration (`expireTime`)

- `0`: No TTL; unchanged values use the actual changed-state optimization.
- Greater than `0`: The TTL of measurement fields marked as volatile is renewed with valid frames.
- Static identification and status fields may have no TTL, depending on the field definition.

When sampling is enabled, the expiration time should be significantly longer than the sampling interval.

### Frame sampling (`messageBuffer`)

The existing configuration name is retained for compatibility, but its behavior has been corrected:

- `0`: Every valid block is processed.
- Greater than `0`: Serial data is still parsed completely. For state publication, complete blocks are merged over the interval. The latest value of each field is then written.
- Sampling does not throttle liveness detection or reconnects.
- After a detected connection loss, an unpublished sample buffer is discarded. A new buffer starts after reconnecting so that values are never mixed across connection boundaries.
- Individual lines and history blocks are no longer discarded.

### Optional HEX access

All HEX functions are disabled by default. `hexReadEnabled` permits only a fixed whitelist of register queries. `chargerControlEnabled` and `currentLimitControlEnabled` separately enable their respective `control.*` states.

Current control additionally requires `currentLimitMax` as an adapter-side safety cap. It renews external-control mode and the current limit every `currentLimitRefreshSeconds` (5–50 seconds) with read-after-write. A communication loss is **not a fail-safe shutdown**: the device can return to stand-alone operation and its persistent maximum-current setting.

See [docs/hex-control.md](docs/hex-control.md) for states, transaction semantics, and the read-only diagnostic tool.

## Connection and error behavior

- `info.connection=true`: A checksum-valid block was received within the last ten seconds.
- `info.connection=false`: No fresh valid block, an open/serial error, or adapter shutdown.
- When data stops or the connection drops, the port is closed in a controlled manner and reopened after a cooldown.
- Invalid checksums and malformed known values do not change measurement states.
- After a detected connection loss, no buffered values are acknowledged and no TTL is renewed.
- Repeated identical serial errors are rate-limited in the log.
- During unload, `info.connection=false` is acknowledged before completion. Unload completion is time-bounded so that a hanging serial or database operation cannot block adapter shutdown.

## Special values and decoding

| Input                      | Behavior                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `---`                      | `null`; no `NaN` or pseudo-zero value                                             |
| `TTG=-1`                   | `TTG=null`, plus `TTGInfinite=true`                                               |
| Normal TTG                 | Remains minutes to preserve the existing state API                                 |
| `FW` / `FWE`               | Strings; leading zeroes and release/beta identifiers are preserved                 |
| `AR` / `WARN` / `OR`       | All set bits are decoded together; unknown remaining bits stay visible            |
| `Alarm` / `Relay` / `LOAD` | Case-insensitive, canonical `ON`/`OFF` strings without changing the existing type |
| Unknown field              | No state; known values from the same valid block are retained                     |

## Migration and compatibility

Existing state IDs are generally retained. Object definitions are updated when the corresponding field is first received successfully; custom settings such as History or InfluxDB configuration are preserved.

Important corrections compared with 0.1.2/0.3.x:

- `PPV`, `H21`, `H23`, `HSDS`, and other numeric fields are reliably written as numbers.
- After the existing conversion, `H15`/`H16` correctly use the unit `V` instead of `mV`.
- Energy counters use `kWh` and energy roles.
- `FW`/`FWE` are migrated to strings to preserve their protocol semantics.
- `TTGInfinite` is a new synthetic state.
- Values already stored in history are not changed retroactively.

## Development and tests

Requirements: Node.js 22 or newer, js-controller >=6.0.11, and Admin >=7.6.20.

```bash
npm ci
npm run test:all
```

`test:all` includes the functional suite, package checks, `checkJs`, ESLint, and js-controller integration. The CI matrix uses Node.js 22/24/26 on Linux, Windows, and macOS.

`npm run test:admin` validates the real Admin 5 configuration in Chrome with Admin 7.6.20 and js-controller 6.0.11, including conditional fields, validation, saving, reloading, and hidden native persistence. See [docs/admin-jsonconfig.md](docs/admin-jsonconfig.md).

Tests include the exact official FAQ frame, all chunk boundaries and checksum bytes, HEX/multiblock/recovery behavior, real SmartSolar and BMV vectors, serial errors and hanging native callbacks, state/TTL/sampling behavior, and separate instances.

The complete audit is documented in [docs/audit-2026-11-17.md](docs/audit-2026-11-17.md). A quantitative comparison of sampling, TTL, CPU, and Redis state writes is available in [docs/performance-2026-11-18.md](docs/performance-2026-11-18.md).

## Dependency audit

The production dependency audit has no findings. The development toolchain audit still reports a transitive `picomatch` ReDoS issue through `tinyglobby`/TypeScript-ESLint, for which no corrected compatible release chain was available at the time of testing. It affects only development globbing with potentially malicious patterns, not adapter operation or VE.Direct processing.

## Changelog

### **WORK IN PROGRESS**

- (joerg) Add a read-only raw TCP diagnostic CLI with structured frame evidence, bounded runtime, and zero-byte-write verification (#8).
- (joerg) Migrate the configuration to Admin 5 `jsonConfig` with conditional fields, complete translations, schema/validator tests, and real-browser save/reload E2E (#9).

### 0.6.0 (2026-11-19)

- (joerg) Add opt-in raw TCP serial-server transport with strict host/port validation, real socket integration tests, and the existing parser, reconnect, and HEX safety semantics.

### 0.5.1 (2026-11-18)

- (joerg) Changed Dependabot auto-merge to the safe `pull_request` trigger; updated `@iobroker/testing` to 6.3.2 and adapter-core to 3.4.3.
- (joerg) Support virtual serial endpoints without a modem-control ioctl (`ENOTTY`); other set errors remain fatal.
- (joerg) Add a Pi 4 benchmark for sampling, TTL, CPU, and Redis state writes.
- (joerg) Provide an English main README, retain the German documentation separately, and complete the admin translations.

### 0.5.0 (2026-11-18)

- (joerg) Optional HEX read client with official revision 18 fixtures, strict register/response validation, and read-only hardware probes.
- (joerg) Optional charger on/off and dynamic charge-current control with read-after-write, capability gating, and bounded queues.
- (joerg) Instance-scoped current-limit supervisor, session invalidation without blind retries, and extensive fake-serial and two-instance tests.

### 0.4.0 (2026-11-18)

- (joerg) Atomic VE.Direct 3.34 parser with checksum, HEX, multiblock, and recovery tests (#1).
- (joerg) Corrected field scaling, sentinels, bit fields, firmware types, roles, and metadata (#1).
- (joerg) Instance-scoped SerialPort 12 lifecycle, reconnect, safe state queues, and unload (#2).
- (joerg) Corrected frame sampling, expiration/changed behavior, and multiple-instance operation (#2).
- (joerg) Replaced the dummy test with real protocol, lifecycle, and adapter tests; expanded CI and documentation (#3).
- (joerg) Require Node.js 22+, expand CI to Node.js 22/24/26, and modernize release tooling.

### 0.3.3 (2024-09-10)

- (DutchmanNL) Repository checker compliance updates.
- (DutchmanNL) Update dependencies for Node.js 18+ compatibility.

### 0.3.1 (2023-10-29)

- (DutchmanNL) Message buffer implemented; replaced by lossless frame sampling in this fork.

### 0.3.0 (2023-08-07)

- (DutchmanNL/Andiling) Protocol 3.33 and bug fixes.

### 0.2.0 (2023-08-06)

- (DutchmanNL/Andiling) Protocol 3.32, product names, and configurable state expiration.

### 0.1.2 and older

- Original releases by DutchmanNL/Andiling; see the upstream history.

## License

[MIT License](LICENSE)

Copyright (c) 2023-2026 DutchmanNL <rdrozda@hotmail.com>
