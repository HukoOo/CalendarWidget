'use strict';

const { createDAVClient } = require('tsdav');
const { expandIcs } = require('./events');

const TIMEOUT_MS = 30000;

function normalizeUrl(url) {
  return String(url || '').trim().replace(/^webcal:\/\//i, 'https://');
}

function withTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 시간 초과 (${TIMEOUT_MS / 1000}초)`)), TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// tsdav는 서버에 따라 displayName을 문자열 또는 XML 노드 객체로 돌려준다.
function displayNameOf(calendar) {
  const name = calendar.displayName;
  if (typeof name === 'string') return name;
  if (name && typeof name === 'object') return String(name._cdata ?? name._text ?? name.value ?? '');
  return '';
}

async function fetchIcs(url, from, to) {
  const res = await fetch(normalizeUrl(url), {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { Accept: 'text/calendar, */*' },
  });
  // Outlook은 게시가 해제됐거나 링크가 재설정된 캘린더를 오류 페이지
  // (errorFE.aspx?httpCode=404 → olkerror.html?httpCode=404)로 돌려보낸다.
  if (res.redirected && /outlook\.office365\.com\/.*(errorFE\.aspx|olkerror\.html)\?httpCode=404/i.test(res.url)) {
    throw new Error('Outlook에서 이 게시 링크를 찾지 못했습니다. 캘린더 게시가 해제됐거나 링크가 재설정됐을 수 있으니, Outlook에서 다시 게시하고 새 ICS 링크를 넣으세요.');
  }
  if (!res.ok) throw new Error(`ICS 요청 실패 (HTTP ${res.status})`);
  const text = await res.text();
  if (!text.includes('BEGIN:VCALENDAR')) throw new Error('ICS 형식이 아닙니다. 주소를 확인하세요.');
  return [{ name: null, events: expandIcs(text, from, to) }];
}

// tsdav의 내부 오류 문구를 사용자가 조치할 수 있는 안내로 바꾼다.
function explainCalDavError(err) {
  const msg = String(err?.message || err);
  if (/principal|401|403|unauthori[sz]ed|forbidden/i.test(msg)) {
    return new Error('로그인에 실패했거나 CalDAV 서버가 아닙니다. 서버 주소·아이디·비밀번호(앱 비밀번호)를 확인하세요.');
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|fetch failed/i.test(msg)) {
    return new Error(`서버에 연결할 수 없습니다. 주소와 네트워크를 확인하세요. (${msg})`);
  }
  return err instanceof Error ? err : new Error(msg);
}

async function connectCalDav(source, password) {
  let client;
  try {
    client = await withTimeout(
      createDAVClient({
        serverUrl: normalizeUrl(source.url),
        credentials: { username: source.username, password },
        authMethod: 'Basic',
        defaultAccountType: 'caldav',
      }),
      'CalDAV 접속',
    );
  } catch (err) {
    throw explainCalDavError(err);
  }
  const all = await withTimeout(client.fetchCalendars(), 'CalDAV 캘린더 목록');
  const calendars = all.filter((c) => !Array.isArray(c.components) || c.components.includes('VEVENT'));
  return { client, calendars };
}

async function fetchCalDav(source, password, from, to) {
  const { client, calendars } = await connectCalDav(source, password);
  const wanted = (source.calendars || []).filter(Boolean);
  const selected = wanted.length ? calendars.filter((c) => wanted.includes(displayNameOf(c))) : calendars;

  const results = [];
  for (const calendar of selected) {
    let objects;
    try {
      objects = await withTimeout(
        client.fetchCalendarObjects({
          calendar,
          timeRange: { start: from.toISOString(), end: to.toISOString() },
        }),
        'CalDAV 일정 조회',
      );
    } catch {
      // time-range 필터를 지원하지 않는 서버는 전체를 받아 로컬에서 거른다.
      objects = await withTimeout(client.fetchCalendarObjects({ calendar }), 'CalDAV 일정 조회');
    }
    const events = objects.flatMap((o) => (typeof o.data === 'string' ? expandIcs(o.data, from, to) : []));
    results.push({ name: displayNameOf(calendar) || null, events });
  }
  return results;
}

/** 소스 하나에서 [from, to] 범위 일정을 캘린더별로 가져온다. secret은 ICS URL 또는 CalDAV 비밀번호. */
async function fetchSource(source, secret, from, to) {
  if (!secret) throw new Error(source.type === 'ics' ? 'ICS 주소가 없습니다.' : '비밀번호가 없습니다.');
  if (source.type === 'ics') return fetchIcs(secret, from, to);
  if (source.type === 'caldav') return fetchCalDav(source, secret, from, to);
  throw new Error(`알 수 없는 소스 유형: ${source.type}`);
}

/** 설정 화면의 '연결 테스트'용: 캘린더 이름과 앞으로 30일 일정 수를 돌려준다. */
async function testSource(source, secret) {
  const from = new Date();
  const to = new Date(from.getTime() + 30 * 24 * 60 * 60 * 1000);
  if (source.type === 'caldav') {
    if (!secret) throw new Error('비밀번호가 없습니다.');
    const { calendars } = await connectCalDav(source, secret);
    const results = await fetchCalDav(source, secret, from, to);
    return {
      calendars: calendars.map(displayNameOf),
      eventCount: results.reduce((n, r) => n + r.events.length, 0),
    };
  }
  const results = await fetchSource(source, secret, from, to);
  return { calendars: [], eventCount: results[0].events.length };
}

module.exports = { fetchSource, testSource };
