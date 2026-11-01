/* global chrome, BthCalendar */
(function () {
  'use strict';

  var EXAM_HOST = 'tentamen.bth.se';
  var EXAM_URL = 'https://tentamen.bth.se/';

  var $ = function (id) { return document.getElementById(id); };
  var state = { exams: [], selected: new Set() };

  var STATUS_LABEL = { registered: 'Registered', signup: 'Sign up', upcoming: 'Upcoming' };
  var GROUPS = [
    ['registered', 'Registered exams'],
    ['signup', 'Sign up for exams'],
    ['upcoming', 'Upcoming exams']
  ];

  function setStatus(msg, kind) {
    var el = $('status');
    el.className = 'status' + (kind ? ' ' + kind : '');
    el.textContent = '';
    if (msg instanceof Node) el.appendChild(msg); else el.textContent = msg || '';
  }

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'className') e.className = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else e.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) e.appendChild(c); });
    return e;
  }

  function openExamSite() {
    chrome.tabs.create({ url: EXAM_URL });
    window.close();
  }

  function notOnSite() {
    var frag = document.createDocumentFragment();
    frag.appendChild(document.createTextNode('Open the Exam Sign up page on tentamen.bth.se and sign in, then click this button again. '));
    var b = el('button', { type: 'button', className: 'link', text: 'Open tentamen.bth.se' });
    b.addEventListener('click', openExamSite);
    frag.appendChild(b);
    setStatus(frag, 'warn');
  }

  async function readPage(tab) {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/parser.js'] });
    var res = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: function () { return globalThis.BthExamParser.parseDocument(document); }
    });
    return res && res[0] && res[0].result;
  }

  function formatWhen(e) {
    return e.date + (e.start ? ' ' + e.start + '–' + e.end : '');
  }

  function render() {
    var list = $('list');
    list.textContent = '';
    GROUPS.forEach(function (g) {
      var items = state.exams.filter(function (e) { return e.status === g[0]; });
      if (!items.length) return;
      list.appendChild(el('h2', { className: 'group-title', text: g[1] + ' (' + items.length + ')' }));
      items.forEach(function (e) {
        var cb = el('input', { type: 'checkbox' });
        cb.checked = state.selected.has(e.id);
        cb.addEventListener('change', function () {
          if (cb.checked) state.selected.add(e.id); else state.selected.delete(e.id);
          updateCount();
        });
        var meta = [e.moduleCode, e.moduleName].filter(Boolean).join(' ');
        if (e.place) meta += ' · ' + e.place;
        if (!e.start) meta += ' · time not published';
        if (e.signupStart && e.status !== 'registered') meta += ' · sign up ' + e.signupStart + ' – ' + e.signupEnd;
        var row = el('label', { className: 'exam' }, [
          cb,
          el('span', { className: 'name' }, [
            document.createTextNode(e.courseCode + ' ' + (e.courseName || '')),
            el('span', { className: 'badge ' + e.status, text: STATUS_LABEL[e.status] || e.status })
          ]),
          el('span', { className: 'when', text: formatWhen(e) }),
          el('span', { className: 'meta', text: meta })
        ]);
        list.appendChild(row);
      });
    });
    updateCount();
  }

  function selectedExams() {
    return state.exams.filter(function (e) { return state.selected.has(e.id); });
  }

  function updateCount() {
    var n = state.selected.size;
    $('count').textContent = n + ' of ' + state.exams.length + ' selected';
    $('google').disabled = n === 0;
    $('ics').disabled = n === 0;
  }

  function select(pred) {
    state.selected = new Set(state.exams.filter(pred).map(function (e) { return e.id; }));
    render();
  }

  function options() {
    return {
      signupReminders: $('optSignup').checked,
      reminderMinutes: Number($('optReminder').value) || 0
    };
  }

  function saveOptions() {
    chrome.storage.local.set({ options: options() });
  }

  async function loadOptions() {
    var data = await chrome.storage.local.get('options');
    var o = data.options;
    if (!o) return;
    $('optSignup').checked = !!o.signupReminders;
    $('optReminder').value = String(o.reminderMinutes || 0);
  }

  function addToGoogle() {
    var links = BthCalendar.googleLinks(selectedExams(), options());
    links.forEach(function (url, i) {
      chrome.tabs.create({ url: url, active: i === 0 });
    });
  }

  function downloadIcs() {
    var ics = BthCalendar.buildIcs(selectedExams(), options());
    var blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: 'bth-exams.ics' });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
    setStatus('Saved bth-exams.ics. Open it to add the exams to your calendar.', 'ok');
  }

  async function init() {
    $('selectAll').addEventListener('click', function () { select(function () { return true; }); });
    $('selectNone').addEventListener('click', function () { select(function () { return false; }); });
    $('selectRegistered').addEventListener('click', function () { select(function (e) { return e.status === 'registered'; }); });
    $('google').addEventListener('click', addToGoogle);
    $('ics').addEventListener('click', downloadIcs);
    $('optSignup').addEventListener('change', saveOptions);
    $('optReminder').addEventListener('change', saveOptions);
    await loadOptions();

    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    var tab = tabs[0];
    var host = '';
    try { host = new URL(tab.url).hostname; } catch (err) { /* no url: not our site */ }
    if (host !== EXAM_HOST) return notOnSite();

    var result;
    try {
      result = await readPage(tab);
    } catch (err) {
      setStatus('Could not read the page: ' + err.message, 'warn');
      return;
    }

    if (!result || !result.exams.length) {
      setStatus(result && !result.looksLoggedIn
        ? 'No exams found. Sign in on tentamen.bth.se first (the extension never signs in for you), then open Exam Sign up.'
        : 'No exams found on this page. Open the "Exam Sign up" tab and try again.', 'warn');
      return;
    }

    state.exams = result.exams;
    state.selected = new Set(state.exams.filter(function (e) { return e.status === 'registered'; }).map(function (e) { return e.id; }));
    setStatus('');
    $('main').hidden = false;
    render();
  }

  init();
})();
