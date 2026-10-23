'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, nativeImage, screen } = require('electron');
const store = require('./lib/store');
const { fetchSource, testSource } = require('./lib/sources');
const { makeIcon } = require('./lib/icon');
const desktop = require('./lib/desktop');

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS_AHEAD = 2; // 월간 보기에서 이번 달 이후로 넘겨 볼 수 있는 개월 수
const PLACEMENTS = ['desktop', 'normal', 'top'];

// 개발 실행(npm start)과 설치본이 같은 설정 폴더(%APPDATA%\CalendarWidget)를 쓰도록 고정한다.
// 실제 설정을 건드리지 않고 시험하려면 CALENDAR_WIDGET_DATA_DIR로 다른 폴더를 지정한다.
app.setPath('userData', process.env.CALENDAR_WIDGET_DATA_DIR || path.join(app.getPath('appData'), 'CalendarWidget'));

let config;
let icon;
let tray = null;
let widget = null;
let settingsWin = null;
let refreshTimer = null;
let quitting = false;
let state = { events: [], errors: [], lastSync: null, syncing: false };
const notified = new Set();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWidget);
  app.whenReady().then(init);
}

// 트레이 상주 앱이므로 창이 모두 닫혀도 종료하지 않는다.
app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  quitting = true;
});

function init() {
  app.setAppUserModelId('com.calendarwidget.app');
  config = store.load();
  config.settings = sanitizeSettings({}); // 저장된 값 검증 (예: 바탕화면 고정을 못 쓰는 환경이면 일반 창으로)
  icon = makeIcon(nativeImage);

  const cache = store.readJson('cache.json', null);
  if (cache && Array.isArray(cache.events)) {
    state = { ...state, events: cache.events, lastSync: cache.lastSync || null };
  }

  createWidget();
  desktop.watchShowDesktop(() => widget, screen, () => config.settings.placement === 'desktop');
  createTray();
  applyLoginItem();
  scheduleRefresh();
  refreshAll();
  setInterval(checkNotifications, 30 * 1000);
}

// ---------- 창 ----------

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function visibleBounds(bounds) {
  if (!bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return null;
  const onScreen = screen.getAllDisplays().some(({ workArea: a }) =>
    bounds.x < a.x + a.width - 40 && bounds.x + bounds.width > a.x + 40 && bounds.y >= a.y - 10 && bounds.y < a.y + a.height - 40,
  );
  return onScreen ? bounds : null;
}

function webPreferences() {
  return {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  };
}

function createWidget() {
  const saved = config.settings.expanded ? config.settings.expandedBounds : config.settings.bounds;
  const bounds = visibleBounds(saved) || (config.settings.expanded ? defaultExpandedBounds() : defaultCompactBounds());

  widget = new BrowserWindow({
    ...bounds,
    minWidth: 260,
    minHeight: 200,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: !config.settings.locked,
    movable: !config.settings.locked,
    skipTaskbar: true,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: config.settings.placement === 'top',
    show: false,
    icon,
    webPreferences: webPreferences(),
  });
  widget.loadFile(path.join(__dirname, 'renderer', 'widget.html'));
  widget.once('ready-to-show', () => {
    widget.showInactive();
    applyPlacement();
  });

  // 바탕화면 고정 모드에서는 위젯을 클릭해도 다른 창들 위로 올라오지 않게 다시 맨 아래로 보낸다.
  widget.on('focus', () => {
    if (config.settings.placement === 'desktop') setImmediate(() => widget && desktop.sendToBottom(widget));
  });

  const saveBounds = debounce(() => {
    if (!widget || widget.isDestroyed()) return;
    config.settings[config.settings.expanded ? 'expandedBounds' : 'bounds'] = widget.getBounds();
    store.save(config);
  }, 500);
  widget.on('move', saveBounds);
  widget.on('resize', saveBounds);
  widget.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      widget.hide();
      updateTrayMenu();
    }
  });
  // 소유자인 바탕화면 창이 사라지면(Explorer 재시작) 위젯도 함께 파괴되므로 다시 만든다.
  widget.on('closed', () => {
    widget = null;
    if (!quitting) setTimeout(createWidget, 2000);
  });
}

function defaultCompactBounds() {
  const area = screen.getPrimaryDisplay().workArea;
  return { width: 340, height: 540, x: area.x + area.width - 360, y: area.y + 20 };
}

// 크게 보기 기본 크기: 위젯이 있는 모니터 가운데에 최대 1000x720.
function defaultExpandedBounds() {
  const area = widget ? screen.getDisplayMatching(widget.getBounds()).workArea : screen.getPrimaryDisplay().workArea;
  const width = Math.min(1000, area.width - 40);
  const height = Math.min(720, area.height - 40);
  return {
    width,
    height,
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
  };
}

// 기본 크기와 크게 보기 크기를 각각 기억해 두고 전환한다.
function setExpanded(on) {
  if (!widget || widget.isDestroyed() || on === config.settings.expanded) return;
  const current = widget.getBounds();
  let target;
  if (on) {
    config.settings.bounds = current;
    target = visibleBounds(config.settings.expandedBounds) || defaultExpandedBounds();
  } else {
    config.settings.expandedBounds = current;
    target = visibleBounds(config.settings.bounds) || defaultCompactBounds();
  }
  config.settings.expanded = on;
  store.save(config);
  widget.setBounds(target);
  broadcast('settings:update', publicSettings());
}

function applyPlacement() {
  if (!widget || widget.isDestroyed()) return;
  const placement = config.settings.placement;
  widget.setAlwaysOnTop(placement === 'top');
  if (placement === 'desktop') {
    if (!desktop.attachToDesktop(widget)) console.warn('바탕화면 창(Progman)을 찾지 못해 일반 창으로 표시합니다.');
  } else {
    desktop.detachFromDesktop(widget);
  }
}

function showWidget() {
  if (!widget) return;
  widget.show();
  // 바탕화면 고정 모드에서 focus()를 부르면 곧바로 맨 아래로 내려가므로 잠깐 위로만 올린다.
  if (config.settings.placement === 'desktop') widget.moveTop();
  else widget.focus();
  updateTrayMenu();
}

function toggleWidget() {
  if (!widget) return;
  if (widget.isVisible()) {
    widget.hide();
    updateTrayMenu();
  } else {
    showWidget();
  }
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 720,
    height: 680,
    minWidth: 560,
    minHeight: 480,
    title: '캘린더 위젯 설정',
    icon,
    autoHideMenuBar: true,
    webPreferences: webPreferences(),
  });
  settingsWin.setMenu(null);
  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

// ---------- 트레이 ----------

function createTray() {
  tray = new Tray(icon);
  tray.setToolTip('캘린더 위젯');
  tray.on('click', toggleWidget);
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  const s = config.settings;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: widget && widget.isVisible() ? '위젯 숨기기' : '위젯 보이기', click: toggleWidget },
      { label: '지금 새로고침', click: () => refreshAll() },
      { label: '설정…', click: openSettings },
      { type: 'separator' },
      ...(desktop.isSupported()
        ? [{ label: '바탕화면에 고정', type: 'radio', checked: s.placement === 'desktop', click: () => updateSettings({ placement: 'desktop' }) }]
        : []),
      { label: '일반 창', type: 'radio', checked: s.placement === 'normal', click: () => updateSettings({ placement: 'normal' }) },
      { label: '항상 위에 표시', type: 'radio', checked: s.placement === 'top', click: () => updateSettings({ placement: 'top' }) },
      { type: 'separator' },
      { label: '위치·크기 잠금', type: 'checkbox', checked: s.locked, click: (i) => updateSettings({ locked: i.checked }) },
      { label: 'Windows 시작 시 실행', type: 'checkbox', checked: s.launchAtLogin, click: (i) => updateSettings({ launchAtLogin: i.checked }) },
      { type: 'separator' },
      { label: '종료', click: () => app.quit() },
    ]),
  );
}

// ---------- 설정 ----------

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function sanitizeSettings(input) {
  const d = store.DEFAULT_SETTINGS;
  const cur = config.settings;
  const s = { ...cur, ...input };
  return {
    ...s,
    refreshMinutes: Math.round(clampNumber(s.refreshMinutes, 1, 1440, d.refreshMinutes)),
    daysAhead: Math.round(clampNumber(s.daysAhead, 1, 90, d.daysAhead)),
    notifyMinutes: Math.round(clampNumber(s.notifyMinutes, 0, 1440, d.notifyMinutes)),
    opacity: clampNumber(s.opacity, 0.2, 1, d.opacity),
    placement: PLACEMENTS.includes(s.placement) && (s.placement !== 'desktop' || desktop.isSupported()) ? s.placement : 'normal',
    locked: Boolean(s.locked),
    launchAtLogin: Boolean(s.launchAtLogin),
    expanded: Boolean(s.expanded),
  };
}

function sanitizeSources(incoming) {
  const previous = new Map(config.sources.map((s) => [s.id, s]));
  return incoming.map((s) => {
    const type = s.type === 'caldav' ? 'caldav' : 'ics';
    const old = previous.get(s.id);
    const out = {
      id: typeof s.id === 'string' && s.id ? s.id : randomUUID(),
      type,
      preset: /^[a-z]{1,20}$/.test(s.preset) ? s.preset : type,
      name: String(s.name || '').trim() || '캘린더',
      color: /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : '#3b82f6',
      enabled: s.enabled !== false,
      url: type === 'caldav' ? String(s.url || '').trim() : '',
      username: type === 'caldav' ? String(s.username || '').trim() : '',
      calendars: Array.isArray(s.calendars) ? s.calendars.map((c) => String(c).trim()).filter(Boolean) : [],
    };
    if (s.secret) out.secret = store.encryptSecret(String(s.secret).trim());
    else if (old && old.secret && old.type === type) out.secret = old.secret;
    return out;
  });
}

function applyLoginItem() {
  if (!app.isPackaged) return; // 개발 실행(electron .)을 시작 프로그램에 등록하지 않는다.
  app.setLoginItemSettings({ openAtLogin: config.settings.launchAtLogin });
}

function applySettings(prev) {
  const s = config.settings;
  if (prev.placement !== s.placement) applyPlacement();
  if (widget && !widget.isDestroyed()) {
    widget.setResizable(!s.locked);
    widget.setMovable(!s.locked);
  }
  if (prev.launchAtLogin !== s.launchAtLogin) applyLoginItem();
  if (prev.refreshMinutes !== s.refreshMinutes) scheduleRefresh();
  updateTrayMenu();
  broadcast('settings:update', publicSettings());
}

function updateSettings(patch) {
  const prev = config.settings;
  config.settings = sanitizeSettings(patch);
  store.save(config);
  applySettings(prev);
  if (prev.daysAhead !== config.settings.daysAhead) refreshAll();
}

function publicSettings() {
  const { bounds, expandedBounds, ...rest } = config.settings;
  return { ...rest, desktopSupported: desktop.isSupported() };
}

// ---------- 동기화 ----------

function scheduleRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshAll, config.settings.refreshMinutes * 60 * 1000);
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// 목록 보기(오늘부터 N일)와 월간 보기(이번 달 달력의 첫 주 ~ MONTHS_AHEAD개월 뒤 달력의 마지막 주)를 모두 덮는 범위.
function syncRange() {
  const today = startOfToday();
  const from = new Date(today.getFullYear(), today.getMonth(), 1);
  from.setDate(from.getDate() - from.getDay());
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + MONTHS_AHEAD + 1, 1);
  monthEnd.setDate(monthEnd.getDate() + (7 - monthEnd.getDay()) % 7);
  const agendaEnd = new Date(today.getTime() + (config.settings.daysAhead + 1) * DAY_MS);
  return { from, to: monthEnd > agendaEnd ? monthEnd : agendaEnd };
}

// 같은 일정이 여러 캘린더에 들어 있으면(예: 초대받은 회의) 먼저 등록된 소스 것만 남긴다.
function dedupe(events) {
  const seen = new Set();
  return events.filter((e) => {
    const key = `${e.uid}|${e.start}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function refreshAll() {
  if (state.syncing) return;
  state = { ...state, syncing: true };
  broadcast('state:update', publicState());

  const { from, to } = syncRange();
  const sources = config.sources.filter((s) => s.enabled !== false);

  const results = await Promise.allSettled(
    sources.map((src) => fetchSource(src, store.decryptSecret(src.secret), from, to)),
  );

  const events = [];
  const errors = [];
  results.forEach((r, i) => {
    const src = sources[i];
    if (r.status === 'fulfilled') {
      for (const cal of r.value) {
        for (const ev of cal.events) {
          events.push({ ...ev, sourceId: src.id, sourceName: src.name, calendarName: cal.name, color: src.color });
        }
      }
    } else {
      errors.push({ sourceId: src.id, sourceName: src.name, message: r.reason?.message || String(r.reason) });
    }
  });

  // 실패한 소스는 직전 일정을 유지해서 일시적인 네트워크 오류로 위젯이 비지 않게 한다.
  const failed = new Set(errors.map((e) => e.sourceId));
  const kept = state.events.filter((e) => failed.has(e.sourceId));
  const merged = dedupe([...events, ...kept]).sort((a, b) => a.start.localeCompare(b.start));

  state = { events: merged, errors, lastSync: new Date().toISOString(), syncing: false };
  store.writeJson('cache.json', { events: merged, lastSync: state.lastSync });
  broadcast('state:update', publicState());
  checkNotifications();
}

function publicState() {
  return { ...state, sourceCount: config.sources.length, monthsAhead: MONTHS_AHEAD };
}

function broadcast(channel, payload) {
  for (const win of [widget, settingsWin]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

// ---------- 알림 ----------

function checkNotifications() {
  const minutes = config.settings.notifyMinutes;
  if (minutes <= 0 || !Notification.isSupported()) return;
  const now = Date.now();
  for (const ev of state.events) {
    if (ev.allDay) continue;
    const start = Date.parse(ev.start);
    const lead = start - now;
    if (lead < 0 || lead > minutes * 60 * 1000) continue;
    const key = `${ev.sourceId}|${ev.uid}|${ev.start}`;
    if (notified.has(key)) continue;
    notified.add(key);

    const time = new Date(start).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
    const body = [`${time} 시작`, ev.sourceName, ev.location].filter(Boolean).join(' · ');
    const n = new Notification({ title: ev.title, body, icon });
    n.on('click', showWidget);
    n.show();
  }
}

// ---------- IPC ----------

ipcMain.handle('state:get', () => ({ state: publicState(), settings: publicSettings() }));
ipcMain.handle('refresh', () => refreshAll());
ipcMain.handle('settings:open', () => openSettings());
ipcMain.handle('widget:expand', (_e, on) => setExpanded(Boolean(on)));

// 투명 창은 Windows에서 테두리를 끌어 크기를 바꿀 수 없어서, 렌더러의 가장자리 핸들이 계산한 크기를 받아 적용한다.
ipcMain.handle('widget:get-bounds', () => (widget && !widget.isDestroyed() ? widget.getBounds() : null));
ipcMain.on('widget:set-bounds', (_e, b) => {
  if (!widget || widget.isDestroyed() || config.settings.locked) return;
  if (![b?.x, b?.y, b?.width, b?.height].every(Number.isFinite)) return;
  const [minWidth, minHeight] = widget.getMinimumSize();
  widget.setBounds({
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.max(minWidth, Math.round(b.width)),
    height: Math.max(minHeight, Math.round(b.height)),
  });
});

ipcMain.handle('config:get', () => ({
  sources: config.sources.map(store.publicSource),
  settings: publicSettings(),
}));

ipcMain.handle('config:save', (_e, payload) => {
  const prev = config.settings;
  config.sources = sanitizeSources(Array.isArray(payload?.sources) ? payload.sources : config.sources);
  // 크게 보기 상태는 위젯 버튼으로만 바꾼다. 설정 창이 오래된 값을 보내도 덮어쓰지 않는다.
  config.settings = sanitizeSettings({ ...(payload?.settings || {}), expanded: prev.expanded });
  store.save(config);
  applySettings(prev);
  refreshAll();
  return { sources: config.sources.map(store.publicSource), settings: publicSettings() };
});

ipcMain.handle('source:test', async (_e, source) => {
  try {
    const stored = config.sources.find((s) => s.id === source?.id);
    const secret = source?.secret ? String(source.secret).trim() : stored ? store.decryptSecret(stored.secret) : '';
    const result = await testSource({ ...source, type: source?.type === 'caldav' ? 'caldav' : 'ics' }, secret);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, message: err?.message || String(err) };
  }
});
