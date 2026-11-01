// A tiny stand-in for iCloud's CalDAV server, close enough to its real
// responses (default DAV namespace, absolute calendar-home on another host
// path, a Reminders list and a read-only subscribed calendar) to test against.
'use strict';
const http = require('http');

const USER = 'student@icloud.com';
const PASS = 'abcd-efgh-ijkl-mnop';

function multistatus(responses) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<multistatus xmlns="DAV:">' + responses.join('') + '</multistatus>';
}

function start() {
  const store = new Map();
  const log = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      log.push({ method: req.method, url: req.url, depth: req.headers.depth });
      const expected = 'Basic ' + Buffer.from(USER + ':' + PASS).toString('base64');
      if (req.headers.authorization !== expected) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="iCloud"' });
        return res.end();
      }
      const base = 'http://' + req.headers.host;
      if (req.method === 'PROPFIND' && req.url === '/') {
        res.writeHead(207, { 'Content-Type': 'text/xml' });
        return res.end(multistatus(['<response><href>/</href><propstat><prop><current-user-principal><href>/1234567/principal/</href></current-user-principal></prop><status>HTTP/1.1 200 OK</status></propstat></response>']));
      }
      if (req.method === 'PROPFIND' && req.url === '/1234567/principal/') {
        res.writeHead(207, { 'Content-Type': 'text/xml' });
        return res.end(multistatus([`<response><href>/1234567/principal/</href><propstat><prop><calendar-home-set xmlns="urn:ietf:params:xml:ns:caldav"><href xmlns="DAV:">${base}/p42/1234567/calendars/</href></calendar-home-set></prop><status>HTTP/1.1 200 OK</status></propstat></response>`]));
      }
      if (req.method === 'PROPFIND' && req.url === '/p42/1234567/calendars/') {
        const cal = (href, name, comps, color, privs) =>
          `<response><href>${href}</href><propstat><prop><displayname>${name}</displayname>` +
          `<resourcetype><collection/><calendar xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype>` +
          `<supported-calendar-component-set xmlns="urn:ietf:params:xml:ns:caldav">${comps.map((c) => `<comp name="${c}"/>`).join('')}</supported-calendar-component-set>` +
          `<calendar-color xmlns="http://apple.com/ns/ical/" symbolic-color="blue">${color}</calendar-color>` +
          `<current-user-privilege-set>${privs.map((p) => `<privilege><${p}/></privilege>`).join('')}</current-user-privilege-set>` +
          `</prop><status>HTTP/1.1 200 OK</status></propstat></response>`;
        res.writeHead(207, { 'Content-Type': 'text/xml' });
        return res.end(multistatus([
          `<response><href>/p42/1234567/calendars/</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat><propstat><prop><displayname/></prop><status>HTTP/1.1 404 Not Found</status></propstat></response>`,
          cal('/p42/1234567/calendars/home/', 'Home', ['VEVENT'], '#1BADF8FF', ['read', 'write', 'write-properties']),
          cal('/p42/1234567/calendars/school/', 'Skola &amp; tentor', ['VEVENT', 'VTODO'], '#FF2968FF', ['read', 'write']),
          cal('/p42/1234567/calendars/tasks/', 'Reminders', ['VTODO'], '#000000FF', ['read', 'write']),
          cal('/p42/1234567/calendars/holidays/', 'Swedish holidays', ['VEVENT'], '#00FF00FF', ['read']),
          `<response><href>/p42/1234567/calendars/inbox/</href><propstat><prop><resourcetype><collection/><schedule-inbox xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>`
        ]));
      }
      if (req.method === 'PUT' && req.url.startsWith('/p42/1234567/calendars/')) {
        const existed = store.has(req.url);
        store.set(req.url, { body, contentType: req.headers['content-type'] });
        res.writeHead(existed ? 204 : 201);
        return res.end();
      }
      res.writeHead(404);
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ server, store, log, url: `http://127.0.0.1:${server.address().port}/`, USER, PASS });
  }));
}

module.exports = { start };
