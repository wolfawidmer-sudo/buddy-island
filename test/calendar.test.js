const assert = require('assert');
const { parseICS, expand, wallToMs } = require('../src/calendar');

const now = Date.UTC(2026, 10, 2, 12, 0, 0); // Mo 2. Nov 2026
const ics = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT', 'UID:a', 'SUMMARY:Training', 'LOCATION:Turnhalle\\, Bern',
  'DTSTART;TZID=Europe/Zurich:20260901T180000', 'DTEND;TZID=Europe/Zurich:20260901T193000',
  'RRULE:FREQ=WEEKLY;BYDAY=TU,TH', 'EXDATE;TZID=Europe/Zurich:20261105T180000', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:b', 'SUMMARY:Geburtstag Lea', 'DTSTART;VALUE=DATE:20101104', 'RRULE:FREQ=YEARLY', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:c', 'SUMMARY:Zahnarzt', 'DTSTART:20261103T080000Z', 'DURATION:PT45M', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:d', 'SUMMARY:Abgesagt', 'STATUS:CANCELLED', 'DTSTART:20261103T090000Z', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:e', 'SUMMARY:Teammeeting', 'DTSTART;TZID=W. Europe Standard Time:20261001T090000',
  ' ', 'DTEND;TZID=W. Europe Standard Time:20261001T100000', 'RRULE:FREQ=MONTHLY;BYDAY=1MO', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const events = parseICS(ics);
assert.strictEqual(events.length, 5);
const list = expand(events, now, now + 7 * 864e5);
const fmt = (e) => `${new Date(e.start).toISOString()} ${e.title}`;
const lines = list.map(fmt);
// Training Di 3.11. 18:00 Zürich = 17:00 UTC; Do 5.11. ist ausgenommen; Di 10.? ausserhalb (7 Tage bis 9.11.)
assert.ok(lines.includes('2026-11-03T17:00:00.000Z Training'), lines.join('\n'));
assert.ok(!lines.some((l) => l.startsWith('2026-11-05T17:00:00.000Z')), 'EXDATE');
assert.ok(lines.some((l) => l.endsWith('Geburtstag Lea') && l.startsWith('2026-11-0')), 'Geburtstag');
assert.ok(lines.includes('2026-11-03T08:00:00.000Z Zahnarzt'));
assert.ok(!lines.some((l) => l.includes('Abgesagt')));
// 1. Montag im Dezember = 7.12. -> ausserhalb; im November = 2.11. 09:00 Zürich = 08:00 UTC (liegt vor "now" 12:00, Ende 09:00 UTC -> ausserhalb)
assert.ok(!lines.some((l) => l.includes('Teammeeting')));
const nov = expand(events, Date.UTC(2026, 10, 1), Date.UTC(2026, 10, 30));
assert.ok(nov.some((e) => e.title === 'Teammeeting' && new Date(e.start).toISOString() === '2026-11-02T08:00:00.000Z'), nov.map(fmt).join('\n'));
assert.strictEqual(list.find((e) => e.title === 'Training').location, 'Turnhalle, Bern');
// Sommerzeit: 1. Sept 18:00 Zürich = 16:00 UTC
assert.strictEqual(new Date(wallToMs({ y: 2026, m: 8, d: 1, h: 18, mi: 0, s: 0 }, 'Europe/Zurich')).toISOString(), '2026-09-01T16:00:00.000Z');
console.log('Kalender-Tests ok');
