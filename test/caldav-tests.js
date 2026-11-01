// Run with: node test/caldav-tests.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const fake = require('./fake-icloud.js');
const CalDav = require('../src/caldav.js');

let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok   ' + name); }
  catch (e) { failures++; console.log('FAIL ' + name + '\n     ' + String(e.stack || e).split('\n').slice(0, 4).join('\n     ')); }
}

const exams = [
  { id: 'a', courseCode: 'IY1465', courseName: 'Digitalisering och affärsutveckling', moduleCode: '2620', moduleName: 'Salstentamen',
    date: '2026-11-18', start: '14:00', end: '15:00', place: '', status: 'registered' },
  { id: 'b', courseCode: 'MA1499', courseName: 'Envariabelanalys 1', moduleCode: '2430', moduleName: 'Salstentamen 3',
    date: '2026-12-18', start: '08:30', end: '09:30', signupStart: '2026-11-18', signupEnd: '2026-12-04', status: 'signup' }
];

// Loads background.js the way Chrome would, with chrome.* stubbed and
// requests to caldav.icloud.com sent to the fake server instead.
function loadBackground(srv, storage) {
  let listener;
  const realFetch = globalThis.fetch;
  const ctx = {
    console, URL, Buffer, btoa, unescape, encodeURIComponent, setTimeout,
    fetch: (url, init) => realFetch(String(url).replace('https://caldav.icloud.com/', srv.url), init),
    chrome: {
      runtime: { id: 'ext', onMessage: { addListener: (fn) => (listener = fn) } },
      storage: { local: { get: async (k) => ({ [k]: storage[k] }) } }
    },
    importScripts: (...files) => files.forEach((f) =>
      vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), ctx, { filename: f }))
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8'), ctx, { filename: 'background.js' });
  return (msg) => new Promise((resolve) => listener(msg, { id: 'ext' }, resolve));
}

(async () => {
  const srv = await fake.start();
  const client = (pass) => new CalDav.Client({ username: srv.USER, password: pass || srv.PASS, baseUrl: srv.url });

  await test('lists only writable event calendars', async () => {
    const cals = await client().listCalendars();
    assert.deepStrictEqual(cals.map((c) => c.name), ['Home', 'Skola & tentor']);
    assert.strictEqual(cals[0].url, srv.url + 'p42/1234567/calendars/home/');
    assert.strictEqual(cals[0].color, '#1BADF8');
  });

  await test('password with spaces (as Apple shows it) still works', async () => {
    const cals = await client('abcd-efgh-ijkl-mnop ').listCalendars();
    assert.strictEqual(cals.length, 2);
  });

  await test('wrong password gives a clear error', async () => {
    await assert.rejects(client('wrong').listCalendars(), /did not accept/);
  });

  await test('missing credentials are rejected', () => {
    assert.throws(() => new CalDav.Client({ username: 'x' }), /required/);
  });

  await test('unreachable server gives a clear error', async () => {
    const c = new CalDav.Client({ username: 'a', password: 'b', baseUrl: 'http://127.0.0.1:1/' });
    await assert.rejects(c.listCalendars(), /Could not reach iCloud/);
  });

  await test('background: list calendars and add exams via messages', async () => {
    srv.store.clear();
    const storage = { icloud: { username: srv.USER, password: srv.PASS } };
    const send = loadBackground(srv, storage);

    const list = await send({ type: 'icloud-list-calendars', username: srv.USER, password: srv.PASS });
    assert.ok(list.ok, list.error);
    assert.strictEqual(list.result.length, 2);

    const noCal = await send({ type: 'icloud-add', exams, options: {} });
    assert.strictEqual(noCal.ok, false);
    assert.match(noCal.error, /Pick an iCloud calendar/);

    // background builds https://caldav.icloud.com/... URLs; point the chosen calendar there
    storage.icloud.calendarUrl = 'https://caldav.icloud.com/p42/1234567/calendars/home/';
    storage.icloud.calendarName = 'Home';
    const r = await send({ type: 'icloud-add', exams, options: { reminderMinutes: 1440, signupReminders: true } });
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.result.added, 3); // 2 exams + 1 sign-up-opens event
    assert.strictEqual(srv.store.size, 3);

    const put = srv.store.get('/p42/1234567/calendars/home/exam-IY1465-2620-2026-11-18-tentamen-bth-se.ics');
    assert.ok(put, [...srv.store.keys()].join(', '));
    assert.match(put.contentType, /text\/calendar/);
    assert.ok(put.body.includes('DTSTART;TZID=Europe/Stockholm:20261118T140000'));
    assert.ok(put.body.includes('TRIGGER:-PT1440M'));
    assert.ok(!put.body.includes('METHOD:'), 'CalDAV resources must not have METHOD');
    assert.strictEqual((put.body.match(/BEGIN:VEVENT/g) || []).length, 1);

    // adding again overwrites instead of duplicating
    const again = await send({ type: 'icloud-add', exams, options: {} });
    assert.ok(again.ok);
    assert.strictEqual(srv.store.size, 3);
  });

  await test('background: not connected', async () => {
    const send = loadBackground(srv, {});
    const r = await send({ type: 'icloud-add', exams, options: {} });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /Connect your iCloud account/);
  });

  srv.server.close();
  console.log(failures ? `\n${failures} failing` : '\nall caldav tests passed');
  process.exit(failures ? 1 : 0);
})();
