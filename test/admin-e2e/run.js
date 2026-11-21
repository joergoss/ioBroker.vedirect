'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '../..');
const PROFILE_DIR = path.join(ROOT, '.dev-server', 'default');
const ADMIN_PORT = 20426;
const STATES_DB_PORT = 24426;
const OBJECTS_DB_PORT = 26426;
const OWNED_PORTS = [ADMIN_PORT, STATES_DB_PORT, OBJECTS_DB_PORT];
const DEV_SERVER_PROXY_PORT = 8081;
const BASE_URL = process.env.ADMIN_E2E_URL || `http://127.0.0.1:${ADMIN_PORT}`;
const CONFIG_URL = `${BASE_URL}/#tab-instances/config/system.adapter.vedirect.0`;
const START_TIMEOUT_MS = 120000;
let browserLaunch;
let browserCleanup;
let shutdownRequested = false;
let shutdownState;

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function stopBrowser() {
    if (!browserCleanup) {
        browserCleanup = (async () => {
            const browser = await browserLaunch?.catch(() => undefined);
            if (browser) {
                await browser.close();
            }
        })();
    }
    return browserCleanup;
}

function startDevServer() {
    if (process.env.ADMIN_E2E_URL) {
        return { child: null, output: '' };
    }
    if (!fs.existsSync(path.join(PROFILE_DIR, 'node_modules', 'iobroker.js-controller', 'controller.js'))) {
        throw new Error('The isolated dev-server profile is missing. Run npm run test:admin:setup first.');
    }
    const child = spawn(
        process.execPath,
        ['--preserve-symlinks', '--preserve-symlinks-main', 'node_modules/iobroker.js-controller/controller.js'],
        {
            cwd: PROFILE_DIR,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: process.platform !== 'win32',
        },
    );
    const state = { child, output: '', cleanupPromise: undefined };
    for (const stream of [child.stdout, child.stderr]) {
        stream.on('data', data => {
            state.output = `${state.output}${data}`.slice(-30000);
        });
    }
    return state;
}

function processGroupExists(pid) {
    try {
        process.kill(-pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitForGroupExit(pid, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!processGroupExists(pid)) {
            return true;
        }
        await delay(100);
    }
    return !processGroupExists(pid);
}

/**
 * @param {number} pid Live controller root PID whose tree must be terminated.
 * @returns {Promise<void>} Resolves only when taskkill exits successfully.
 */
function killWindowsTree(pid) {
    return new Promise((resolve, reject) => {
        const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
        let finished = false;
        const finish = error => {
            if (finished) {
                return;
            }
            finished = true;
            clearTimeout(timer);
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        };
        const timer = setTimeout(() => {
            killer.kill('SIGKILL');
            finish(new Error(`taskkill timed out for controller PID ${pid}`));
        }, 5000);
        killer.once('error', error => finish(new Error(`Could not start taskkill: ${error.message}`)));
        killer.once('close', (code, signal) => {
            if (code === 0) {
                finish();
            } else {
                finish(new Error(`taskkill failed for controller PID ${pid}: code ${code}, signal ${signal}`));
            }
        });
    });
}

async function stopDevServer(state) {
    if (state.cleanupPromise) {
        return state.cleanupPromise;
    }
    state.cleanupPromise = (async () => {
        const child = state.child;
        if (!child) {
            return;
        }
        if (process.platform === 'win32') {
            // Never target a possibly reused root PID. If the leader already
            // exited, owned endpoint checks below expose surviving descendants.
            if (child.exitCode === null && child.signalCode === null) {
                await killWindowsTree(child.pid);
            }
        } else if (processGroupExists(child.pid)) {
            try {
                process.kill(-child.pid, 'SIGINT');
            } catch {
                // The process group exited between the existence check and SIGINT.
            }
            if (!(await waitForGroupExit(child.pid, 5000))) {
                try {
                    process.kill(-child.pid, 'SIGKILL');
                } catch {
                    // The process group exited before the forced cleanup.
                }
                if (!(await waitForGroupExit(child.pid, 2000))) {
                    throw new Error(`Controller process group ${child.pid} did not exit after SIGKILL`);
                }
            }
        }
        await assertOwnedPortsClosed();
    })();
    return state.cleanupPromise;
}

function assertLoopbackAdminProfile() {
    const objectsPath = path.join(PROFILE_DIR, 'iobroker-data', 'objects.jsonl');
    let admin;
    for (const line of fs.readFileSync(objectsPath, 'utf8').split('\n')) {
        if (!line) {
            continue;
        }
        const entry = JSON.parse(line);
        if (entry.k === 'system.adapter.admin.0') {
            admin = entry.v;
        }
    }
    assert.equal(admin?.native?.bind, '127.0.0.1', 'Admin must bind to loopback only');
    assert.equal(admin?.native?.port, ADMIN_PORT, 'Admin must use the isolated test port');
}

/**
 * @param {number} port TCP port which must have no IPv4 loopback listener.
 * @returns {Promise<void>} Resolves only after ECONNREFUSED.
 */
function assertPortClosed(port) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: '127.0.0.1', port });
        const finish = error => {
            socket.removeAllListeners();
            socket.destroy();
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        };
        socket.setTimeout(1000);
        socket.once('connect', () => finish(new Error(`Unexpected listener on 127.0.0.1:${port}`)));
        socket.once('timeout', () => finish(new Error(`Timed out checking 127.0.0.1:${port}`)));
        socket.once('error', error => {
            if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ECONNREFUSED') {
                finish();
            } else {
                finish(error);
            }
        });
    });
}

async function assertOwnedPortsClosed() {
    for (const port of OWNED_PORTS) {
        await assertPortClosed(port);
    }
}

async function waitForAdmin(state) {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (state.child && (state.child.exitCode !== null || state.child.signalCode !== null)) {
            throw new Error(
                `Controller exited before Admin became ready (code ${state.child.exitCode}, signal ${state.child.signalCode}):\n${state.output}`,
            );
        }
        try {
            const response = await fetch(BASE_URL, { signal: AbortSignal.timeout(3000) });
            if (response.status < 500) {
                return;
            }
        } catch {
            // Admin is still starting.
        }
        await delay(500);
    }
    throw new Error(`Admin did not become ready within ${START_TIMEOUT_MS} ms:\n${state.output}`);
}

async function expectSaveDisabled(save, expected) {
    await save.page().waitForFunction(
        ({ expected: wanted }) => {
            const document = /** @type {any} */ (globalThis.document);
            const button = [...document.querySelectorAll('button')].find(candidate => candidate.textContent.trim() === 'Save');
            return button && button.disabled === wanted;
        },
        { expected },
        { timeout: 5000 },
    );
}

async function saveAndReload(page, save) {
    await expectSaveDisabled(save, false);
    await save.click();
    await expectSaveDisabled(save, true);
    await page.reload();
    await page.getByRole('button', { name: 'Save', exact: true }).waitFor();
}

async function runBrowserChecks() {
    if (shutdownRequested) {
        throw new Error('Admin E2E was cancelled before browser launch');
    }
    const launchOptions = { headless: true };
    if (process.env.CHROME_PATH) {
        launchOptions.executablePath = process.env.CHROME_PATH;
    } else {
        launchOptions.channel = process.env.CHROME_CHANNEL || 'chrome';
    }
    browserLaunch = chromium.launch(launchOptions);
    const pageErrors = [];
    let page;
    try {
        const browser = await browserLaunch;
        if (shutdownRequested) {
            throw new Error('Admin E2E was cancelled during browser launch');
        }
        page = await browser.newPage({ locale: 'en-US', viewport: { width: 1280, height: 1000 } });
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.goto(CONFIG_URL);
        const save = page.getByRole('button', { name: 'Save', exact: true });
        const serial = page.getByLabel('VE.Direct serial port', { exact: true });
        const tcpToggle = page.getByLabel('Use a raw TCP serial server instead of a local serial port', { exact: true });
        const host = page.getByLabel('Raw TCP serial server hostname or IP address', { exact: true });
        const port = page.getByLabel('Raw TCP serial server port', { exact: true });
        const currentToggle = page.getByLabel('Enable dynamic charge current control', { exact: true });
        const currentMax = page.getByLabel('Current control safety cap (A)', { exact: true });
        const refresh = page.getByLabel('Current limit refresh interval (seconds)', { exact: true });
        const tcpWarning = page
            .getByText(
                'Raw TCP is unencrypted and unauthenticated. Use only a trusted network. Telnet and RFC2217 negotiation are not supported.',
                { exact: true },
            )
            .locator('..');
        const controlWarning = page
            .getByText(
                'Loss of external control returns the charger to stand-alone operation and its persistent maximum current; it is not a fail-safe shutdown.',
                { exact: true },
            )
            .locator('..');

        await serial.waitFor();
        await controlWarning.waitFor();
        assert.equal(await controlWarning.locator('svg').count(), 1, 'control warning has no dismiss icon');
        assert.equal(await host.isVisible(), false, 'TCP host is hidden in serial mode');
        assert.equal(await port.isVisible(), false, 'TCP port is hidden in serial mode');
        assert.equal(await currentMax.isVisible(), false, 'current cap is hidden without opt-in');
        await expectSaveDisabled(save, true);

        await tcpToggle.click();
        await host.waitFor();
        await tcpWarning.waitFor();
        assert.equal(await tcpWarning.locator('svg').count(), 1, 'TCP warning has no dismiss icon');
        assert.equal(await serial.isVisible(), false, 'serial path is hidden in TCP mode');
        await port.fill('1234');
        await host.fill('http://127.0.0.1');
        await expectSaveDisabled(save, true);
        await host.fill(':::');
        await expectSaveDisabled(save, true);
        await host.fill('::ffff:192.168.001.001');
        await expectSaveDisabled(save, true);
        await host.fill('192.0.2.1::');
        await expectSaveDisabled(save, true);
        await host.fill('fe80::1%a_b');
        await expectSaveDisabled(save, true);
        await host.fill('0:0:0:0:0:ffff:192.0.2.1');
        await expectSaveDisabled(save, false);
        await host.fill('2001:db8::1%lo0');
        await expectSaveDisabled(save, false);
        await host.fill('::ffff:192.0.2.1');
        await expectSaveDisabled(save, false);
        await host.fill('127.0.0.1');
        await port.fill('1.5');
        await expectSaveDisabled(save, true);
        await port.fill('65536');
        await expectSaveDisabled(save, true);
        await port.fill('1234');
        await expectSaveDisabled(save, false);
        await host.fill('::1');
        await expectSaveDisabled(save, false);

        await currentToggle.click();
        await currentMax.waitFor();
        await currentMax.fill('0');
        await expectSaveDisabled(save, true);
        await currentMax.fill('0.05');
        await expectSaveDisabled(save, true);
        await currentMax.fill('12.3');
        await refresh.fill('4');
        await expectSaveDisabled(save, true);
        await refresh.fill('51');
        await expectSaveDisabled(save, true);
        await refresh.fill('50');
        await expectSaveDisabled(save, false);
        await refresh.fill('20');
        await expectSaveDisabled(save, false);
        await currentMax.fill('0.05');
        await currentToggle.click();
        assert.equal(await currentMax.isVisible(), false, 'invalid cap hides after opt-out');
        await expectSaveDisabled(save, false);
        await saveAndReload(page, save);
        await currentToggle.click();
        await currentMax.waitFor();
        assert.equal(await currentMax.inputValue(), '0.05', 'disabled invalid cap persists without blocking startup');
        await expectSaveDisabled(save, true);
        await currentMax.fill('12.3');
        await currentToggle.click();
        assert.equal(await currentMax.isVisible(), false, 'current cap hides after opt-out');
        await expectSaveDisabled(save, false);

        await saveAndReload(page, save);
        await host.waitFor();
        assert.equal(await host.inputValue(), '::1', 'TCP host persists through save and reload');
        assert.equal(await port.inputValue(), '1234', 'TCP port persists through save and reload');
        assert.equal(await host.isVisible(), true, 'TCP remains enabled after reload');

        await tcpToggle.click();
        await serial.waitFor();
        await serial.fill('/dev/ttyUSB-test');
        await expectSaveDisabled(save, false);
        await saveAndReload(page, save);
        await serial.waitFor();
        assert.equal(await serial.inputValue(), '/dev/ttyUSB-test', 'serial path persists through save and reload');
        assert.equal(await host.isVisible(), false, 'TCP fields stay hidden in serial mode');

        await tcpToggle.click();
        await host.waitFor();
        assert.equal(await host.inputValue(), '::1', 'hidden TCP host is retained');
        assert.equal(await port.inputValue(), '1234', 'hidden TCP port is retained');
        await tcpToggle.click();
        await serial.waitFor();
        assert.equal(await serial.inputValue(), '/dev/ttyUSB-test', 'serial value remains after toggling');
        assert.deepEqual(pageErrors, [], 'no browser page errors');
        console.log('Admin E2E passed: load, validation, toggles, save, reload, and hidden native persistence.');
    } catch (error) {
        const directory = path.join(ROOT, 'test-results');
        fs.mkdirSync(directory, { recursive: true });
        if (page) {
            await page.screenshot({ path: path.join(directory, 'admin-e2e-failure.png'), fullPage: true });
        }
        throw error;
    } finally {
        await stopBrowser();
    }
}

async function main() {
    if (!process.env.ADMIN_E2E_URL) {
        assertLoopbackAdminProfile();
        await assertOwnedPortsClosed();
    }
    shutdownState = startDevServer();
    const devServer = shutdownState;
    try {
        await waitForAdmin(devServer);
        if (!process.env.ADMIN_E2E_URL) {
            await assertPortClosed(DEV_SERVER_PROXY_PORT);
        }
        await runBrowserChecks();
    } catch (error) {
        console.error(devServer.output);
        throw error;
    } finally {
        await stopDevServer(devServer);
    }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
        const exitCode = signal === 'SIGINT' ? 130 : 143;
        shutdownRequested = true;
        void (async () => {
            const cleanups = [];
            if (browserLaunch) {
                cleanups.push(stopBrowser());
            }
            if (shutdownState) {
                cleanups.push(stopDevServer(shutdownState));
            }
            const results = await Promise.allSettled(cleanups);
            for (const result of results) {
                if (result.status === 'rejected') {
                    console.error(`Cleanup after ${signal} failed: ${result.reason}`);
                }
            }
            process.exit(results.some(result => result.status === 'rejected') ? 1 : exitCode);
        })();
    });
}

main().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
});
