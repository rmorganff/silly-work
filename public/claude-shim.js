/*
 * silly-work: drop-in window.claude for the Work Board and desk-bridge.js, backed by /api/db (Turso) instead of claude.ai.
 *
 *   var db = await window.claude.use('db');
 *   db.doc('meta/cardn').get() / .set(data, {ifVersion, silly_wid}) / .update(data, {ifVersion, silly_wid}) / .delete()
 *   db.doc('inbox/x').onSnapshot(cb, errCb)        // delta polling on the global seq: 7 s visible, paused hidden
 *   db.collection('tasks').add(data) / .get() / .onSnapshot(cb, errCb) / .doc(id)
 *   var mcp = await window.claude.use('mcp');  mcp.callTool(server, 'fire_trigger' | 'list_triggers', args)  -> /api/trigger
 *
 * Snapshots look like the ones the bridge already reads: doc: {id, exists, data(), version, metadata}; query: {docs, size,
 * empty, forEach, metadata}, each doc {id, exists, data(), version}. `version` is the document's write count: pass it back
 * as ifVersion for a compare-and-set (a stale write rejects with {code:'version_conflict'}). A write may carry silly_wid
 * (option or inside data): a retry of one that already landed answers {again:true} and is not done twice.
 *
 * The per-device bearer token: window.SILLY_WORK_TOKEN, or localStorage 'silly_work_token', or claude.setToken(t).
 * Errors are thrown as objects with a `code` (and `status`), as the bridge expects: {code:'version_conflict', version}.
 */
(function () {
  'use strict';
  var root = typeof window !== 'undefined' ? window : globalThis;
  if (root.claude && root.claude.__sillyWork !== true && !root.SILLY_WORK_FORCE_SHIM) return; // a real claude.ai host wins

  var POLL_MS = 7000;
  var tokenMem = null;
  function storage(k, v) { try { return v === undefined ? root.localStorage.getItem(k) : root.localStorage.setItem(k, v); } catch (e) { return null; } }
  function token() { return tokenMem || root.SILLY_WORK_TOKEN || storage('silly_work_token') || ''; }
  function base() { return String(root.SILLY_WORK_BASE || ''); }
  function visible() { var d = root.document; return !d || d.visibilityState !== 'hidden'; }

  function fail(status, body) {
    var e = {}; var b = body && typeof body === 'object' ? body : {};
    for (var k in b) if (Object.prototype.hasOwnProperty.call(b, k)) e[k] = b[k];
    e.status = status; e.code = b.code || b.error || 'http_' + status;
    return e;
  }
  async function post(path, body) {
    var r;
    try {
      r = await root.fetch(base() + path, { method: 'POST', headers: { authorization: 'Bearer ' + token(), 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e) { throw { code: 'network', status: 0, message: String(e && e.message || e) }; }
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) throw fail(r.status, j);
    return j;
  }
  var api = function (body) { return post('/api/db', body); };

  // 'collection/doc id': split on the FIRST slash only; colons and further slashes belong to the id.
  function split(path) {
    var s = String(path), i = s.indexOf('/');
    if (i < 1 || i === s.length - 1) throw { code: 'bad_path', message: 'expected collection/doc: ' + s };
    return [s.slice(0, i), s.slice(i + 1)];
  }
  var META = { fromCache: false, hasPendingWrites: false };
  function docSnap(id, rec) {
    var ex = !!rec && rec.data != null;
    return { id: id, exists: ex, version: ex ? rec.version : 0, data: function () { return ex ? JSON.parse(JSON.stringify(rec.data)) : undefined; }, metadata: META };
  }
  function querySnap(cache) {
    var ids = Object.keys(cache).filter(function (k) { return cache[k].data != null; }).sort();
    var docs = ids.map(function (id) { return docSnap(id, cache[id]); });
    return { docs: docs, size: docs.length, empty: docs.length === 0, forEach: function (f) { docs.forEach(f); }, metadata: META };
  }
  function opts(o, data) {
    var out = {};
    if (o && o.ifVersion != null) out.ifVersion = o.ifVersion;
    var w = (o && o.silly_wid) || (data && data.silly_wid);
    if (w) out.silly_wid = w;
    return out;
  }

  // ---- change feed: one watcher per collection, polled on the global seq ----
  var watchers = {};
  var timer = null, polling = false;

  function watcher(col) {
    var w = watchers[col];
    if (!w) w = watchers[col] = { col: col, cache: {}, seq: 0, loaded: false, loading: null, docSubs: [], colSubs: [] };
    return w;
  }
  function load(w) {
    if (w.loaded) return Promise.resolve();
    if (!w.loading) {
      w.loading = api({ op: 'list', collection: w.col }).then(function (r) {
        r.docs.forEach(function (d) { w.cache[d.id] = { data: d.data, version: d.version }; });
        w.seq = r.seq; w.loaded = true;
      }).finally(function () { w.loading = null; });
    }
    return w.loading;
  }
  function emit(w, changedIds, initialOnly) {
    w.docSubs.slice().forEach(function (s) {
      if (initialOnly ? s.fresh : changedIds.indexOf(s.id) >= 0) { s.fresh = false; try { s.cb(docSnap(s.id, w.cache[s.id])); } catch (e) { /* a listener's fault is its own */ } }
    });
    w.colSubs.slice().forEach(function (s) {
      if (initialOnly ? s.fresh : changedIds.length) { s.fresh = false; try { s.cb(querySnap(w.cache)); } catch (e) { /* ditto */ } }
    });
  }
  async function pollOne(w) {
    if (!w.loaded) { await load(w); emit(w, [], true); return; }
    for (var guard = 0; guard < 20; guard++) {
      var r = await api({ op: 'changes', since_seq: w.seq, collection: w.col });
      var changed = [];
      r.changes.forEach(function (c) {
        var have = w.cache[c.id];
        if (have && have.version === c.version && (have.data == null) === c.deleted) return; // our own write, already applied
        w.cache[c.id] = { data: c.deleted ? null : c.data, version: c.version };
        changed.push(c.id);
      });
      w.seq = r.seq;
      if (changed.length) emit(w, changed, false);
      if (!r.more) break;
    }
  }
  function active() { return Object.keys(watchers).map(function (k) { return watchers[k]; }).filter(function (w) { return w.docSubs.length || w.colSubs.length; }); }
  async function poll() {
    if (polling) return; polling = true;
    try {
      var ws = active();
      for (var i = 0; i < ws.length; i++) {
        try { await pollOne(ws[i]); }
        catch (e) { ws[i].docSubs.concat(ws[i].colSubs).forEach(function (s) { if (s.err) { try { s.err(e); } catch (x) {} } }); }
      }
    } finally { polling = false; }
  }
  function schedule() {
    if (timer != null) { root.clearTimeout(timer); timer = null; }
    if (!active().length || !visible()) return; // paused while hidden or when nobody is listening
    timer = root.setTimeout(function () { timer = null; poll().then(schedule, schedule); }, POLL_MS);
  }
  if (root.document && root.document.addEventListener) {
    root.document.addEventListener('visibilitychange', function () {
      if (visible()) poll().then(schedule, schedule); else schedule();
    });
  }
  function subscribe(w, list, sub, errCb) {
    sub.err = errCb; list.push(sub);
    // first snapshot as soon as the collection is loaded, then the timer carries on
    load(w).then(function () { emit(w, [], true); schedule(); }, function (e) { if (errCb) { try { errCb(e); } catch (x) {} } schedule(); });
    return function unsubscribe() { var i = list.indexOf(sub); if (i >= 0) list.splice(i, 1); schedule(); };
  }

  // ---- refs ----
  function docRef(col, id) {
    return {
      id: id, path: col + '/' + id,
      get: async function () { var r = await api({ op: 'get', collection: col, doc_id: id }); return docSnap(id, r.exists ? r : null); },
      set: async function (data, o) { return applyWrite(col, id, await api(Object.assign({ op: 'set', collection: col, doc_id: id, data: data }, opts(o, data))), data, 'set'); },
      update: async function (data, o) { return applyWrite(col, id, await api(Object.assign({ op: 'update', collection: col, doc_id: id, data: data }, opts(o, data))), data, 'update'); },
      delete: async function (o) { return applyWrite(col, id, await api(Object.assign({ op: 'delete', collection: col, doc_id: id }, opts(o))), null, 'delete'); },
      onSnapshot: function (cb, errCb) { var w = watcher(col); return subscribe(w, w.docSubs, { id: id, cb: cb, fresh: true }, errCb); },
    };
  }
  // A successful write updates the local cache at once, so the page sees its own change without waiting for the poll.
  function applyWrite(col, id, r, data, op) {
    var w = watchers[col];
    if (w && w.loaded && r && !r.again) {
      var prev = w.cache[id], next = op === 'delete' ? null : op === 'update' ? Object.assign({}, prev && prev.data, data) : data;
      w.cache[id] = { data: next == null ? null : JSON.parse(JSON.stringify(next)), version: r.version };
      emit(w, [id], false);
    }
    return r;
  }
  function collectionRef(col) {
    return {
      id: col, path: col,
      doc: function (id) { return docRef(col, id); },
      add: async function (data, o) { var r = await api(Object.assign({ op: 'add', collection: col, data: data }, opts(o, data))); applyWrite(col, r.id, r, data, 'set'); return docRef(col, r.id); },
      get: async function () { var r = await api({ op: 'list', collection: col }); var c = {}; r.docs.forEach(function (d) { c[d.id] = { data: d.data, version: d.version }; }); return querySnap(c); },
      onSnapshot: function (cb, errCb) { var w = watcher(col); return subscribe(w, w.colSubs, { cb: cb, fresh: true }, errCb); },
    };
  }
  var dbApi = { doc: function (p) { var s = split(p); return docRef(s[0], s[1]); }, collection: collectionRef };

  var mcpApi = {
    callTool: function (server, name, args) { return post('/api/trigger', { server: server, tool: name, args: args || {} }); },
  };

  root.claude = {
    __sillyWork: true,
    use: async function (name) {
      if (name === 'db') return dbApi;
      if (name === 'mcp') return mcpApi;
      if (root.console && root.console.warn) root.console.warn('[silly-work] window.claude.use(' + name + ') is not supported here');
      return null; // the bridge reads a falsy capability as "not available"
    },
    setToken: function (t) { tokenMem = String(t || ''); storage('silly_work_token', tokenMem); },
    _poll: function () { return poll(); }, // for tests and for a "refresh now" button
  };
})();
