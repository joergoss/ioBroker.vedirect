'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '../..');
const BASE_URL = process.env.ADMIN_E2E_URL || 'http://127.0.0.1:8081';
const CONFIG_URL = `${BASE_URL}/#tab-instances/config/system.adapter.vedirect.0`;
const START_TIMEOUT_MS = 120000;

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function startDevServer() {
    if (process.env.ADMIN_E2E_URL) {
        return { child: null, output: '' };
    }
    const executable = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const child = spawn(executable, ['--yes', '--package=@iobroker/dev-server', 'dev-server', 'run', '--noBrowserSync'], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
    });
    const state = { child, output: '' };
    for (const stream of [child.stdout, child.stderr]) {
        stream.on('data', data => {
            state.output = `${state.output}${data}`.slice(-30000);
        });
    }
    return state;
}

async function stopDevServer(state) {
    const child = state.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
        return;
    }
    const closed = new Promise(resolve => child.once('close', resolve));
    if (process.platform === 'win32') {
        child.kill('SIGTERM');
    } else {
        try {
            process.kill(-child.pid, 'SIGTERM');
        } catch {
            child.kill('SIGTERM');
        }
    }
    await Promise.race([closed, delay(5000)]);
    if (child.exitCode === null && child.signalCode === null) {
        if (process.platform === 'win32') {
            child.kill('SIGKILL');
        } else {
            try {
                process.kill(-child.pid, 'SIGKILL');
            } catch {
                child.kill('SIGKILL');
            }
        }
        await Promise.race([closed, delay(2000)]);
    }
}

async function waitForAdmin(state) {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (state.child?.exitCode !== null && state.child?.exitCode !== undefined) {
            throw new Error(`dev-server exited before Admin became ready:\n${state.output}`);
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
    const launchOptions = { headless: true };
    if (process.env.CHROME_PATH) {
        launchOptions.executablePath = process.env.CHROME_PATH;
    } else {
        launchOptions.channel = process.env.CHROME_CHANNEL || 'chrome';
    }
    const browser = await chromium.launch(launchOptions);
    const pageErrors = [];
    let page;
    try {
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

        await serial.waitFor();
        assert.equal(await host.isVisible(), false, 'TCP host is hidden in serial mode');
        assert.equal(await port.isVisible(), false, 'TCP port is hidden in serial mode');
        assert.equal(await currentMax.isVisible(), false, 'current cap is hidden without opt-in');
        await expectSaveDisabled(save, true);

        await tcpToggle.click();
        await host.waitFor();
        assert.equal(await serial.isVisible(), false, 'serial path is hidden in TCP mode');
        await host.fill('http://127.0.0.1');
        await expectSaveDisabled(save, true);
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
        await browser.close();
    }
}

async function main() {
    const devServer = startDevServer();
    try {
        await waitForAdmin(devServer);
        await runBrowserChecks();
    } catch (error) {
        console.error(devServer.output);
        throw error;
    } finally {
        await stopDevServer(devServer);
    }
}

main().catch(error => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
});
