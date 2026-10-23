'use strict';

const api = window.calendarApi;

const PRESETS = {
  google: {
    type: 'ics',
    name: 'Google 캘린더',
    color: '#4285f4',
    help:
      'Google 캘린더(웹) → 왼쪽 목록에서 캘린더의 ⋮ → "설정 및 공유" → "캘린더 통합" → "iCal 형식의 비공개 주소"를 복사해 붙여 넣으세요.\n' +
      '이 주소만 있으면 누구나 일정을 볼 수 있으니 다른 사람과 공유하지 마세요. 캘린더마다 따로 추가해야 합니다.',
  },
  outlook: {
    type: 'ics',
    name: 'Outlook',
    color: '#0078d4',
    help:
      'Outlook(웹) → 설정 → 캘린더 → "공유 캘린더" → "캘린더 게시"에서 캘린더와 "모든 세부 정보 보기"를 고르고 게시 → ICS 링크를 복사하세요.\n' +
      '회사·학교 계정은 관리자가 게시를 막아 두었을 수 있습니다.',
  },
  naver: {
    type: 'caldav',
    name: '네이버 캘린더',
    color: '#03c75a',
    url: 'https://caldav.calendar.naver.com/',
    help:
      '아이디에는 네이버 아이디를, 비밀번호에는 네이버 비밀번호를 넣으세요.\n' +
      '2단계 인증을 쓰고 있다면 네이버 보안설정에서 "애플리케이션 비밀번호"를 발급받아 입력해야 합니다.',
  },
  icloud: {
    type: 'caldav',
    name: 'iCloud',
    color: '#a855f7',
    url: 'https://caldav.icloud.com/',
    help: '아이디에는 Apple ID 이메일을, 비밀번호에는 appleid.apple.com → 로그인 및 보안 → "앱 암호"에서 만든 암호를 넣으세요.',
  },
  ics: {
    type: 'ics',
    name: 'ICS 구독',
    color: '#f97316',
    help: '.ics 파일 주소(https:// 또는 webcal://)를 붙여 넣으세요. 공휴일 캘린더 같은 공개 구독 주소도 됩니다.',
  },
  caldav: {
    type: 'caldav',
    name: 'CalDAV',
    color: '#64748b',
    url: '',
    help: 'CalDAV 서버 주소와 계정 정보를 넣으세요. 연결 테스트로 찾은 캘린더 이름을 "가져올 캘린더"에 적으면 그것만 가져옵니다.',
  },
};

let sources = [];
let settings = {};
let editing = null; // { index, preset, hasSecret }

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// ---------- 저장 ----------

async function persist() {
  const result = await api.saveConfig({ sources, settings });
  sources = result.sources;
  settings = result.settings;
  renderSources();
  renderGeneral();
}

// ---------- 캘린더 목록 ----------

function renderSources() {
  const list = $('source-list');
  list.replaceChildren();
  $('no-sources').hidden = sources.length > 0;

  sources.forEach((src, index) => {
    const li = el('li');
    const swatch = el('span', 'swatch');
    swatch.style.background = src.color;

    const enabled = el('input');
    enabled.type = 'checkbox';
    enabled.checked = src.enabled !== false;
    enabled.title = '사용';
    enabled.addEventListener('change', async () => {
      sources[index] = { ...src, enabled: enabled.checked };
      await persist();
    });

    const edit = el('button', 'small', '편집');
    edit.addEventListener('click', () => openEditor(index));

    const remove = el('button', 'small', '삭제');
    remove.addEventListener('click', async () => {
      if (!confirm(`'${src.name}' 캘린더를 삭제할까요?`)) return;
      sources.splice(index, 1);
      if (editing && editing.index === index) closeEditor();
      await persist();
    });

    li.append(enabled, swatch, el('span', 'src-name', src.name), el('span', 'badge', src.type === 'caldav' ? 'CalDAV' : 'ICS'), edit, remove);
    list.append(li);
  });
}

// ---------- 편집기 ----------

function setTypeVisibility(type) {
  for (const node of document.querySelectorAll('.ics-only')) node.hidden = type !== 'ics';
  for (const node of document.querySelectorAll('.caldav-only')) node.hidden = type !== 'caldav';
}

function openEditor(index, presetKey) {
  const existing = index >= 0 ? sources[index] : null;
  const preset = PRESETS[existing ? existing.preset || existing.type : presetKey] || PRESETS.ics;
  const src = existing || { type: preset.type, name: preset.name, color: preset.color, url: preset.url || '', username: '', calendars: [] };

  editing = { index, preset: existing ? existing.preset || existing.type : presetKey, type: src.type, hasSecret: Boolean(existing && existing.hasSecret) };

  $('editor-title').textContent = existing ? `'${existing.name}' 편집` : `${preset.name} 추가`;
  $('editor-help').textContent = preset.help;
  $('f-name').value = src.name;
  $('f-color').value = src.color;
  $('f-url').value = src.url || '';
  $('f-user').value = src.username || '';
  $('f-cals').value = (src.calendars || []).join(', ');
  $('f-ics').value = '';
  $('f-pass').value = '';
  const keep = editing.hasSecret ? '저장됨 — 바꿀 때만 입력' : '';
  $('f-ics').placeholder = keep || 'https://… 또는 webcal://…';
  $('f-pass').placeholder = keep;
  setTypeVisibility(src.type);
  showTestResult('', '');

  $('editor').hidden = false;
  $('editor').scrollIntoView({ behavior: 'smooth' });
  $('f-name').focus();
}

function closeEditor() {
  editing = null;
  $('editor').hidden = true;
}

function readEditor() {
  const type = editing.type;
  const existing = editing.index >= 0 ? sources[editing.index] : null;
  const secret = type === 'ics' ? $('f-ics').value.trim() : $('f-pass').value;
  const draft = {
    id: existing ? existing.id : '',
    preset: editing.preset,
    type,
    name: $('f-name').value.trim(),
    color: $('f-color').value,
    enabled: existing ? existing.enabled !== false : true,
    url: $('f-url').value.trim(),
    username: $('f-user').value.trim(),
    calendars: $('f-cals').value.split(',').map((s) => s.trim()).filter(Boolean),
  };
  if (secret) draft.secret = secret;
  return draft;
}

function validate(draft) {
  if (!draft.name) return '이름을 입력하세요.';
  const hasSecret = Boolean(draft.secret) || editing.hasSecret;
  if (draft.type === 'ics') {
    if (!hasSecret) return 'ICS 주소를 입력하세요.';
    if (draft.secret && !/^(https?|webcal):\/\//i.test(draft.secret)) return 'ICS 주소는 https:// 또는 webcal://로 시작해야 합니다.';
  } else {
    if (!/^https?:\/\//i.test(draft.url)) return '서버 주소는 https://로 시작해야 합니다.';
    if (!draft.username) return '아이디를 입력하세요.';
    if (!hasSecret) return '비밀번호를 입력하세요.';
  }
  return null;
}

function showTestResult(kind, text) {
  const box = $('test-result');
  box.className = `test-result ${kind}`;
  box.textContent = text;
}

$('btn-add').addEventListener('click', () => openEditor(-1, $('add-preset').value));
$('btn-cancel').addEventListener('click', closeEditor);

$('btn-test').addEventListener('click', async () => {
  const draft = readEditor();
  const problem = validate(draft);
  if (problem) return showTestResult('err', problem);

  const button = $('btn-test');
  button.disabled = true;
  showTestResult('', '연결하는 중…');
  try {
    const res = await api.testSource(draft);
    if (!res.ok) return showTestResult('err', `실패: ${res.message}`);
    const lines = [`성공: 앞으로 30일 동안 일정 ${res.eventCount}개`];
    if (res.calendars.length) lines.push(`발견된 캘린더: ${res.calendars.join(', ')}`);
    showTestResult('ok', lines.join('\n'));
  } finally {
    button.disabled = false;
  }
});

$('btn-save').addEventListener('click', async () => {
  const draft = readEditor();
  const problem = validate(draft);
  if (problem) return showTestResult('err', problem);

  if (editing.index >= 0) sources[editing.index] = draft;
  else sources.push(draft);
  closeEditor();
  await persist();
});

// ---------- 일반 설정 ----------

function renderGeneral() {
  $('g-refresh').value = settings.refreshMinutes;
  $('g-days').value = settings.daysAhead;
  $('g-notify').value = settings.notifyMinutes;
  $('g-opacity').value = settings.opacity;
  $('g-opacity-val').textContent = `${Math.round(settings.opacity * 100)}%`;
  $('g-placement').querySelector('option[value="desktop"]').disabled = !settings.desktopSupported;
  $('g-placement').value = settings.placement;
  $('g-lock').checked = settings.locked;
  $('g-login').checked = settings.launchAtLogin;
}

$('g-opacity').addEventListener('input', () => {
  $('g-opacity-val').textContent = `${Math.round($('g-opacity').value * 100)}%`;
});

$('btn-general').addEventListener('click', async () => {
  settings = {
    ...settings,
    refreshMinutes: Number($('g-refresh').value),
    daysAhead: Number($('g-days').value),
    notifyMinutes: Number($('g-notify').value),
    opacity: Number($('g-opacity').value),
    placement: $('g-placement').value,
    locked: $('g-lock').checked,
    launchAtLogin: $('g-login').checked,
  };
  await persist();
  $('general-saved').textContent = '저장했습니다.';
  setTimeout(() => ($('general-saved').textContent = ''), 2000);
});

// ---------- 동기화 상태 ----------

function renderSync(state) {
  $('sync-status').textContent = state.syncing
    ? '동기화 중…'
    : state.lastSync
      ? `마지막 동기화: ${new Date(state.lastSync).toLocaleString('ko-KR')} · 일정 ${state.events.length}개`
      : '아직 동기화하지 않았습니다.';
  const list = $('sync-errors');
  list.replaceChildren(...state.errors.map((e) => el('li', null, `${e.sourceName}: ${e.message}`)));
}

api.onState(renderSync);
api.onSettings((next) => {
  settings = { ...settings, ...next };
  renderGeneral();
});

(async () => {
  const config = await api.getConfig();
  sources = config.sources;
  settings = config.settings;
  renderSources();
  renderGeneral();
  renderSync((await api.getState()).state);
})();
