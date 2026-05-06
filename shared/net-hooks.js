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
 *   hooks.pushAction(obj)         // push a user-action event from the overlay
 *
 * Recorded call object:
 *   { id, type: "fetch"|"xhr"|"websocket"|"action"|"transform",
 *     url, method, headers, body, bodyEncoding, contentType,
 *     status, responseHeaders, responseBody, responseEncoding, ts, error }
 * WebSocket calls additionally have: { frames: [{dir:"in"|"out", data, ts}] }
 * Action calls: { eventType, target, value, key, ts }
 * Transform calls: { fn, argPreview, returnPreview, stack, ts }
 */
(function (global) {
  "use strict";

  const ns = (global.Jaal = global.Jaal || {});

  const _w =
    typeof unsafeWindow !== "undefined"
      ? unsafeWindow
      : typeof window !== "undefined"
      ? window
      : global;

  const BODY_CAP        = 1024 * 1024; // 1 MB body capture
  const FRAME_CAP       = 500;         // chars per WS frame preview
  const TRANSFORM_CAP   = 1024;        // chars per transform arg/return
  const ACTION_VAL_CAP  = 200;         // chars per action value

  function _truncate(str, n) {
    if (str === null || str === undefined) return "";
    const s = typeof str === "string" ? str : _safeStringify(str);
    return s.length > n ? s.substring(0, n) + "…[truncated]" : s;
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
        h.forEach(function (v, k) { obj[k] = v; });
      } else if (h && typeof h === "object") {
        Object.assign(obj, h);
      }
    } catch (_) {}
    return obj;
  }

  // Encode a body as string, noting whether it was truncated.
  // Returns { body: string, bodyEncoding: "utf8"|"truncated" }
  function _encodeBody(raw, contentType) {
    if (raw === null || raw === undefined || raw === "") return { body: "", bodyEncoding: "utf8" };
    const str = _safeStringify(raw);
    if (str.length > BODY_CAP) {
      return { body: str.substring(0, BODY_CAP), bodyEncoding: "truncated" };
    }
    const ct = (contentType || "").toLowerCase();
    const isText = ct.includes("json") || ct.includes("text") || ct.includes("xml") ||
                   ct.includes("javascript") || ct.includes("form");
    return { body: str, bodyEncoding: isText ? "utf8" : "base64" };
  }

  // Capture a short stack line for transform hooks (skip our own frames).
  function _callerLine() {
    try {
      const lines = new Error().stack.split("\n");
      for (var i = 2; i < Math.min(lines.length, 8); i++) {
        var line = lines[i].trim();
        if (line && !line.includes("net-hooks")) return line;
      }
      return lines[2] || "";
    } catch (_) { return ""; }
  }

  function create(opts) {
    const maxBuffer   = (opts && opts.maxBuffer)   || 500;
    const maxWsFrames = (opts && opts.maxWsFrames) || 100;

    let calls  = [];
    let active = false;
    let _seq   = 0;

    const _origFetch            = _w.fetch ? _w.fetch.bind(_w) : null;
    const _origXhrOpen          = _w.XMLHttpRequest.prototype.open;
    const _origXhrSend          = _w.XMLHttpRequest.prototype.send;
    const _origXhrSetHeader     = _w.XMLHttpRequest.prototype.setRequestHeader;
    const _origWS               = _w.WebSocket;
    const _origBtoa             = _w.btoa;
    const _origAtob             = _w.atob;
    const _origJsonStringify    = _w.JSON && _w.JSON.stringify;
    const _origEncodeURIComponent = _w.encodeURIComponent;

    function _push(call) {
      if (calls.length >= maxBuffer) calls.shift();
      calls.push(call);
    }

    // Check if URL should be intercepted. Skip third-party analytics.
    function _shouldIntercept(url) {
      if (!url) return true;
      try {
        const pageOrigin = _w.location.origin;
        const reqUrl = new URL(url, pageOrigin);
        const reqOrigin = reqUrl.origin;
        // Only intercept same-origin requests; skip third-party analytics
        if (reqOrigin !== pageOrigin) {
          const host = reqUrl.hostname;
          // Skip known analytics/tracking domains
          if (/analytics\.|tracking\.|cdn\.|google-analytics|newrelic|segment|hotjar|crash|sentry|bugsnag|awswaf/i.test(host)) {
            return false;
          }
        }
        return true;
      } catch (_) {
        return true; // If URL parsing fails, allow it (relative URL, etc.)
      }
    }

    // ─── fetch ────────────────────────────────────────────────────────

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

        // Skip third-party analytics requests — pass through to original fetch
        if (!_shouldIntercept(url)) {
          return _origFetch(input, init);
        }

        const method  = (init && init.method) || (input && typeof input === "object" && input.method) || "GET";
        const headers = _headersToObj((init && init.headers) || (input && typeof input === "object" && input.headers));
        const ct      = headers["content-type"] || headers["Content-Type"] || "";
        const enc     = _encodeBody(init && init.body, ct);

        const call = { id, type: "fetch", url, method, headers,
                       body: enc.body, bodyEncoding: enc.bodyEncoding, contentType: ct,
                       ts: Date.now() };
        _push(call);
        console.log("[Jaal.NetHooks] fetch", method, url);

        return _origFetch(input, init).then(
          function (resp) {
            call.status         = resp.status;
            call.statusText     = resp.statusText;
            call.responseHeaders = _headersToObj(resp.headers);
            const rct           = resp.headers.get("content-type") || "";
            call.responseContentType = rct;
            return resp.clone().text().then(function (text) {
              const re = _encodeBody(text, rct);
              call.responseBody     = re.body;
              call.responseEncoding = re.bodyEncoding;
              return resp;
            }).catch(function () { return resp; });
          },
          function (err) {
            call.error = String(err);
            console.error("[Jaal.NetHooks] fetch error", url, err);
            throw err;
          }
        );
      };
    }

    function _uninstallFetch() { if (_origFetch) _w.fetch = _origFetch; }

    // ─── XHR ─────────────────────────────────────────────────────────

    function _installXhr() {
      _w.XMLHttpRequest.prototype.open = function (method, url) {
        this._nh_id      = ++_seq;
        this._nh_method  = String(method).toUpperCase();
        this._nh_url     = String(url);
        this._nh_headers = {};
        return _origXhrOpen.apply(this, arguments);
      };

      _w.XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
        if (this._nh_headers) this._nh_headers[k] = v;
        return _origXhrSetHeader.call(this, k, v);
      };

      _w.XMLHttpRequest.prototype.send = function (body) {
        // Skip third-party analytics requests
        if (!_shouldIntercept(this._nh_url)) {
          return _origXhrSend.call(this, body);
        }

        const ct  = (this._nh_headers && (this._nh_headers["content-type"] || this._nh_headers["Content-Type"])) || "";
        const enc = _encodeBody(body, ct);
        const call = {
          id: this._nh_id || ++_seq,
          type: "xhr",
          url: this._nh_url  || "",
          method: this._nh_method || "GET",
          headers: this._nh_headers || {},
          body: enc.body, bodyEncoding: enc.bodyEncoding, contentType: ct,
          ts: Date.now(),
        };
        _push(call);
        console.log("[Jaal.NetHooks] xhr", call.method, call.url);

        this.addEventListener("loadend", function () {
          call.status         = this.status;
          call.statusText     = this.statusText;
          const rct           = (this.getResponseHeader && this.getResponseHeader("content-type")) || "";
          call.responseContentType = rct;
          const re            = _encodeBody(this.responseText, rct);
          call.responseBody   = re.body;
          call.responseEncoding = re.bodyEncoding;
        });

        return _origXhrSend.call(this, body);
      };
    }

    function _uninstallXhr() {
      _w.XMLHttpRequest.prototype.open             = _origXhrOpen;
      _w.XMLHttpRequest.prototype.send             = _origXhrSend;
      _w.XMLHttpRequest.prototype.setRequestHeader = _origXhrSetHeader;
    }

    // ─── WebSocket ────────────────────────────────────────────────────

    function _installWs() {
      if (!_origWS) return;
      function PatchedWebSocket(url, protocols) {
        const ws = protocols !== undefined ? new _origWS(url, protocols) : new _origWS(url);
        const wsCall = { id: ++_seq, type: "websocket", url: String(url), ts: Date.now(), frames: [] };
        _push(wsCall);
        console.log("[Jaal.NetHooks] WebSocket", url);

        ws.addEventListener("message", function (evt) {
          if (wsCall.frames.length < maxWsFrames) {
            wsCall.frames.push({ dir: "in", data: _truncate(String(evt.data), FRAME_CAP), ts: Date.now() });
          }
        });
        const _origWsSend = ws.send.bind(ws);
        ws.send = function (data) {
          if (wsCall.frames.length < maxWsFrames) {
            wsCall.frames.push({ dir: "out", data: _truncate(String(data), FRAME_CAP), ts: Date.now() });
          }
          return _origWsSend(data);
        };
        return ws;
      }
      PatchedWebSocket.prototype = _origWS.prototype;
      Object.setPrototypeOf(PatchedWebSocket, _origWS);
      // Copy read-only WebSocket state constants using defineProperty
      Object.defineProperty(PatchedWebSocket, 'CONNECTING', { value: _origWS.CONNECTING, writable: false });
      Object.defineProperty(PatchedWebSocket, 'OPEN',       { value: _origWS.OPEN,       writable: false });
      Object.defineProperty(PatchedWebSocket, 'CLOSING',    { value: _origWS.CLOSING,    writable: false });
      Object.defineProperty(PatchedWebSocket, 'CLOSED',     { value: _origWS.CLOSED,     writable: false });
      _w.WebSocket = PatchedWebSocket;
    }

    function _uninstallWs() { if (_origWS) _w.WebSocket = _origWS; }

    // ─── Transform hooks ──────────────────────────────────────────────

    function _installTransforms() {
      if (_origBtoa) {
        _w.btoa = function (s) {
          const r = _origBtoa.call(_w, s);
          _push({ id: ++_seq, type: "transform", fn: "btoa",
                  argPreview: _truncate(String(s), TRANSFORM_CAP),
                  returnPreview: _truncate(r, TRANSFORM_CAP),
                  stack: _callerLine(), ts: Date.now() });
          return r;
        };
      }
      if (_origAtob) {
        _w.atob = function (s) {
          const r = _origAtob.call(_w, s);
          _push({ id: ++_seq, type: "transform", fn: "atob",
                  argPreview: _truncate(String(s), TRANSFORM_CAP),
                  returnPreview: _truncate(r, TRANSFORM_CAP),
                  stack: _callerLine(), ts: Date.now() });
          return r;
        };
      }
      if (_origEncodeURIComponent) {
        _w.encodeURIComponent = function (s) {
          const r = _origEncodeURIComponent.call(_w, s);
          if (String(s).length > 8) {
            _push({ id: ++_seq, type: "transform", fn: "encodeURIComponent",
                    argPreview: _truncate(String(s), TRANSFORM_CAP),
                    returnPreview: _truncate(r, TRANSFORM_CAP),
                    stack: _callerLine(), ts: Date.now() });
          }
          return r;
        };
      }
      // Only record JSON.stringify when applied to non-trivial objects (likely request payloads)
      if (_origJsonStringify) {
        _w.JSON.stringify = function (val) {
          const r = _origJsonStringify.apply(_w.JSON, arguments);
          if (val && typeof val === "object" && !Array.isArray(val)) {
            const keys = Object.keys(val);
            if (keys.length >= 1 && keys.length <= 20) {
              _push({ id: ++_seq, type: "transform", fn: "JSON.stringify",
                      argPreview: _truncate(r, TRANSFORM_CAP),
                      returnPreview: "",
                      stack: _callerLine(), ts: Date.now() });
            }
          }
          return r;
        };
      }
    }

    function _uninstallTransforms() {
      if (_origBtoa)                _w.btoa                = _origBtoa;
      if (_origAtob)                _w.atob                = _origAtob;
      if (_origEncodeURIComponent)  _w.encodeURIComponent  = _origEncodeURIComponent;
      if (_origJsonStringify)       _w.JSON.stringify       = _origJsonStringify;
    }

    return {
      start() {
        if (active) return;
        active = true;
        _installFetch();
        _installXhr();
        _installWs();
        _installTransforms();
        console.log("[Jaal.NetHooks] installed (fetch + XHR + WebSocket + transforms). maxBuffer=" + maxBuffer);
      },

      stop() {
        if (!active) return;
        active = false;
        _uninstallFetch();
        _uninstallXhr();
        _uninstallWs();
        _uninstallTransforms();
        console.log("[Jaal.NetHooks] uninstalled — captured", calls.length, "calls");
      },

      isActive()    { return active; },
      getAndClear() { const copy = [...calls]; calls = []; return copy; },
      snapshot()    { return [...calls]; },
      clear()       { calls = []; },

      // Called by net-recorder-main.js to push user-action events from DOM listeners
      pushAction(actionCall) {
        _push(Object.assign({ id: ++_seq }, actionCall));
      },
    };
  }

  ns.NetHooks = { create };
  console.log("[Jaal] net-hooks loaded");

})(typeof globalThis !== "undefined" ? globalThis : this);
