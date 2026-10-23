'use strict';

const ical = require('node-ical');

const DAY_MS = 24 * 60 * 60 * 1000;

function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && 'val' in value) return String(value.val);
  return String(value);
}

// 종일 일정은 node-ical이 로컬 자정 Date로 돌려주므로 날짜 부분만 'YYYY-MM-DD'로 보존한다.
function localDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * ICS 텍스트를 파싱해 [from, to] 범위와 겹치는 일정 인스턴스 목록을 돌려준다.
 * 반복 일정(RRULE), 예외일(EXDATE), 개별 수정본(RECURRENCE-ID)을 모두 반영한다.
 */
function expandIcs(icsText, from, to) {
  const data = ical.sync.parseICS(icsText);
  const out = [];

  for (const key of Object.keys(data)) {
    const ev = data[key];
    if (!ev || ev.type !== 'VEVENT' || !ev.start) continue;

    let instances;
    try {
      instances = ical.expandRecurringEvent(ev, { from, to, expandOngoing: true });
    } catch {
      continue; // 깨진 RRULE 하나 때문에 캘린더 전체가 실패하지 않도록 건너뛴다.
    }

    for (const inst of instances) {
      const src = inst.event || ev;
      if (String(src.status || '').toUpperCase() === 'CANCELLED') continue;

      const start = new Date(inst.start);
      let end = inst.end ? new Date(inst.end) : null;
      if (!end || end <= start) end = new Date(start.getTime() + (inst.isFullDay ? DAY_MS : 0));
      if (end < from || start > to) continue;

      out.push({
        uid: textOf(src.uid) || key,
        title: textOf(src.summary) || '(제목 없음)',
        location: textOf(src.location),
        description: textOf(src.description),
        allDay: Boolean(inst.isFullDay),
        start: start.toISOString(),
        end: end.toISOString(),
        startDate: inst.isFullDay ? localDateKey(start) : null,
        endDate: inst.isFullDay ? localDateKey(end) : null, // exclusive
      });
    }
  }
  return out;
}

module.exports = { expandIcs, localDateKey };
