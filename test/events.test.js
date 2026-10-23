'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { expandIcs } = require('../src/lib/events');

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//EN
BEGIN:VTIMEZONE
TZID:Asia/Seoul
BEGIN:STANDARD
DTSTART:19700101T000000
TZOFFSETFROM:+0900
TZOFFSETTO:+0900
TZNAME:KST
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:weekly-1
DTSTART;TZID=Asia/Seoul:20261005T100000
DTEND;TZID=Asia/Seoul:20261005T110000
RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=6
EXDATE;TZID=Asia/Seoul:20261019T100000
SUMMARY:주간 회의
END:VEVENT
BEGIN:VEVENT
UID:weekly-1
RECURRENCE-ID;TZID=Asia/Seoul:20261026T100000
DTSTART;TZID=Asia/Seoul:20261026T140000
DTEND;TZID=Asia/Seoul:20261026T150000
SUMMARY:주간 회의 (시간 변경)
END:VEVENT
BEGIN:VEVENT
UID:allday-1
DTSTART;VALUE=DATE:20261023
DTEND;VALUE=DATE:20261025
SUMMARY:워크숍
END:VEVENT
BEGIN:VEVENT
UID:cancel-1
DTSTART:20261024T010000Z
DTEND:20261024T020000Z
STATUS:CANCELLED
SUMMARY:취소됨
END:VEVENT
END:VCALENDAR`;

test('반복/예외/수정본/종일/취소 처리', () => {
  const from = new Date('2026-10-01T00:00:00+09:00');
  const to = new Date('2026-11-30T00:00:00+09:00');
  const evs = expandIcs(ICS, from, to).sort((a, b) => a.start.localeCompare(b.start));

  const weekly = evs.filter((e) => e.uid === 'weekly-1');
  // 10/5, 10/12, (10/19 EXDATE), 10/26 변경, 11/2, 11/9 → 5개
  assert.equal(weekly.length, 5);
  assert.equal(weekly[0].start, '2026-10-05T01:00:00.000Z'); // 10:00 KST
  const moved = weekly.find((e) => e.title.includes('시간 변경'));
  assert.equal(moved.start, '2026-10-26T05:00:00.000Z'); // 14:00 KST
  assert.ok(!weekly.some((e) => e.start.startsWith('2026-10-19')));

  const allDay = evs.find((e) => e.uid === 'allday-1');
  assert.equal(allDay.allDay, true);
  assert.equal(allDay.startDate, '2026-10-23');
  assert.equal(allDay.endDate, '2026-10-25');

  assert.ok(!evs.some((e) => e.uid === 'cancel-1'));
});
