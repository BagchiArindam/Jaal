/**
 * shared/net-hooks.js — fetch / XMLHttpRequest / WebSocket interceptor.
 *
 * Install early (extension MAIN world, or Tampermonkey @run-at document-start with
 * @grant unsafeWindow) to record all network activity.
 *
 * Usage:
 *   const hooks = window.Jaal.NetHooks.create({ maxBuffer: 500 });
 *   hooks.start();                // install interceptors
 *   hooks.stop();                 // restore originals
 *   const calls = hooks.getAndClear();   // get recorded + clear buffer
 *   const calls = hooks.snapshot();      // get without clearing
 *
 * Recorded call object:
 *   { id, type: "fetch"|"xhr"|"websocket", url, method, headers, bodyPreview,
 *     status, responseHeaders, responsePreview, ts, error }
 * WebSocket calls additionally have: { frames: [{dir:"in"|"out", data, ts}] }
 *
 * Ported from lib-sortsight-js/net-hooks.js — exposure moved to window.Jaal.NetHooks.
 */
(function (global) {
  "use strict";

  const ns = (global.Jaal = global.Jaal || {});

  // Resolve correct window — unsafeWindow in Tampermonkey context, window otherwise
  const _w =
    typeof unsafeWindow !== "undefined"
      ? unsafeWindow
      : typeof window !== "undefined"
      ? window
      : global;

  function _truncate(str, n) {
    if (str === null || str === undefined) return "";
    const s = typeof str === "string" ? str : _safeStringify(str);
    return s.length > n ? s.substring(0, n) + "…" : s;
  }

  function _safeStringify(val) {
    try {
      return typeof val === "string" ? val : JSON.stringify(val);
    } catch (_) {
      return String(val);
    }
  }

  function _headersToObj(h) {
    const obj = {};
    try {
      if (h instanceof Headers) {
        h.forEach((v, k) => { obj[k] = v; });
      } else if (h && typeof h === "object") {
        Object.assign(obj, h);
      }
    } catch (_) {}
    return obj;
  }

  function create(opts) {
    const maxBuffer = (opts && opts.maxBuffer) || 500;
    const bodyPreviewLen = (opts && opts.bodyPreviewLen) || 500;
    const responsePreviewLen = (opts && opts.responsePreviewLen) || 1000;
    const maxWsFrames = (opts && opts.maxWsFrames) || 100;

    let calls = [];
    let active = false;
    let _seq = 0;

    const _origFetch = _w.fetch ? _w.fetch.bind(_w) : null;
    const _origXhrOpen = _w.XMLHttpRequest.prototype.open;
    const _origXhrSend = _w.XMLHttpRequest.prototype.send;
    const _origXhrSetHeader = _w.XMLHttpRequest.prototype.setRequestHeader;
    const _origWS = _w.WebSocket;

    function _push(call) {
      if (calls.length >= maxBuffer) calls.shift();
      calls.push(call);
    }

    function _installFetch() {
      if (!_origFetch) return;
      _w.fetch = function (input, init) {
        const id = ++_seq;
        let url = "";
        try {
          url = typeof input === "string" ? input
            : input instanceof URL ? input.href
            : (input && input.url) || String(input);
        } catch (_) {}
        const method = (init && init.method)
          || (input && typeof input === "object" && input.method)
          || "GET";
        const headers = _headersToObj((init && init.headers) || (input && typeof input === "object" && input.headers));
        const bodyPreview = _truncate(_safeStringify(init && init.body), bodyPreviewLen);

        const call = { id, type: "fetch", url, method, headers, bodyPreview, ts: Date.now() };
        _push(call);
        console.log("[Jaal.NetHooks] fetch", method, url);

        return _origFetch(input, init).then(
          (resp) => {
            call.status = resp.status;
            call.statusText = resp.statusText;
            call.responseHeaders = _headersToObj(resp.headers);
            const ct = resp.headers.get("content-type") || "";
            if (ct.includes("json") || ct.includes("text")) {
              return resp.clone().text().then((text) => {
                call.responsePreview = _truncate(text, responsePreviewLen);
                return resp;
              }).catch(() => resp);
            }
            return resp;
          },
          (err) => {
            call.error = String(err);
            console.error("[Jaal.NetHooks] fetch error", url, err);
            throw err;
          }
        );
      };
    }

    function _uninstallFetch() {
      if (_origFetch) _w.fetch = _origFetch;
    }

    function _installXhr() {
      _w.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this._nh_id = ++_seq;
        this._nh_method = String(method).toUpperCase();
        this._nh_url = String(url);
        this._nh_headers = {};
        return _origXhrOpen.call(this, method, url, ...rest);
      };

      _w.XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
        if (this._nh_headers) this._nh_headers[k] = v;
        return _origXhrSetHeader.call(this, k, v);
      };

      _w.XMLHttpRequest.prototype.send = function (body) {
        const call = {
          id: this._nh_id || ++_seq,
          type: "xhr",
          url: this._nh_url || "",
          method: this._nh_method || "GET",
          headers: this._nh_headers || {},
          bodyPreview: _truncate(_safeStringify(body), bodyPreviewLen),
          ts: Date.now(),
        };
        _push(call);
        console.log("[Jaal.NetHooks] xhr", call.method, call.url);

        this.addEventListener("loadend", function () {
          call.status = this.status;
          call.statusText = this.statusText;
          const ct = this.getResponseHeader && this.getResponseHeader("content-type") || "";
          if (ct.includes("json") || ct.includes("text")) {
            call.responsePreview = _truncate(this.responseText, responsePreviewLen);
          }
        });

        return _origXhrSend.call(this, body);
      };
    }

    function _uninstallXhr() {
      _w.XMLHttpRequest.prototype.open = _origXhrOpen;
      _w.XMLHttpRequest.prototype.send = _origXhrSend;
      _w.XMLHttpRequest.prototype.setRequestHeader = _origXhrSetHeader;
    }

    function _installWs() {
      if (!_origWS) return;

      function PatchedWebSocket(url, protocols) {
        const ws = protocols !== undefined ? new _origWS(url, protocols) : new _origWS(url);
        const wsCall = {
          id: ++_seq,
          type: "websocket",
          url: String(url),
          ts: Date.now(),
          frames: [],
        };
        _push(wsCall);
        console.log("[Jaal.NetHooks] WebSocket", url);

        ws.addEventListener("message", (evt) => {
          if (wsCall.frames.length < maxWsFrames) {
            wsCall.frames.push({ dir: "in", data: _truncate(String(evt.data), 200), ts: Date.now() });
          }
        });

        const _origWsSend = ws.send.bind(ws);
        ws.send = function (data) {
          if (wsCall.frames.length < maxWsFrames) {
            wsCall.frames.push({ dir: "out", data: _truncate(String(data), 200), ts: Date.now() });
          }
          return _origWsSend(data);
        };

        return ws;
      }

      PatchedWebSocket.prototype = _origWS.prototype;
      Object.setPrototypeOf(PatchedWebSocket, _origWS);
      PatchedWebSocket.CONNECTING = _origWS.CONNECTING;
      PatchedWebSocket.OPEN = _origWS.OPEN;
      PatchedWebSocket.CLOSING = _origWS.CLOSING;
      PatchedWebSocket.CLOSED = _origWS.CLOSED;

      _w.WebSocket = PatchedWebSocket;
    }

    function _uninstallWs() {
      if (_origWS) _w.WebSocket = _origWS;
    }

    return {
      start() {
        if (active) return;
        active = true;
        _installFetch();
        _installXhr();
        _installWs();
        console.log("[Jaal.NetHooks] installed (fetch + XHR + WebSocket). maxBuffer=" + maxBuffer);
      },

      stop() {
        if (!active) return;
        active = false;
        _uninstallFetch();
        _uninstallXhr();
        _uninstallWs();
        console.log("[Jaal.NetHooks] uninstalled — captured", calls.length, "calls");
      },

      isActive() { return active; },

      getAndClear() {
        const copy = [...calls];
        calls = [];
        return copy;
      },

      snapshot() { return [...calls]; },

      clear() { calls = []; },
    };
  }

  ns.NetHooks = { create };
  console.log("[Jaal] net-hooks loaded");

})(typeof globalThis !== "undefined" ? globalThis : this);
