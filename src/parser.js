/*
 * Reads exams from the tentamen.bth.se "Exam Sign up" page.
 *
 * The page has (at least) three kinds of content:
 *   1. Cards for exams you are registered for ("Unregister" button,
 *      Date / Time / Place / Responsible / E-post).
 *   2. Cards under "Sign up For Exams" (Sign up Period, Date, Time).
 *   3. The "Upcoming Exams" table (`.bth-table-content`), which only has a
 *      course, a module and a date (no time).
 *
 * We do not know the exact markup, so the parser works on visible text and
 * labels ("Date:", "Time:", ...) instead of specific class names, and it
 * accepts both English and Swedish labels. Nothing here logs in or sends
 * data anywhere: it only reads the page the user already has open.
 *
 * Works in the browser (exposes globalThis.BthExamParser) and in Node.
 */
(function (root) {
  'use strict';

  var COURSE_CODE = /\b([A-ZÅÄÖ]{2,3}\d{3,4})\b/;
  var DATE = /(\d{4}-\d{2}-\d{2})/;
  var DATE_RANGE = /(\d{4}-\d{2}-\d{2})\s*[-–—]\s*(\d{4}-\d{2}-\d{2})/;
  var TIME_RANGE = /(\d{1,2})[:.](\d{2})\s*[-–—]\s*(\d{1,2})[:.](\d{2})/;

  var LABELS = {
    date: ['date', 'datum', 'exam date', 'tentamensdatum'],
    time: ['time', 'tid', 'klockslag'],
    place: ['place', 'plats', 'location', 'lokal', 'sal'],
    signup: ['sign up period', 'sign-up period', 'signup period', 'registration period', 'anmälningsperiod', 'anmälningstid'],
    responsible: ['responsible', 'ansvarig', 'examinator', 'examiner'],
    email: ['e-post', 'e-mail', 'email', 'epost']
  };

  var HEADER_KEYS = {
    course: /course|kurs/i,
    module: /module|modul|prov|moment/i,
    date: /date|datum/i,
    time: /time|tid/i,
    place: /place|plats|lokal|location/i
  };

  function clean(s) {
    return String(s == null ? '' : s).replace(/ /g, ' ').replace(/[ \t]+/g, ' ').trim();
  }

  function textOf(el) {
    if (!el) return '';
    // innerText respects layout (block elements become new lines); fall back
    // to textContent when innerText is not available (e.g. detached nodes).
    var t = typeof el.innerText === 'string' && el.innerText.length ? el.innerText : el.textContent;
    return t || '';
  }

  function linesOf(el) {
    return textOf(el).split(/\r?\n/).map(clean).filter(Boolean);
  }

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** Finds "Label: value" (value on the same or the next line). */
  function field(lines, labelKey) {
    var names = LABELS[labelKey];
    for (var i = 0; i < lines.length; i++) {
      for (var n = 0; n < names.length; n++) {
        var re = new RegExp('^' + escapeRe(names[n]) + '\\s*:\\s*(.*)$', 'i');
        var m = lines[i].match(re);
        if (m) {
          var v = clean(m[1]);
          if (!v && i + 1 < lines.length) v = lines[i + 1];
          return v;
        }
      }
    }
    return '';
  }

  function isLabelLine(line) {
    return /^[^:]{1,40}:/.test(line) && Object.keys(LABELS).some(function (k) {
      return LABELS[k].some(function (n) { return line.toLowerCase().indexOf(n) === 0; });
    });
  }

  function normTime(h, m) {
    return (h.length === 1 ? '0' + h : h) + ':' + m;
  }

  function parseTime(s) {
    var m = (s || '').match(TIME_RANGE);
    if (!m) return { start: '', end: '' };
    return { start: normTime(m[1], m[2]), end: normTime(m[3], m[4]) };
  }

  /** "MA1499 Envariabelanalys 1: ... 2430" -> {code, name, occasion} */
  function splitCourse(s) {
    s = clean(s);
    var m = s.match(COURSE_CODE);
    if (!m) return { code: '', name: s, occasion: '' };
    var rest = clean(s.slice(m.index + m[0].length));
    var occ = '';
    var tail = rest.match(/\s(\d{4})$/);
    if (tail) { occ = tail[1]; rest = clean(rest.slice(0, tail.index)); }
    return { code: m[1], name: rest, occasion: occ };
  }

  /** "2430 Salstentamen 3" -> {moduleCode: "2430", moduleName: "Salstentamen 3"} */
  function splitModule(s) {
    s = clean(s);
    var m = s.match(/^(\d{4})\s+(.*)$/);
    if (m) return { moduleCode: m[1], moduleName: clean(m[2]) };
    return { moduleCode: '', moduleName: s };
  }

  /** Nearest heading before an element ("Upcoming Exams", "Sign up For Exams", ...). */
  function sectionOf(el) {
    var node = el;
    while (node && node.nodeType === 1) {
      var prev = node.previousElementSibling;
      while (prev) {
        if (/^H[1-6]$/.test(prev.tagName) || /heading|title/i.test(prev.className || '')) {
          var t = clean(textOf(prev));
          if (t && t.length < 80) return t;
        }
        var inner = prev.querySelectorAll ? prev.querySelectorAll('h1,h2,h3,h4,h5,h6') : [];
        if (inner.length) {
          var last = clean(textOf(inner[inner.length - 1]));
          if (last && last.length < 80) return last;
        }
        prev = prev.previousElementSibling;
      }
      node = node.parentElement;
    }
    return '';
  }

  function makeExam(o) {
    var exam = {
      courseCode: o.courseCode || '',
      courseName: o.courseName || '',
      moduleCode: o.moduleCode || '',
      moduleName: o.moduleName || '',
      date: o.date || '',
      start: o.start || '',
      end: o.end || '',
      place: o.place || '',
      signupStart: o.signupStart || '',
      signupEnd: o.signupEnd || '',
      responsible: o.responsible || '',
      email: o.email || '',
      status: o.status || 'upcoming',
      section: o.section || ''
    };
    exam.id = [exam.courseCode, exam.moduleCode || exam.moduleName, exam.date].join('|');
    return exam;
  }

  // ---------------------------------------------------------------- tables

  function rowsOf(container) {
    var trs = container.querySelectorAll('tr');
    if (trs.length) return Array.prototype.slice.call(trs);
    var roles = container.querySelectorAll('[role="row"]');
    if (roles.length) return Array.prototype.slice.call(roles);
    // div-based table: rows are the direct children (or the children of the
    // single wrapper child).
    var kids = Array.prototype.slice.call(container.children);
    if (kids.length === 1 && kids[0].children.length > 1) kids = Array.prototype.slice.call(kids[0].children);
    return kids;
  }

  function cellsOf(row) {
    var cells = row.querySelectorAll('td,th,[role="cell"],[role="gridcell"],[role="columnheader"]');
    if (!cells.length) cells = row.children;
    var out = Array.prototype.slice.call(cells).map(function (c) { return clean(textOf(c)); });
    if (!out.length) out = [clean(textOf(row))];
    return out;
  }

  function headerColumns(cells) {
    var cols = {};
    cells.forEach(function (c, i) {
      Object.keys(HEADER_KEYS).forEach(function (k) {
        if (cols[k] == null && HEADER_KEYS[k].test(c)) cols[k] = i;
      });
    });
    return cols;
  }

  function findHeaderCells(container, rows) {
    // Header can be a <thead>, a sibling element before the content, or the first row.
    var scopes = [container, container.parentElement, container.parentElement && container.parentElement.parentElement];
    for (var s = 0; s < scopes.length; s++) {
      if (!scopes[s]) continue;
      var ths = scopes[s].querySelectorAll('th,[role="columnheader"]');
      if (ths.length >= 2) return Array.prototype.slice.call(ths).map(function (c) { return clean(textOf(c)); });
      var hdr = scopes[s].querySelector('[class*="table-header"],[class*="table-head"],thead');
      if (hdr) {
        var hc = cellsOf(hdr.querySelector('tr') || hdr);
        if (hc.length >= 2) return hc;
      }
    }
    var first = rows[0] && cellsOf(rows[0]);
    if (first && !first.some(function (c) { return DATE.test(c); }) && first.some(function (c) { return HEADER_KEYS.date.test(c); })) return first;
    return null;
  }

  function parseTable(container) {
    var exams = [];
    var rows = rowsOf(container);
    var header = findHeaderCells(container, rows);
    var cols = header ? headerColumns(header) : {};
    var section = sectionOf(container);

    rows.forEach(function (row) {
      var cells = cellsOf(row);
      var joined = cells.join(' ');
      if (!DATE.test(joined) || !COURSE_CODE.test(joined)) return; // header / empty rows

      var courseCell = cols.course != null ? cells[cols.course] : '';
      if (!courseCell || !COURSE_CODE.test(courseCell)) {
        courseCell = cells.filter(function (c) { return COURSE_CODE.test(c); })[0] || '';
      }
      var dateCell = cols.date != null && DATE.test(cells[cols.date] || '') ? cells[cols.date]
        : cells.filter(function (c) { return DATE.test(c); })[0];
      var moduleCell = cols.module != null ? cells[cols.module] : '';
      if (!moduleCell) {
        moduleCell = cells.filter(function (c) { return c !== courseCell && c !== dateCell && /^\d{4}\s+\S/.test(c); })[0] || '';
      }
      var timeCell = cols.time != null ? cells[cols.time] : joined;
      var placeCell = cols.place != null ? cells[cols.place] : '';

      var course = splitCourse(courseCell);
      var mod = splitModule(moduleCell);
      var time = parseTime(timeCell);
      exams.push(makeExam({
        courseCode: course.code,
        courseName: course.name,
        moduleCode: mod.moduleCode || course.occasion,
        moduleName: mod.moduleName,
        date: dateCell.match(DATE)[1],
        start: time.start,
        end: time.end,
        place: placeCell,
        status: 'upcoming',
        section: section
      }));
    });
    return exams;
  }

  // ----------------------------------------------------------------- cards

  function countDateLabels(text) {
    var m = text.match(/(^|\n)\s*(date|datum)\s*:/gi);
    return m ? m.length : 0;
  }

  function findCards(doc) {
    var candidates = doc.querySelectorAll('body *');
    var cards = [];
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (el.closest('table, .bth-table-content, [role="table"], [role="grid"]')) continue;
      var own = Array.prototype.slice.call(el.childNodes).filter(function (n) { return n.nodeType === 3; })
        .map(function (n) { return n.textContent; }).join(' ');
      // An element that itself holds the "Date:" label (directly or as its first text).
      if (!/(^|\s)(date|datum)\s*:/i.test(own) && !/^\s*(date|datum)\s*:?\s*$/i.test(textOf(el))) continue;
      // Walk up to the smallest ancestor that also contains a course code,
      // but stop before it would contain more than one exam.
      var node = el;
      var card = null;
      while (node && node !== doc.body) {
        var t = textOf(node);
        if (countDateLabels(t) > 1) break;
        if (COURSE_CODE.test(t) && DATE.test(t)) card = node;
        node = node.parentElement;
      }
      if (card && cards.indexOf(card) === -1) cards.push(card);
    }
    // Drop cards that are nested inside another found card.
    return cards.filter(function (c) {
      return !cards.some(function (o) { return o !== c && o.contains(c); });
    });
  }

  function parseCard(card) {
    var lines = linesOf(card);
    var titleIdx = -1;
    for (var i = 0; i < lines.length; i++) {
      if (COURSE_CODE.test(lines[i]) && !isLabelLine(lines[i])) { titleIdx = i; break; }
    }
    if (titleIdx === -1) return null;

    var title = lines[titleIdx];
    var code = title.match(COURSE_CODE)[1];
    var afterCode = clean(title.slice(title.indexOf(code) + code.length));
    var mod = splitModule(afterCode);
    var courseName = '';
    var next = lines[titleIdx + 1];
    if (next && !isLabelLine(next) && !DATE.test(next)) courseName = next;
    // Title might be "MA1499 Course name" with the module on its own line instead.
    if (!mod.moduleCode && /^\d{4}\s+\S/.test(next || '')) {
      courseName = mod.moduleName;
      mod = splitModule(next);
    }

    var dateStr = field(lines, 'date');
    var dm = dateStr.match(DATE);
    if (!dm) return null;
    var time = parseTime(field(lines, 'time'));
    var signup = field(lines, 'signup').match(DATE_RANGE);
    var text = lines.join('\n');
    var registered = /\b(unregister|avregistrera|avanmäl)/i.test(text);
    var place = field(lines, 'place');
    if (/^(unspecified|ej angiven|ospecificerad|-)$/i.test(place)) place = '';

    return makeExam({
      courseCode: code,
      courseName: courseName,
      moduleCode: mod.moduleCode,
      moduleName: mod.moduleName,
      date: dm[1],
      start: time.start,
      end: time.end,
      place: place,
      signupStart: signup ? signup[1] : '',
      signupEnd: signup ? signup[2] : '',
      responsible: field(lines, 'responsible'),
      email: (field(lines, 'email').match(/[^\s@]+@[^\s@]+/) || [''])[0],
      status: registered ? 'registered' : (signup ? 'signup' : 'upcoming'),
      section: sectionOf(card)
    });
  }

  // ----------------------------------------------------------------- merge

  var STATUS_RANK = { registered: 3, signup: 2, upcoming: 1 };

  function merge(exams) {
    var byId = {};
    var order = [];
    exams.forEach(function (e) {
      // Course names in cards are usually the full name; occasions may differ
      // between the table and the cards, so key on code + module + date.
      var key = [e.courseCode, e.moduleCode || e.moduleName, e.date].join('|');
      var cur = byId[key];
      if (!cur) { byId[key] = e; order.push(key); return; }
      Object.keys(e).forEach(function (k) {
        if (k === 'status') {
          if ((STATUS_RANK[e.status] || 0) > (STATUS_RANK[cur.status] || 0)) { cur.status = e.status; cur.section = e.section; }
        } else if (!cur[k] && e[k]) {
          cur[k] = e[k];
        }
      });
    });
    return order.map(function (k) { return byId[k]; }).sort(function (a, b) {
      return (a.date + a.start).localeCompare(b.date + b.start);
    });
  }

  function parseDocument(doc) {
    doc = doc || root.document;
    var exams = [];

    var tables = Array.prototype.slice.call(doc.querySelectorAll('.bth-table-content'));
    Array.prototype.slice.call(doc.querySelectorAll('table')).forEach(function (t) {
      if (!tables.some(function (c) { return c.contains(t) || t.contains(c); })) tables.push(t);
    });
    tables.forEach(function (t) { exams = exams.concat(parseTable(t)); });

    findCards(doc).forEach(function (card) {
      var e = parseCard(card);
      if (e) exams.push(e);
    });

    var bodyText = textOf(doc.body);
    return {
      url: doc.location ? String(doc.location.href) : '',
      title: doc.title || '',
      // Heuristics so the popup can tell "not logged in" from "no exams".
      looksLoggedIn: /sign out|logga ut/i.test(bodyText),
      exams: merge(exams)
    };
  }

  var api = {
    parseDocument: parseDocument,
    // exported for tests
    _splitCourse: splitCourse,
    _splitModule: splitModule,
    _parseTime: parseTime,
    _merge: merge
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  root.BthExamParser = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
