/*
 * Builds calendar entries from parsed exams:
 *   - an .ics file (Apple/iOS Calendar, Outlook, and Google Calendar import)
 *   - "Add to Google Calendar" links (one per exam)
 *
 * All times on tentamen.bth.se are Swedish local time, so events are written
 * with TZID=Europe/Stockholm. Exams without a published time become all-day
 * events.
 *
 * Works in the browser (globalThis.BthCalendar) and in Node.
 */
(function (root) {
  'use strict';

  var TZ = 'Europe/Stockholm';
  var SOURCE_URL = 'https://tentamen.bth.se/';

  var VTIMEZONE = [
    'BEGIN:VTIMEZONE',
    'TZID:Europe/Stockholm',
    'BEGIN:DAYLIGHT',
    'TZOFFSETFROM:+0100',
    'TZOFFSETTO:+0200',
    'TZNAME:CEST',
    'DTSTART:19700329T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    'TZOFFSETFROM:+0200',
    'TZOFFSETTO:+0100',
    'TZNAME:CET',
    'DTSTART:19701025T030000',
    'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
    'END:STANDARD',
    'END:VTIMEZONE'
  ];

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function compactDate(d) { return d.replace(/-/g, ''); }

  function compactDateTime(d, t) { return compactDate(d) + 'T' + t.replace(':', '') + '00'; }

  function nextDay(d) {
    var p = d.split('-').map(Number);
    var dt = new Date(Date.UTC(p[0], p[1] - 1, p[2] + 1));
    return dt.getUTCFullYear() + '-' + pad(dt.getUTCMonth() + 1) + '-' + pad(dt.getUTCDate());
  }

  function hasTime(e) { return !!(e.start && e.end); }

  function title(e) {
    var t = 'Exam: ' + e.courseCode;
    if (e.courseName) t += ' ' + e.courseName;
    if (e.moduleName) t += ' (' + e.moduleName + ')';
    return t;
  }

  function description(e) {
    var lines = [];
    if (e.courseCode || e.courseName) lines.push('Course: ' + [e.courseCode, e.courseName].filter(Boolean).join(' '));
    if (e.moduleCode || e.moduleName) lines.push('Module: ' + [e.moduleCode, e.moduleName].filter(Boolean).join(' '));
    if (!hasTime(e)) lines.push('Time: not published yet (check tentamen.bth.se)');
    if (e.responsible) lines.push('Responsible: ' + e.responsible);
    if (e.email) lines.push('E-mail: ' + e.email);
    if (e.signupStart) lines.push('Sign up period: ' + e.signupStart + ' - ' + e.signupEnd);
    if (e.status === 'registered') lines.push('Status: registered');
    else if (e.status === 'signup' || e.status === 'upcoming') lines.push('Status: NOT registered yet. Remember to sign up!');
    lines.push('Source: ' + SOURCE_URL);
    return lines.join('\n');
  }

  function uid(e, kind) {
    var id = [kind || 'exam', e.courseCode, e.moduleCode || e.moduleName, e.date].join('-')
      .replace(/[^A-Za-z0-9-]+/g, '');
    return id + '@tentamen.bth.se';
  }

  /** Returns event descriptors (exam itself, plus optional sign-up reminder). */
  function eventsFor(exams, opts) {
    opts = opts || {};
    var out = [];
    exams.forEach(function (e) {
      out.push({
        uid: uid(e, 'exam'),
        summary: title(e),
        description: description(e),
        location: e.place || '',
        date: e.date,
        start: hasTime(e) ? e.start : '',
        end: hasTime(e) ? e.end : '',
        alarmMinutes: opts.reminderMinutes || 0
      });
      if (opts.signupReminders && e.status !== 'registered' && e.signupStart) {
        out.push({
          uid: uid(e, 'signup'),
          summary: 'Sign up opens: ' + e.courseCode + (e.courseName ? ' ' + e.courseName : ''),
          description: 'Sign up for the exam on ' + e.date + ' (' + (e.moduleName || '') + ').\n' +
            'Sign up period: ' + e.signupStart + ' - ' + e.signupEnd + '\n' + SOURCE_URL,
          location: '',
          date: e.signupStart,
          start: '',
          end: '',
          alarmMinutes: 0
        });
      }
    });
    return out;
  }

  // ------------------------------------------------------------------ ICS

  function icsEscape(s) {
    return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  }

  // Fold lines at 75 octets (RFC 5545 3.1), without splitting UTF-8 characters.
  function fold(line) {
    var out = [];
    var cur = '';
    var bytes = 0;
    var limit = 75;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      var code = line.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < line.length) { ch += line[++i]; }
      var b = unescape(encodeURIComponent(ch)).length;
      if (bytes + b > limit) {
        out.push(cur);
        cur = ' ';
        bytes = 1;
      }
      cur += ch;
      bytes += b;
    }
    out.push(cur);
    return out.join('\r\n');
  }

  function stamp(now) {
    var d = now || new Date();
    return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' +
      pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
  }

  function buildIcs(exams, opts) {
    return icsFromEvents(eventsFor(exams, opts), opts);
  }

  /**
   * One VCALENDAR holding the given event descriptors. With opts.caldav the
   * file is written as a CalDAV resource (no METHOD / calendar name).
   */
  function icsFromEvents(events, opts) {
    opts = opts || {};
    var lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//tentamen.bth.se calendar extension//EN',
      'CALSCALE:GREGORIAN'
    ];
    if (!opts.caldav) lines.push('METHOD:PUBLISH', 'X-WR-CALNAME:BTH exams', 'X-WR-TIMEZONE:' + TZ);
    lines = lines.concat(VTIMEZONE);

    var dtstamp = stamp(opts.now);
    events.forEach(function (ev) {
      lines.push('BEGIN:VEVENT');
      lines.push('UID:' + ev.uid);
      lines.push('DTSTAMP:' + dtstamp);
      if (ev.start) {
        lines.push('DTSTART;TZID=' + TZ + ':' + compactDateTime(ev.date, ev.start));
        lines.push('DTEND;TZID=' + TZ + ':' + compactDateTime(ev.date, ev.end));
      } else {
        lines.push('DTSTART;VALUE=DATE:' + compactDate(ev.date));
        lines.push('DTEND;VALUE=DATE:' + compactDate(nextDay(ev.date)));
        lines.push('TRANSP:TRANSPARENT');
      }
      lines.push('SUMMARY:' + icsEscape(ev.summary));
      if (ev.location) lines.push('LOCATION:' + icsEscape(ev.location));
      lines.push('DESCRIPTION:' + icsEscape(ev.description));
      lines.push('URL:' + SOURCE_URL);
      if (ev.alarmMinutes) {
        lines.push('BEGIN:VALARM');
        lines.push('ACTION:DISPLAY');
        lines.push('DESCRIPTION:' + icsEscape(ev.summary));
        lines.push('TRIGGER:-PT' + ev.alarmMinutes + 'M');
        lines.push('END:VALARM');
      }
      lines.push('END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    return lines.map(fold).join('\r\n') + '\r\n';
  }

  // --------------------------------------------------------- Google links

  function googleUrl(ev) {
    var dates = ev.start
      ? compactDateTime(ev.date, ev.start) + '/' + compactDateTime(ev.date, ev.end)
      : compactDate(ev.date) + '/' + compactDate(nextDay(ev.date));
    var params = [
      ['action', 'TEMPLATE'],
      ['text', ev.summary],
      ['dates', dates],
      ['details', ev.description]
    ];
    if (ev.start) params.push(['ctz', TZ]);
    if (ev.location) params.push(['location', ev.location]);
    return 'https://calendar.google.com/calendar/render?' + params.map(function (p) {
      return p[0] + '=' + encodeURIComponent(p[1]);
    }).join('&');
  }

  function googleLinks(exams, opts) {
    return eventsFor(exams, opts).map(googleUrl);
  }

  var api = {
    buildIcs: buildIcs,
    icsFromEvents: icsFromEvents,
    googleLinks: googleLinks,
    eventsFor: eventsFor,
    _fold: fold,
    _nextDay: nextDay
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  root.BthCalendar = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
