/*
 * Minimal CalDAV client for iCloud Calendar.
 *
 * iCloud has no "add event" link like Google Calendar, and the icloud.com web
 * login cannot be used by other apps. The supported way for a third-party app
 * to write to iCloud Calendar is CalDAV with the user's Apple ID and an
 * app-specific password (made at account.apple.com). That is what this does:
 *
 *   1. find the user's principal       (PROPFIND https://caldav.icloud.com/)
 *   2. find their calendar home        (PROPFIND <principal>)
 *   3. list calendars that hold events (PROPFIND <home>, Depth 1)
 *   4. PUT one .ics resource per event (PUT <calendar>/<uid>.ics)
 *
 * Re-adding an exam overwrites the same resource, so it never duplicates.
 * XML is read with small regexes because DOMParser is not available in the
 * extension's service worker. Works in the browser and in Node (pass fetch).
 */
(function (root) {
  'use strict';

  var ICLOUD_URL = 'https://caldav.icloud.com/';

  function CalDavError(message, status) {
    var e = new Error(message);
    e.name = 'CalDavError';
    e.status = status || 0;
    return e;
  }

  // ---------------------------------------------------------------- XML

  function decodeXml(s) {
    return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(+n); })
      .replace(/&#x([0-9a-f]+);/gi, function (_, n) { return String.fromCharCode(parseInt(n, 16)); })
      .replace(/&amp;/g, '&');
  }

  // Elements named `name` in any namespace prefix: [{attrs, inner}]
  function elements(xml, name) {
    var re = new RegExp('<(?:[\\w.-]+:)?' + name + '(\\s[^>]*)?(?:/>|>([\\s\\S]*?)</(?:[\\w.-]+:)?' + name + '\\s*>)', 'g');
    var out = [];
    var m;
    while ((m = re.exec(xml))) out.push({ attrs: m[1] || '', inner: m[2] || '' });
    return out;
  }

  function first(xml, name) {
    var e = elements(xml, name)[0];
    return e ? e.inner : null;
  }

  function hrefIn(xml) {
    var h = first(xml || '', 'href');
    return h == null ? null : decodeXml(h.trim());
  }

  // Only props from a propstat with a 2xx status count.
  function okProps(responseXml) {
    return elements(responseXml, 'propstat').filter(function (ps) {
      var status = first(ps.inner, 'status') || '';
      return /\s2\d\d\s/.test(status + ' ');
    }).map(function (ps) { return ps.inner; }).join('\n');
  }

  function parseMultistatus(xml) {
    return elements(xml, 'response').map(function (r) {
      // The response's own href comes before its propstat elements.
      var head = r.inner.split(/<(?:[\w.-]+:)?propstat[\s>]/)[0];
      return { href: hrefIn(head), props: okProps(r.inner) };
    });
  }

  // ---------------------------------------------------------------- HTTP

  function utf8Base64(s) {
    if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(s)));
    return Buffer.from(s, 'utf8').toString('base64');
  }

  function Client(opts) {
    if (!opts || !opts.username || !opts.password) throw CalDavError('Apple ID and app-specific password are required.');
    this.auth = 'Basic ' + utf8Base64(opts.username.trim() + ':' + opts.password.replace(/\s+/g, ''));
    this.fetch = opts.fetch || root.fetch.bind(root);
    this.baseUrl = opts.baseUrl || ICLOUD_URL;
  }

  Client.prototype.request = function (method, url, headers, body) {
    var h = { Authorization: this.auth };
    Object.keys(headers || {}).forEach(function (k) { h[k] = headers[k]; });
    return this.fetch(url, { method: method, headers: h, body: body, credentials: 'omit', redirect: 'follow', cache: 'no-store' })
      .then(function (res) {
        if (res.status === 401 || res.status === 403) {
          throw CalDavError('iCloud did not accept the Apple ID or app-specific password. Make a new app-specific password at account.apple.com and try again.', res.status);
        }
        if (res.status >= 400) throw CalDavError('iCloud answered ' + res.status + ' to ' + method + '.', res.status);
        return res.text().then(function (text) { return { status: res.status, url: res.url || url, text: text }; });
      }, function (err) {
        throw CalDavError('Could not reach iCloud (' + (err && err.message || err) + ').');
      });
  };

  Client.prototype.propfind = function (url, depth, props) {
    var body = '<?xml version="1.0" encoding="utf-8"?>' +
      '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/">' +
      '<d:prop>' + props + '</d:prop></d:propfind>';
    return this.request('PROPFIND', url, { Depth: String(depth), 'Content-Type': 'application/xml; charset=utf-8' }, body);
  };

  Client.prototype.listCalendars = function () {
    var self = this;
    return self.propfind(self.baseUrl, 0, '<d:current-user-principal/>').then(function (res) {
      var principal = hrefIn(first(res.text, 'current-user-principal'));
      if (!principal) throw CalDavError('iCloud did not return your account (no principal).');
      var principalUrl = new URL(principal, res.url).href;
      return self.propfind(principalUrl, 0, '<c:calendar-home-set/>');
    }).then(function (res) {
      var home = hrefIn(first(res.text, 'calendar-home-set'));
      if (!home) throw CalDavError('iCloud did not return your calendar home.');
      var homeUrl = new URL(home, res.url).href;
      return self.propfind(homeUrl, 1,
        '<d:displayname/><d:resourcetype/><c:supported-calendar-component-set/><a:calendar-color/><d:current-user-privilege-set/>')
        .then(function (r) { return { res: r, homeUrl: homeUrl }; });
    }).then(function (o) {
      return parseMultistatus(o.res.text).filter(function (r) {
        if (!r.href) return false;
        var rt = first(r.props, 'resourcetype') || '';
        if (!/<(?:[\w.-]+:)?calendar[\s/>]/.test(rt)) return false;
        var comps = first(r.props, 'supported-calendar-component-set');
        if (comps != null && comps.indexOf('VEVENT') === -1) return false; // reminders lists
        var privs = first(r.props, 'current-user-privilege-set');
        if (privs != null && !/<(?:[\w.-]+:)?(write|write-content|all)\s*\/?>/.test(privs)) return false; // read-only / subscribed
        return true;
      }).map(function (r) {
        var color = (first(r.props, 'calendar-color') || '').trim();
        return {
          url: new URL(r.href, o.res.url).href,
          name: decodeXml((first(r.props, 'displayname') || '').trim()) || 'Calendar',
          color: color ? color.slice(0, 7) : ''
        };
      });
    });
  };

  function resourceName(uid) {
    return uid.replace(/[^A-Za-z0-9-]+/g, '-') + '.ics';
  }

  Client.prototype.putEvent = function (calendarUrl, uid, ics) {
    var base = calendarUrl.charAt(calendarUrl.length - 1) === '/' ? calendarUrl : calendarUrl + '/';
    return this.request('PUT', base + resourceName(uid), { 'Content-Type': 'text/calendar; charset=utf-8' }, ics);
  };

  var api = {
    Client: Client,
    ICLOUD_URL: ICLOUD_URL,
    _parseMultistatus: parseMultistatus,
    _resourceName: resourceName
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  root.BthCalDav = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
