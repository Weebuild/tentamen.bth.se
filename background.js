/* global importScripts, chrome, BthCalDav, BthCalendar */
// Talks to iCloud for the popup. Runs here, not in the popup, so an upload
// keeps going if the popup closes, and the host permission for icloud.com
// lets requests through without CORS.
importScripts('src/calendar.js', 'src/caldav.js');

async function credentials() {
  const { icloud } = await chrome.storage.local.get('icloud');
  if (!icloud || !icloud.username || !icloud.password) throw new Error('Connect your iCloud account first.');
  return icloud;
}

async function listCalendars(msg) {
  const creds = msg.username ? msg : await credentials();
  const client = new BthCalDav.Client({ username: creds.username, password: creds.password });
  return client.listCalendars();
}

async function addEvents(msg) {
  const creds = await credentials();
  if (!creds.calendarUrl) throw new Error('Pick an iCloud calendar first.');
  const client = new BthCalDav.Client({ username: creds.username, password: creds.password });
  const events = BthCalendar.eventsFor(msg.exams, msg.options);
  let added = 0;
  for (const ev of events) {
    await client.putEvent(creds.calendarUrl, ev.uid, BthCalendar.icsFromEvents([ev], { caldav: true }));
    added++;
  }
  return { added, calendarName: creds.calendarName || 'iCloud' };
}

const handlers = { 'icloud-list-calendars': listCalendars, 'icloud-add': addEvents };

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = msg && handlers[msg.type];
  if (!handler || sender.id !== chrome.runtime.id) return false;
  handler(msg).then(
    (result) => sendResponse({ ok: true, result }),
    (err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) })
  );
  return true; // async response
});
