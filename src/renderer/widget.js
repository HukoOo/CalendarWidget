'use strict';

const api = window.calendarApi;
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const DAY_MS = 24 * 60 * 60 * 1000;
const VIEW_KEY = 'calendar-widget.view';
const WIDE_MIN = 520; // 이 너비부터 달력 칸에 점 대신 일정 제목을 표시한다.
const SIDE_MIN = 760; // 이 너비부터 선택한 날의 일정을 달력 오른쪽에 붙인다.
const MAX_CHIPS = 8; // 칸 하나에 만들어 두는 최대 칩 수 (넘치는 것은 fitChips가 숨긴다)

let state = { events: [], errors: [], lastSync: null, syncing: false, sourceCount: 0, monthsAhead: 2 };
let settings = { daysAhead: 14, opacity: 0.92, locked: false };
let view = readView(); // 'agenda' | 'month'
let monthCursor = firstOfMonth(new Date());
let selectedDay = startOfDay(new Date());

const $ = (id) => document.getElementById(id);

// 보기 선택은 이 PC에서만 기억하면 되는 편의 기능이라 localStorage에 둔다. 실패해도 목록 보기로 동작한다.
function readView() {
  try {
    return localStorage.getItem(VIEW_KEY) === 'month' ? 'month' : 'agenda';
  } catch {
    return 'agenda';
  }
}

function saveView() {
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    // 저장 못 해도 현재 세션에서는 그대로 쓴다.
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text; // 일정 제목 등은 외부 데이터이므로 항상 textContent로 넣는다.
  return node;
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function firstOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function dateKey(date) {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${m}-${d}`;
}

function fmtTime(date) {
  return date.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
}

// 종일 일정은 날짜 문자열로, 시간 일정은 실제 시각으로 그날과 겹치는지 판단한다.
function occursOn(ev, day, next) {
  if (ev.allDay) {
    const key = dateKey(day);
    return ev.startDate <= key && key < ev.endDate;
  }
  const s = new Date(ev.start);
  const e = new Date(ev.end);
  if (s.getTime() === e.getTime()) return s >= day && s < next;
  return s < next && e > day;
}

function eventsOn(day) {
  const next = addDays(day, 1);
  const byOrder = (a, b) => (a.allDay === b.allDay ? a.start.localeCompare(b.start) : a.allDay ? -1 : 1);
  return state.events.filter((ev) => occursOn(ev, day, next)).sort(byOrder);
}

function timeLabel(ev, day, next) {
  if (ev.allDay) return '종일';
  const s = new Date(ev.start);
  const e = new Date(ev.end);
  const startsHere = s >= day;
  const endsHere = e <= next;
  if (startsHere && endsHere) return s.getTime() === e.getTime() ? fmtTime(s) : `${fmtTime(s)} – ${fmtTime(e)}`;
  if (startsHere) return `${fmtTime(s)} –`;
  if (endsHere) return `– ${fmtTime(e)}`;
  return '하루 종일';
}

function dayLabel(day, today) {
  const offset = Math.round((day - today) / DAY_MS);
  const base = `${day.getMonth() + 1}월 ${day.getDate()}일 (${WEEKDAYS[day.getDay()]})`;
  if (offset === 0) return `오늘 · ${base}`;
  if (offset === 1) return `내일 · ${base}`;
  if (offset === -1) return `어제 · ${base}`;
  return base;
}

function relativeTime(iso) {
  const diff = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (diff < 1) return '방금';
  if (diff < 60) return `${diff}분 전`;
  return `${Math.floor(diff / 60)}시간 전`;
}

function renderEvent(ev, day, now) {
  const next = addDays(day, 1);
  const row = el('div', 'event');
  row.style.setProperty('--c', ev.color || '#3b82f6');
  if (!ev.allDay) {
    const s = new Date(ev.start);
    const e = new Date(ev.end);
    if (e <= now && e.getTime() !== s.getTime()) row.classList.add('past');
    else if (s <= now && now < e) row.classList.add('now');
  }

  const body = el('div');
  body.append(el('div', 'time', timeLabel(ev, day, next)), el('div', 'title', ev.title));
  const meta = [ev.location, ev.calendarName || ev.sourceName].filter(Boolean).join(' · ');
  if (meta) body.append(el('div', 'meta', meta));

  row.title = [ev.title, ev.location, ev.description].filter(Boolean).join('\n').slice(0, 500);
  row.append(el('div', 'bar'), body);
  return row;
}

function renderDay(day, today, now) {
  const section = el('section', day.getTime() === today.getTime() ? 'day is-today' : 'day');
  section.append(el('div', 'day-label', dayLabel(day, today)));
  const items = eventsOn(day);
  if (items.length === 0) section.append(el('div', 'empty', '일정 없음'));
  for (const ev of items) section.append(renderEvent(ev, day, now));
  return section;
}

// ---------- 목록 보기 ----------

function renderAgenda(container, now) {
  const today = startOfDay(now);
  for (let i = 0; i < settings.daysAhead; i++) {
    const day = addDays(today, i);
    if (i > 1 && eventsOn(day).length === 0) continue; // 오늘·내일은 비어 있어도 표시한다.
    container.append(renderDay(day, today, now));
  }
}

// ---------- 월간 보기 ----------

function monthBounds(today) {
  const min = firstOfMonth(today);
  const max = new Date(min.getFullYear(), min.getMonth() + (state.monthsAhead ?? 2), 1);
  return { min, max };
}

function navButton(label, title, disabled, onClick) {
  const btn = el('button', 'icon-btn nav-btn', label);
  btn.title = title;
  btn.disabled = disabled;
  btn.addEventListener('click', onClick);
  return btn;
}

function chipFor(ev) {
  const chip = el('div', ev.allDay ? 'chip all-day' : 'chip');
  chip.style.setProperty('--c', ev.color || '#3b82f6');
  const time = ev.allDay ? '' : `${fmtTime(new Date(ev.start))} `;
  chip.textContent = `${time}${ev.title}`;
  return chip;
}

// 마지막으로 보이는 칩이 칸 아래 경계를 넘는지 본다. 1fr 행 높이는 소수점이라 scrollHeight 비교만으로는 1~2px 잘린다.
function overflowing(cell) {
  const visible = [...cell.querySelectorAll('.chip')].filter((n) => !n.hidden);
  const last = visible[visible.length - 1];
  return Boolean(last) && last.getBoundingClientRect().bottom > cell.getBoundingClientRect().bottom - 2;
}

// 칸 높이에 맞춰 넘치는 칩을 뒤에서부터 숨기고 "+n개"로 바꾼다. 레이아웃이 잡힌 뒤에 불러야 한다.
function fitChips(root) {
  for (const cell of root.querySelectorAll('.cell.wide')) {
    const chips = [...cell.querySelectorAll('.chip')];
    const more = cell.querySelector('.more-count');
    let hidden = Number(cell.dataset.extra);
    for (const chip of chips) chip.hidden = false;
    const showMore = () => {
      more.hidden = hidden === 0;
      more.textContent = `+${hidden}개`;
    };
    showMore();
    for (let i = chips.length - 1; i >= 0 && overflowing(cell); i--) {
      chips[i].hidden = true;
      hidden++;
      showMore();
    }
  }
}

function renderMonth(container, now) {
  const width = window.innerWidth;
  const wide = width >= WIDE_MIN;
  container.classList.toggle('month-wide', wide);
  container.classList.toggle('month-side', width >= SIDE_MIN);
  const today = startOfDay(now);
  const { min, max } = monthBounds(today);
  if (monthCursor < min) monthCursor = min;
  if (monthCursor > max) monthCursor = max;

  const shiftMonth = (n) => {
    monthCursor = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + n, 1);
    selectedDay = monthCursor.getTime() === min.getTime() ? today : monthCursor;
    render();
  };

  const nav = el('div', 'month-nav');
  const goToday = el('button', 'today-btn', '오늘');
  goToday.addEventListener('click', () => {
    monthCursor = min;
    selectedDay = today;
    render();
  });
  nav.append(
    navButton('‹', '이전 달', monthCursor <= min, () => shiftMonth(-1)),
    el('div', 'month-title', `${monthCursor.getFullYear()}년 ${monthCursor.getMonth() + 1}월`),
    navButton('›', '다음 달', monthCursor >= max, () => shiftMonth(1)),
    goToday,
  );

  const head = el('div', 'weekdays');
  WEEKDAYS.forEach((w, i) => head.append(el('div', i === 0 ? 'sun' : i === 6 ? 'sat' : '', w)));

  const grid = el('div', 'month-grid');
  const first = addDays(monthCursor, -monthCursor.getDay());
  const daysInMonth = new Date(monthCursor.getFullYear(), monthCursor.getMonth() + 1, 0).getDate();
  const weeks = Math.ceil((monthCursor.getDay() + daysInMonth) / 7);

  for (let i = 0; i < weeks * 7; i++) {
    const day = addDays(first, i);
    const cell = el('button', 'cell');
    if (day.getMonth() !== monthCursor.getMonth()) cell.classList.add('other');
    if (day.getTime() === today.getTime()) cell.classList.add('today');
    if (day.getTime() === selectedDay.getTime()) cell.classList.add('selected');
    if (day.getDay() === 0) cell.classList.add('sun');
    if (day.getDay() === 6) cell.classList.add('sat');

    const items = eventsOn(day);
    cell.title = items.map((ev) => ev.title).join('\n');
    const num = el('span', 'num', String(day.getDate()));
    if (wide) {
      // "+n개"는 날짜 옆에 둬서 칩 자리를 하나라도 더 확보한다.
      cell.classList.add('wide');
      cell.dataset.extra = String(Math.max(0, items.length - MAX_CHIPS));
      const head = el('div', 'cell-head');
      head.append(num, el('span', 'more-count'));
      const chips = el('div', 'chips');
      for (const ev of items.slice(0, MAX_CHIPS)) chips.append(chipFor(ev));
      cell.append(head, chips);
    } else {
      cell.append(num);
      const dots = el('div', 'dots');
      for (const ev of items.slice(0, 3)) {
        const dot = el('span', 'dot');
        dot.style.setProperty('--c', ev.color || '#3b82f6');
        dots.append(dot);
      }
      if (items.length > 3) dots.append(el('span', 'more', '+'));
      cell.append(dots);
    }

    cell.addEventListener('click', () => {
      selectedDay = day;
      if (day.getMonth() !== monthCursor.getMonth()) monthCursor = firstOfMonth(day);
      render();
    });
    grid.append(cell);
  }

  const calendar = el('div', 'month-cal');
  calendar.append(head, grid);
  const body = el('div', 'month-body');
  body.append(calendar, renderDay(selectedDay, today, now));
  container.append(nav, body);
  if (wide) requestAnimationFrame(() => fitChips(grid));
}

// ---------- 전체 ----------

function renderBody(now) {
  const list = $('list');
  list.replaceChildren();
  list.classList.remove('month-wide', 'month-side');

  if (state.sourceCount === 0) {
    const hint = el('div', 'hint', '연결된 캘린더가 없습니다.');
    const btn = el('button', null, '캘린더 추가');
    btn.addEventListener('click', () => api.openSettings());
    hint.append(el('br'), btn);
    list.append(hint);
    return;
  }

  if (view === 'month') renderMonth(list, now);
  else renderAgenda(list, now);
}

function render() {
  const now = new Date();
  $('today-day').textContent = now.getDate();
  $('today-sub').textContent = `${now.getFullYear()}년 ${now.getMonth() + 1}월 · ${WEEKDAYS[now.getDay()]}요일`;

  document.documentElement.style.setProperty('--alpha', settings.opacity);
  document.body.classList.toggle('locked', Boolean(settings.locked));
  $('btn-refresh').classList.toggle('spin', Boolean(state.syncing));
  $('btn-view').textContent = view === 'month' ? '☰' : '▦';
  $('btn-view').title = view === 'month' ? '목록 보기' : '월간 보기';
  $('btn-expand').textContent = settings.expanded ? '⤡' : '⤢';
  $('btn-expand').title = settings.expanded ? '작게 보기' : '크게 보기';

  renderBody(now);

  $('status').textContent = state.syncing
    ? '동기화 중…'
    : state.lastSync
      ? `${relativeTime(state.lastSync)} 동기화`
      : '';

  const errBtn = $('btn-errors');
  errBtn.hidden = state.errors.length === 0;
  errBtn.textContent = `⚠ ${state.errors.length}개 캘린더 오류`;
  errBtn.title = state.errors.map((e) => `${e.sourceName}: ${e.message}`).join('\n');
}

$('btn-view').addEventListener('click', () => {
  view = view === 'month' ? 'agenda' : 'month';
  saveView();
  render();
});
$('btn-expand').addEventListener('click', () => {
  const expand = !settings.expanded;
  // 크게 볼 때는 달력이 목적이므로 월간 보기로 바꾼다.
  if (expand && view !== 'month') {
    view = 'month';
    saveView();
  }
  api.setExpanded(expand);
});
$('btn-refresh').addEventListener('click', () => api.refresh());

// ---------- 크기 조절 핸들 ----------
// 투명 창은 Windows에서 테두리 크기 조절이 안 되므로 가장자리·모서리에 핸들을 두고 직접 계산한다.
// 화면 좌표(screenX/Y)와 창 bounds는 둘 다 DIP 단위라 그대로 더하고 뺄 수 있다.
const MIN_W = 260;
const MIN_H = 200;

function startResize(e) {
  if (settings.locked || e.button !== 0) return;
  e.preventDefault();
  const handle = e.currentTarget;
  const dir = handle.dataset.dir;
  handle.setPointerCapture(e.pointerId); // 포인터가 창 밖으로 나가도 계속 이벤트를 받는다.
  const sx = e.screenX;
  const sy = e.screenY;
  let start = null;

  const move = (ev) => {
    if (!start) return;
    const dx = ev.screenX - sx;
    const dy = ev.screenY - sy;
    let { x, y, width, height } = start;
    if (dir.includes('e')) width += dx;
    if (dir.includes('s')) height += dy;
    if (dir.includes('w')) {
      width -= dx;
      x += dx;
    }
    if (dir.includes('n')) {
      height -= dy;
      y += dy;
    }
    // 최소 크기에 걸리면 반대쪽 가장자리가 밀려나지 않게 위치를 되돌린다.
    if (width < MIN_W) {
      if (dir.includes('w')) x -= MIN_W - width;
      width = MIN_W;
    }
    if (height < MIN_H) {
      if (dir.includes('n')) y -= MIN_H - height;
      height = MIN_H;
    }
    // pointermove는 Chromium이 이미 프레임 단위로 묶어 보낸다. requestAnimationFrame은 창이 가려지면 멈추므로 쓰지 않는다.
    api.setBounds({ x, y, width, height });
  };
  const end = () => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', end);
    handle.removeEventListener('pointercancel', end);
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  api.getBounds().then((b) => {
    start = b;
  });
}

for (const dir of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
  const handle = el('div', `resize resize-${dir}`);
  handle.dataset.dir = dir;
  handle.addEventListener('pointerdown', startResize);
  document.body.append(handle);
}

// 창 크기가 바뀌면 칸 크기·레이아웃이 달라지므로 다시 그린다.
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(render, 100);
});
$('btn-settings').addEventListener('click', () => api.openSettings());
$('btn-errors').addEventListener('click', () => api.openSettings());

api.onState((next) => {
  state = next;
  render();
});
api.onSettings((next) => {
  settings = next;
  render();
});

api.getState().then((initial) => {
  state = initial.state;
  settings = initial.settings;
  render();
});

// 1분마다 다시 그려서 지난 일정 흐리게 하기, 날짜 바뀜 등을 반영한다.
setInterval(() => {
  const today = startOfDay(new Date());
  if (selectedDay < firstOfMonth(today)) selectedDay = today;
  render();
}, 60 * 1000);
