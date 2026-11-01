/* global importScripts, chrome, BthCalDav, BthCalendar */
// Talks to iCloud for the popup. Runs here, not in the popup, so an upload
// keeps going if the popup closes, and the host permission for icloud.com
// lets requests through without CORS.
importScripts('src/calendar.js', 'src/caldav.js');

// Chrome adds "Origin: chrome-extension://<id>" to every fetch from an
// extension. Calendar apps never send an Origin, and iCloud answers such
// requests with 401 even when the app-specific password is right. Remove the
// header, but only for requests this service worker makes (tabId -1), so
// browsing icloud.com in a tab is not affected.
const STRIP_ORIGIN_RULE_ID = 1;
const rulesReady = chrome.declarativeNetRequest.updateSessionRules({
  removeRuleIds: [STRIP_ORIGIN_RULE_ID],
  addRules: [{
    id: STRIP_ORIGIN_RULE_ID,
    priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
    condition: {
      requestDomains: ['icloud.com'],
      tabIds: [chrome.tabs.TAB_ID_NONE],
      resourceTypes: ['xmlhttprequest', 'other']
    }
  }]
}).catch((err) => console.warn('Could not set up the iCloud header rule:', err));

async function credentials() {
  const { icloud } = await chrome.storage.local.get('icloud');
  if (!icloud || !icloud.username || !icloud.password) throw new Error('Connect your iCloud account first.');
  return icloud;
}

async function listCalendars(msg) {
  await rulesReady;
  const creds = msg.username ? msg : await credentials();
  const client = new BthCalDav.Client({ username: creds.username, password: creds.password });
  return client.listCalendars();
}

async function addEvents(msg) {
  await rulesReady;
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
