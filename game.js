import { createGameAudio } from './audio.js';

const shell = document.getElementById('game-shell');
const canvas = document.getElementById('canvas');
const debug = new URLSearchParams(location.search).has('debug');
let app;
let stopped = false;
let frameCheck;

function showMessage(title, text) {
  stopped = true;
  clearInterval(frameCheck);
  console.error(title + ': ' + text);
  canvas.setAttribute('aria-label', title + ': ' + text);
}

function focusGame() {
  canvas.focus({ preventScroll: true });
}

function unlockAudio() {
  const context = app?.peAudio?.context;
  if (!stopped && context?.state === 'suspended') context.resume().catch(() => {});
}

canvas.addEventListener('contextmenu', event => event.preventDefault());
canvas.addEventListener('click', focusGame);
canvas.addEventListener('dblclick', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await shell.requestFullscreen();
  } catch {}
});
for (const type of ['pointerdown', 'keydown']) addEventListener(type, unlockAudio, true);

const downAt = new Map();
const synthetic = new WeakSet();
addEventListener('keydown', event => {
  if (event.target === canvas && !event.repeat) downAt.set(event.code, performance.now());
}, true);
addEventListener('keyup', event => {
  if (event.target !== canvas || synthetic.has(event)) return;
  const held = performance.now() - (downAt.get(event.code) ?? -Infinity);
  downAt.delete(event.code);
  if (held >= 60) return;
  event.stopImmediatePropagation();
  const init = { key: event.key, code: event.code, keyCode: event.keyCode, which: event.which, location: event.location, bubbles: true };
  setTimeout(() => {
    const release = new KeyboardEvent('keyup', init);
    synthetic.add(release);
    canvas.dispatchEvent(release);
  }, 60 - held);
}, true);

function loadRuntime() {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('app.js', import.meta.url).href;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Could not load the game runtime. Check your connection and try again.'));
    document.head.append(script);
  });
}

async function restoreSaves(FS) {
  for (const directory of ['/documents', '/appdata', '/localappdata']) {
    try { FS.mkdir(directory); } catch {}
    FS.mount(FS.filesystems.IDBFS, {}, directory);
  }
  await new Promise(resolve => FS.syncfs(true, error => {
    if (error) {
      console.warn('Could not restore saves:', error);
    }
    resolve();
  }));
}

function keepSaves(FS) {
  let syncing = false;
  let pending = false;
  let timer;
  const save = () => {
    if (syncing) {
      pending = true;
      return;
    }
    syncing = true;
    FS.syncfs(false, error => {
      syncing = false;
      if (error) {
        console.warn('Save failed:', error);
      }
      if (pending) {
        pending = false;
        save();
      }
    });
  };
  for (const name of ['close', 'rename', 'unlink']) {
    const original = FS[name];
    FS[name] = function (target, ...rest) {
      const result = original.call(this, target, ...rest);
      const path = typeof target === 'string' ? target : target?.path || '';
      if (/^\/(documents|appdata|localappdata)\//.test(path)) {
        clearTimeout(timer);
        timer = setTimeout(save, 300);
      }
      return result;
    };
  }
  setInterval(save, 3000);
  addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
  return save;
}

async function start() {
  shell.dataset.state = 'loading';
  await prepareAssets();
  const response = await fetch(new URL('files.json', import.meta.url));
  if (!response.ok) throw new Error('Could not load the game file list.');
  const list = await response.json();
  const [pack] = await Promise.all([fetchSmallPack(list), loadRuntime()]);
  const packageData = (await fetchAsset('app.data')).buffer;
  app = await createPEModule({
    canvas,
    wasmBinary: await fetchAsset('app.wasm'),
    getPreloadedPackage: () => packageData,
    locateFile: name => new URL(name, import.meta.url).href,
    peCreateAudio: createGameAudio,
    print: (...args) => { if (debug) console.log(...args); },
    printErr: (...args) => { if (debug) console.warn(...args); },
    preRun: [module => {
      Object.assign(module.ENV, { PEWASM_DESKTOP: '1280x720', PEWASM_STEAM_OFFLINE: '1', SteamAppId: '204360' });
      if (debug) Object.assign(module.ENV, { PEWASM_TRACE_FILES: '1', PEWASM_PERF_STATS: '1', PEWASM_TRACE_AUDIO: '1' });
      module.peOpenUrl = url => {
        try {
          const target = new URL(url);
          if (['https:', 'http:'].includes(target.protocol)) window.open(target.href, '_blank', 'noopener,noreferrer');
        } catch {}
      };
      mountLazyFiles(module, list, pack);
    }],
    onAbort: reason => showMessage('Unable to continue', String(reason || 'The game stopped unexpectedly. Reload to try again.')),
  });
  window.game = app;
  startGamepads(app);
  await restoreSaves(app.FS);
  const save = keepSaves(app.FS);
  frameCheck = setInterval(() => {
    if (stopped || !(app.peD3DFrames > 1)) return;
    clearInterval(frameCheck);
    shell.dataset.state = 'playing';
    canvas.setAttribute('aria-hidden', 'false');
    focusGame();
    unlockAudio();
  }, 100);
  try {
    await app.ccall('pe_run', 'number', [], [], { async: true });
    if (!stopped) showMessage('Game closed', 'Reload whenever you want to play again.');
  } catch (error) {
    if (!stopped) showMessage('Unable to continue', error?.message || String(error));
    console.error(error);
  } finally {
    clearInterval(frameCheck);
    save();
  }
}

if (location.protocol === 'file:') {
  showMessage('Unable to load', 'Open the hosted website or run npm start.');
} else if (!WebAssembly.Suspending || !WebAssembly.promising) {
  showMessage('Browser unsupported', 'Use a current version of Chrome or Edge with WebAssembly JSPI support.');
} else {
  start().catch(error => showMessage('Could not load game', error.message));
}
