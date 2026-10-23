'use strict';

// Windows 전용 바탕화면 고정.
// 1) 위젯 창의 소유자(owner)를 바탕화면 창(Progman)으로 바꾸고 맨 아래로 보내서 일반 창들 뒤에 머물게 한다.
// 2) Win+D(바탕화면 보기)를 누르면 바탕화면 레이어가 위젯 위로 올라오므로, 바탕화면이 포그라운드가 될 때
//    위젯 자리를 가리는 창이 바탕화면이면 위젯을 다시 위로 올린다.

const GWLP_HWNDPARENT = -8;
const GA_ROOT = 2;
const HWND_TOP = 0;
const HWND_BOTTOM = 1;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
const EVENT_SYSTEM_FOREGROUND = 0x0003;
const WINEVENT_OUTOFCONTEXT = 0x0000;
const DESKTOP_CLASSES = new Set(['Progman', 'WorkerW']);

let user32 = null;
let koffi = null;

function api() {
  if (user32 !== null) return user32;
  user32 = false;
  if (process.platform !== 'win32') return user32;
  try {
    koffi = require('koffi');
    const lib = koffi.load('user32.dll');
    const POINT = koffi.struct('POINT', { x: 'long', y: 'long' });
    koffi.proto(
      'void __stdcall WinEventProc(intptr_t hook, uint32_t event, intptr_t hwnd, long idObject, long idChild, uint32_t thread, uint32_t time)',
    );
    user32 = {
      FindWindowW: lib.func('intptr_t __stdcall FindWindowW(str16 className, str16 windowName)'),
      SetWindowLongPtrW: lib.func('intptr_t __stdcall SetWindowLongPtrW(intptr_t hwnd, int index, intptr_t value)'),
      SetWindowPos: lib.func(
        'int __stdcall SetWindowPos(intptr_t hwnd, intptr_t after, int x, int y, int cx, int cy, unsigned int flags)',
      ),
      WindowFromPoint: lib.func('intptr_t __stdcall WindowFromPoint(POINT point)'),
      GetAncestor: lib.func('intptr_t __stdcall GetAncestor(intptr_t hwnd, unsigned int flags)'),
      GetClassNameW: lib.func('int __stdcall GetClassNameW(intptr_t hwnd, _Out_ void *buffer, int maxCount)'),
      SetWinEventHook: lib.func(
        'intptr_t __stdcall SetWinEventHook(uint32_t eventMin, uint32_t eventMax, intptr_t hmod, WinEventProc *callback, uint32_t pid, uint32_t tid, uint32_t flags)',
      ),
      UnhookWinEvent: lib.func('int __stdcall UnhookWinEvent(intptr_t hook)'),
    };
  } catch (err) {
    console.error('바탕화면 고정 기능을 불러오지 못했습니다:', err);
  }
  return user32;
}

function hwndOf(win) {
  const buf = win.getNativeWindowHandle();
  return Number(buf.length >= 8 ? buf.readBigUInt64LE(0) : buf.readUInt32LE(0));
}

function classOf(hwnd) {
  const buf = Buffer.alloc(512);
  const n = user32.GetClassNameW(hwnd, buf, 256);
  return n > 0 ? buf.toString('utf16le', 0, n * 2) : '';
}

function isSupported() {
  return Boolean(api());
}

function setZOrder(win, after) {
  const u = api();
  if (!u || win.isDestroyed()) return;
  u.SetWindowPos(hwndOf(win), after, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
}

function sendToBottom(win) {
  setZOrder(win, HWND_BOTTOM);
}

/** 성공하면 true. Explorer가 실행 중이 아니면(Progman 없음) false. */
function attachToDesktop(win) {
  const u = api();
  if (!u || win.isDestroyed()) return false;
  const progman = u.FindWindowW('Progman', null);
  if (!progman) return false;
  u.SetWindowLongPtrW(hwndOf(win), GWLP_HWNDPARENT, progman);
  sendToBottom(win);
  return true;
}

function detachFromDesktop(win) {
  const u = api();
  if (!u || win.isDestroyed()) return;
  u.SetWindowLongPtrW(hwndOf(win), GWLP_HWNDPARENT, 0);
}

// 위젯 가운데 지점의 최상위 창이 바탕화면이면 위젯이 바탕화면 레이어에 가려진 상태다.
function coveredByDesktop(win, screen) {
  const b = win.getBounds();
  const p = screen.dipToScreenPoint({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) });
  const root = user32.GetAncestor(user32.WindowFromPoint({ x: p.x, y: p.y }), GA_ROOT);
  return root !== hwndOf(win) && DESKTOP_CLASSES.has(classOf(root));
}

/**
 * 바탕화면이 포그라운드가 될 때(Win+D, 바탕화면 클릭) 위젯이 가려졌으면 다시 보이게 한다.
 * shouldWatch()가 false면 아무것도 하지 않는다. 해제 함수를 돌려준다.
 */
function watchShowDesktop(getWindow, screen, shouldWatch) {
  const u = api();
  if (!u) return () => {};

  const check = () => {
    const win = getWindow();
    if (!win || win.isDestroyed() || !win.isVisible() || !shouldWatch()) return;
    if (coveredByDesktop(win, screen)) setZOrder(win, HWND_TOP);
  };

  const callback = koffi.register((_hook, _event, hwnd) => {
    if (!DESKTOP_CLASSES.has(classOf(user32.GetAncestor(hwnd, GA_ROOT)))) return;
    // 바탕화면 레이어가 다 올라온 뒤에 확인한다.
    setTimeout(check, 150);
    setTimeout(check, 600);
  }, koffi.pointer('WinEventProc'));
  const hook = u.SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, 0, callback, 0, 0, WINEVENT_OUTOFCONTEXT);

  return () => {
    if (hook) u.UnhookWinEvent(hook);
    koffi.unregister(callback);
  };
}

module.exports = { isSupported, attachToDesktop, detachFromDesktop, sendToBottom, watchShowDesktop };
