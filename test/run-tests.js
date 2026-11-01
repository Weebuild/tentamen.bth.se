// Run with: node test/run-tests.js   (uses the Playwright + Chromium that is installed globally)
'use strict';
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');
const Calendar = require('../src/calendar.js');

const root = path.resolve(__dirname, '..');
const fileUrl = (p) => 'file://' + path.join(root, p);
let failures = 0;
async function test(name, fn) {
  try { await fn(); console.log('ok   ' + name); }
  catch (e) { failures++; console.log('FAIL ' + name + '\n     ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n     ')); }
}

async function parse(page, fixture) {
  await page.goto(fileUrl('test/' + fixture));
  await page.addScriptTag({ path: path.join(root, 'src/parser.js') });
  return page.evaluate(() => BthExamParser.parseDocument(document));
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  const a = await parse(page, 'fixture-table.html');
  const byKey = (r, code, date) => r.exams.find((e) => e.courseCode === code && e.date === date);

  await test('table fixture: finds every exam once', () => {
    assert.strictEqual(a.exams.length, 7, JSON.stringify(a.exams.map((e) => e.id), null, 1));
    assert.ok(a.looksLoggedIn);
  });
  await test('registered card is parsed', () => {
    const e = byKey(a, 'IY1465', '2026-11-18');
    assert.ok(e, 'missing');
    assert.strictEqual(e.status, 'registered');
    assert.strictEqual(e.courseName, 'Digitalisering och affärsutveckling');
    assert.strictEqual(e.moduleCode, '2620');
    assert.strictEqual(e.moduleName, 'Salstentamen');
    assert.strictEqual(e.start, '14:00');
    assert.strictEqual(e.end, '15:00');
    assert.strictEqual(e.place, '');
    assert.strictEqual(e.responsible, 'Wen Pan Fagerlin (WPA)');
    assert.strictEqual(e.email, 'wen.pan.fagerlin@bth.se');
  });
  await test('sign-up cards are parsed', () => {
    const e = byKey(a, 'MA1499', '2026-12-18');
    assert.strictEqual(e.status, 'signup');
    assert.strictEqual(e.signupStart, '2026-11-18');
    assert.strictEqual(e.signupEnd, '2026-12-04');
    assert.strictEqual(e.start, '08:30');
    assert.strictEqual(e.moduleName, 'Salstentamen 3');
    assert.strictEqual(e.courseName, 'Envariabelanalys 1: funktioner och differentialkalkyl');
  });
  await test('table row duplicating a card is merged, keeping the time', () => {
    const e = byKey(a, 'MA1499', '2026-12-11');
    assert.strictEqual(e.status, 'signup');
    assert.strictEqual(e.start, '16:00');
    assert.strictEqual(a.exams.filter((x) => x.courseCode === 'MA1499' && x.date === '2026-12-11').length, 1);
  });
  await test('upcoming table rows are parsed', () => {
    const e = byKey(a, 'IY1464', '2027-01-07');
    assert.strictEqual(e.status, 'upcoming');
    assert.strictEqual(e.courseName, 'Mikroekonomi för beslutsfattare');
    assert.strictEqual(e.moduleCode, '2610');
    assert.strictEqual(e.moduleName, 'Salstentamen');
    assert.strictEqual(e.start, '');
  });
  await test('exams are sorted by date', () => {
    const dates = a.exams.map((e) => e.date);
    assert.deepStrictEqual(dates, [...dates].sort());
  });

  const b = await parse(page, 'fixture-div.html');
  await test('div table + Swedish labels', () => {
    assert.strictEqual(b.exams.length, 2, JSON.stringify(b.exams, null, 1));
    const fy = b.exams.find((e) => e.courseCode === 'FY1437');
    assert.strictEqual(fy.status, 'registered');
    assert.strictEqual(fy.start, '09:00');
    assert.strictEqual(fy.end, '13:00');
    assert.strictEqual(fy.place, 'Sal J1630');
    assert.ok(b.looksLoggedIn);
  });

  await test('logged-out page gives no exams', async () => {
    await page.setContent('<h1>Exams</h1><a>Sign in</a>');
    await page.addScriptTag({ path: path.join(root, 'src/parser.js') });
    const r = await page.evaluate(() => BthExamParser.parseDocument(document));
    assert.strictEqual(r.exams.length, 0);
    assert.strictEqual(r.looksLoggedIn, false);
  });

  // ---- calendar
  const reg = byKey(a, 'IY1465', '2026-11-18');
  const up = byKey(a, 'IY1464', '2027-01-07');
  const signup = byKey(a, 'MA1499', '2026-12-18');
  const ics = Calendar.buildIcs([reg, up, signup], { reminderMinutes: 1440, signupReminders: true, now: new Date(Date.UTC(2026, 10, 1)) });

  await test('ics: structure, timezone, all-day and alarms', () => {
    assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
    assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
    assert.strictEqual((ics.match(/BEGIN:VEVENT/g) || []).length, 4); // 3 exams + 1 sign-up reminder
    assert.ok(ics.includes('DTSTART;TZID=Europe/Stockholm:20261118T140000'));
    assert.ok(ics.includes('DTEND;TZID=Europe/Stockholm:20261118T150000'));
    assert.ok(ics.includes('DTSTART;VALUE=DATE:20270107'));
    assert.ok(ics.includes('DTEND;VALUE=DATE:20270108'));
    assert.ok(ics.includes('UID:signup-MA1499-2430-2026-12-18@tentamen.bth.se'));
    assert.ok(ics.includes('DTSTART;VALUE=DATE:20261118')); // sign-up opens
    assert.ok(ics.includes('TRIGGER:-PT1440M'));
    assert.ok(ics.includes('UID:exam-IY1465-2620-2026-11-18@tentamen.bth.se'));
  });
  await test('ics: lines folded to <= 75 octets', () => {
    for (const line of ics.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, line);
  });
  await test('ics: next day handles month/year ends', () => {
    assert.strictEqual(Calendar._nextDay('2026-12-31'), '2027-01-01');
    assert.strictEqual(Calendar._nextDay('2028-02-28'), '2028-02-29');
  });
  await test('google links', () => {
    const [timed, allDay] = Calendar.googleLinks([reg, up]);
    const t = new URL(timed);
    assert.strictEqual(t.searchParams.get('dates'), '20261118T140000/20261118T150000');
    assert.strictEqual(t.searchParams.get('ctz'), 'Europe/Stockholm');
    assert.ok(t.searchParams.get('text').startsWith('Exam: IY1465 Digitalisering'));
    assert.strictEqual(new URL(allDay).searchParams.get('dates'), '20270107/20270108');
  });

  // ---- popup with a stubbed chrome API, to check it renders and exports
  await test('popup renders exams and builds downloads', async () => {
    const p = await browser.newPage({ viewport: { width: 420, height: 720 } });
    await p.addInitScript((result) => {
      window.__opened = [];
      window.chrome = {
        tabs: {
          query: async () => [{ id: 1, url: 'https://tentamen.bth.se/home' }],
          create: (o) => window.__opened.push(o.url)
        },
        scripting: { executeScript: async (o) => (o.func ? [{ result }] : [{}]) },
        storage: { local: {
          data: {},
          get: async (k) => ({ [k]: window.chrome.storage.local.data[k] }),
          set: async (o) => Object.assign(window.chrome.storage.local.data, o),
          remove: async (k) => delete window.chrome.storage.local.data[k]
        } },
        runtime: {
          lastError: null,
          sendMessage: (msg, cb) => {
            window.__messages.push(msg);
            if (msg.type === 'icloud-list-calendars') {
              setTimeout(() => cb({ ok: true, result: [{ url: 'https://x/home/', name: 'Home' }, { url: 'https://x/school/', name: 'School' }] }));
            } else {
              setTimeout(() => cb({ ok: true, result: { added: msg.exams.length, calendarName: 'School' } }));
            }
          }
        }
      };
      window.__messages = [];
    }, a);
    await p.goto(fileUrl('popup/popup.html'));
    await p.waitForSelector('.exam');
    assert.strictEqual(await p.locator('.exam').count(), 7);
    assert.strictEqual(await p.locator('.exam input:checked').count(), 1); // registered pre-selected
    await p.click('#selectAll');
    await p.click('#google');
    assert.strictEqual((await p.evaluate(() => window.__opened)).length, 7);
    const dl = p.waitForEvent('download');
    await p.click('#ics');
    const file = await dl;
    assert.strictEqual(file.suggestedFilename(), 'bth-exams.ics');

    // iCloud: not connected -> shows setup form; connect; pick calendar; add
    await p.click('#selectRegistered');
    assert.strictEqual(await p.isVisible('#icloudForm'), false);
    await p.click('#icloud');
    assert.strictEqual(await p.isVisible('#icloudForm'), true);
    assert.match(await p.textContent('#status'), /Connect your iCloud account/);
    await p.fill('#icloudUser', 'student@icloud.com');
    await p.fill('#icloudPass', 'abcd-efgh-ijkl-mnop');
    await p.click('#icloudConnect');
    await p.waitForSelector('#icloudCal option', { state: 'attached' });
    assert.match(await p.textContent('#icloudState'), /student@icloud.com › Home/);
    await p.selectOption('#icloudCal', 'https://x/school/');
    await p.waitForFunction(() => /School/.test(document.querySelector('#icloudState').textContent));
    await p.click('#icloud');
    await p.waitForFunction(() => /Added 1 event/.test(document.querySelector('#status').textContent));
    const msgs = await p.evaluate(() => window.__messages);
    assert.deepStrictEqual(msgs.map((m) => m.type), ['icloud-list-calendars', 'icloud-add']);
    assert.strictEqual(msgs[1].exams.length, 1);
    assert.strictEqual(msgs[1].options.reminderMinutes, 1440);
    await p.click('#icloudToggle');
    await p.screenshot({ path: path.join(root, 'docs', 'popup.png'), fullPage: true });
    await p.close();
  });

  await browser.close();
  console.log(failures ? `\n${failures} failing` : '\nall tests passed');
  process.exit(failures ? 1 : 0);
})();
