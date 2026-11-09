// In-container, dependency-free Chromium driver for the reviewer's ui_snapshot; baked into the visual image.
// It speaks CDP over --remote-debugging-pipe (fds 3/4), so the browser opens no debugging port.
// Input: one JSON argument { routes, viewport, login }; output: one JSON line on stdout. Every string and list is bounded.
// sandbox.sh seeds the panel (config, database, admin, random password) under /tmp/panel before this starts.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const LIMITS = { entries: 20, entryChars: 300, textChars: 4000, axLines: 60, axChars: 120, imageBase64: 1024 * 1024, totalBase64: 3 * 1024 * 1024, routeMs: 25_000, idleMs: 500, loginMs: 20_000 };
const PANEL = { base: 'http://127.0.0.1:8080/', email: 'annie@example.com', password: '/tmp/panel/password', log: '/tmp/panel/panel.log' };
const { routes, viewport: { width, height }, login } = JSON.parse(process.argv[2]);
const { base, email } = PANEL, password = login ? readFileSync(PANEL.password, 'utf8').trim() : '';
const cut = (value, max) => { const text = String(value ?? '').replace(/\s+\n/g, '\n'); return text.length > max ? `${text.slice(0, max)}…` : text; };
const push = (list, value) => { if (list.length < LIMITS.entries) list.push(cut(value, LIMITS.entryChars)); else list.overflow = (list.overflow ?? 0) + 1; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Pipe writes are asynchronous: exit only after the whole line is flushed.
const out = value => new Promise(() => process.stdout.write(`${JSON.stringify(value)}\n`, () => process.exit(0)));
for (const event of ['uncaughtException', 'unhandledRejection']) process.on(event, error => out({ error: `driver failed: ${cut(error?.message ?? error, LIMITS.entryChars)}` }));

// Readiness of the candidate panel on container loopback.
const started = Date.now();
for (;;) {
  try { if ((await fetch(base, { signal: AbortSignal.timeout(2000) })).ok) break; } catch { /* still starting */ }
  if (Date.now() - started > 60_000) { let log = ''; try { log = readFileSync(PANEL.log, 'utf8').slice(-600); } catch { /* none */ } await out({ error: `candidate panel did not answer on 127.0.0.1 within 60s; panel log tail: ${log}` }); }
  await sleep(250);
}

const chrome = spawn('chromium-browser', ['--headless', '--no-sandbox', '--remote-debugging-pipe', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps', '--disable-crash-reporter', '--mute-audio', '--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none', '--lang=en-US', '--disable-features=Translate,MediaRouter,OptimizationHints', `--window-size=${width},${height}`, '--user-data-dir=/tmp/chrome', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let chromeLog = '';
chrome.stderr.on('data', chunk => { chromeLog = (chromeLog + chunk).slice(-4000); });
chrome.once('exit', code => out({ error: `chromium exited (${code}): ${cut(chromeLog.split('\n').filter(line => !/dbus|^\s*$/i.test(line)).slice(-5).join('\n'), 600)}` }));
const pending = new Map(), handlers = new Set();
let nextId = 0, buffer = Buffer.alloc(0);
chrome.stdio[4].on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  for (let end; (end = buffer.indexOf(0)) !== -1;) {
    const message = JSON.parse(buffer.subarray(0, end).toString('utf8')); buffer = buffer.subarray(end + 1);
    if (message.id !== undefined) { const call = pending.get(message.id); pending.delete(message.id); if (message.error) call?.reject(Error(`${call.method}: ${message.error.message}`)); else call?.resolve(message.result); }
    else for (const handler of handlers) handler(message);
  }
});
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++nextId; pending.set(id, { resolve, reject, method });
  chrome.stdio[3].write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
});
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const page = (method, params) => send(method, params, sessionId);

let signals = null, inflight = new Map(), lastActivity = Date.now(), loaded = false;
const fresh = () => ({ consoleErrors: [], consoleWarnings: [], exceptions: [], failedRequests: [], offlineRequests: [] });
// The container is offline by design: requests to other hosts fail there, not in the candidate.
const origin = new URL(base).origin;
const external = url => { try { return !['data:', 'blob:', 'about:'].includes(new URL(url).protocol) && new URL(url).origin !== origin; } catch { return false; } };
handlers.add(({ method, params, sessionId: from }) => {
  if (from !== sessionId || !signals) return;
  if (method === 'Runtime.consoleAPICalled' && ['error', 'assert', 'warning'].includes(params.type)) push(params.type === 'warning' ? signals.consoleWarnings : signals.consoleErrors, params.args.map(arg => arg.value ?? arg.description ?? arg.type).join(' '));
  else if (method === 'Log.entryAdded' && ['error', 'warning'].includes(params.entry.level) && !(params.entry.source === 'network' && external(params.entry.url))) push(params.entry.level === 'warning' ? signals.consoleWarnings : signals.consoleErrors, `${params.entry.text}${params.entry.url ? ` (${params.entry.url})` : ''}`);
  else if (method === 'Runtime.exceptionThrown') push(signals.exceptions, params.exceptionDetails.exception?.description ?? params.exceptionDetails.text);
  else if (method === 'Network.requestWillBeSent') { inflight.set(params.requestId, params.request.url); lastActivity = Date.now(); }
  else if (method === 'Network.responseReceived' && params.response.status >= 400) push(signals.failedRequests, `${params.response.status} ${params.response.url}`);
  else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
    const url = inflight.get(params.requestId) ?? '';
    if (method === 'Network.loadingFailed' && !params.canceled) push(external(url) ? signals.offlineRequests : signals.failedRequests, external(url) ? url : `failed ${params.errorText} ${url}`);
    inflight.delete(params.requestId); lastActivity = Date.now();
  } else if (method === 'Page.loadEventFired') loaded = true;
});
await Promise.all([page('Page.enable'), page('Runtime.enable'), page('Log.enable'), page('Network.enable'), page('Accessibility.enable')]);
await page('Network.setBypassServiceWorker', { bypass: true });
// An empty virtual authenticator makes the login form's passkey attempt fail at once instead of waiting for a device.
await page('WebAuthn.enable', { enableUI: false });
await page('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true } });
await page('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
await page('Emulation.setTimezoneOverride', { timezoneId: 'UTC' });
await page('Emulation.setLocaleOverride', { locale: 'en-US' });
await page('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: 'light' }] });
// No animation, transition, or blinking caret reaches a screenshot.
await page('Page.addScriptToEvaluateOnNewDocument', { source: `addEventListener('DOMContentLoaded', () => { const style = document.createElement('style'); style.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}'; document.head.append(style); });` });

const evaluate = async expression => { const { result, exceptionDetails } = await page('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (exceptionDetails) throw Error(exceptionDetails.exception?.description ?? exceptionDetails.text); return result.value; };
// Settled: load fired and no request in flight for idleMs, bounded by the deadline.
const settle = async deadline => {
  while (Date.now() < deadline) { if (loaded && inflight.size === 0 && Date.now() - lastActivity >= LIMITS.idleMs) break; await sleep(50); }
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))').catch(() => undefined);
};
const goto = async (path, ms) => {
  loaded = false; inflight = new Map(); lastActivity = Date.now();
  const deadline = Date.now() + ms, { errorText } = await page('Page.navigate', { url: new URL(path, base).href });
  if (errorText) throw Error(`navigation failed: ${errorText}`);
  await settle(deadline);
};
const waitFor = async (expression, ms) => { const deadline = Date.now() + ms; while (Date.now() < deadline) { if (await evaluate(expression).catch(() => false)) return true; await sleep(100); } return false; };
const key = async () => { for (const type of ['keyDown', 'keyUp']) await page('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) }); };
const typeInto = async (selector, text) => { if (!await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el || el.disabled || !el.offsetParent) return false; el.focus(); return true; })()`)) throw Error(`login field ${selector} not usable`); await page('Input.insertText', { text }); };

// Login goes through the real login form: email, Enter, password, Enter, then away from /auth/login.
let loginResult = null;
if (login) {
  signals = fresh();
  try {
    await goto('/auth/login', LIMITS.loginMs);
    await typeInto('input[type=email]', email); await key();
    if (!await waitFor(`!!document.querySelector('input[type=password]:not([disabled])')?.offsetParent`, 10_000)) throw Error('password field did not appear');
    await typeInto('input[type=password]:not([disabled])', password); await key();
    if (!await waitFor(`location.pathname !== '/auth/login'`, LIMITS.loginMs)) throw Error('still on /auth/login after submitting credentials');
    loaded = true; await settle(Date.now() + 5000);
    loginResult = { ok: true, url: await evaluate('location.href') };
  } catch (error) { loginResult = { ok: false, error: cut(error.message, LIMITS.entryChars), ...signals }; }
}

const LANDMARKS = new Set(['banner', 'navigation', 'main', 'complementary', 'contentinfo', 'form', 'search', 'region', 'dialog', 'alertdialog', 'alert', 'heading', 'button', 'link', 'textbox', 'checkbox', 'combobox', 'tab', 'menuitem', 'img', 'status']);
let imageBytes = 0;
const results = [];
for (const route of routes) {
  signals = fresh();
  const entry = { route };
  try {
    await goto(route, LIMITS.routeMs);
    const state = await evaluate(`({ url: location.href, title: document.title, text: document.body ? document.body.innerText : '' })`);
    entry.finalUrl = cut(state.url, 500); entry.title = cut(state.title, 200); entry.text = cut(state.text, LIMITS.textChars);
    const { nodes } = await page('Accessibility.getFullAXTree');
    const lines = nodes.filter(node => !node.ignored && LANDMARKS.has(node.role?.value)).map(node => `${node.role.value}${node.properties?.find(prop => prop.name === 'level') ? ` level ${node.properties.find(prop => prop.name === 'level').value.value}` : ''}: ${cut(node.name?.value ?? '', LIMITS.axChars)}`);
    entry.accessibility = lines.slice(0, LIMITS.axLines); if (lines.length > LIMITS.axLines) entry.accessibility.push(`… ${lines.length - LIMITS.axLines} more`);
    let { data } = await page('Page.captureScreenshot', { format: 'png' });
    if (data.length > LIMITS.imageBase64) ({ data } = await page('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height, scale: 0.5 } }));
    if (data.length > LIMITS.imageBase64 || imageBytes + data.length > LIMITS.totalBase64) entry.screenshotOmitted = 'screenshot exceeds the per-image or per-call size cap';
    else { imageBytes += data.length; entry.screenshot = data; }
  } catch (error) { entry.error = cut(error.message, LIMITS.entryChars); }
  results.push(Object.assign(entry, Object.fromEntries(Object.entries(signals).map(([name, list]) => [name, list.overflow ? [...list, `… ${list.overflow} more`] : [...list]]))));
}
const version = await send('Browser.getVersion').then(value => cut(value.product, 60), () => null);
chrome.removeAllListeners('exit'); chrome.kill('SIGKILL');
await out({ browser: version, login: loginResult, routes: results });
