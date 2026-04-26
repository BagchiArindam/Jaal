/**
 * shared/url-glob.js — tiny URL path glob matcher used to match saved config
 * pathPattern against the current URL path.
 *
 * Syntax:
 *   *   matches any character except `/` (one URL segment of free chars)
 *   **  matches any character including `/` (multiple segments)
 *   anything else is literal
 *
 * Examples:
 *   /products       → only /products
 *   /products/*     → /products/abc  but not /products/abc/def
 *   /products/**    → /products/abc, /products/abc/def, etc.
 *   *               → any single-segment path
 *   **              → any path
 *
 * Exposes: globalThis.Jaal.urlGlob.matches(glob, path) → boolean
 */
(function (global) {
  "use strict";
  const ns = (global.Jaal = global.Jaal || {});

  const _cache = Object.create(null);

  function _compile(glob) {
    if (_cache[glob]) return _cache[glob];
    let regex = "^";
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i];
      if (c === "*") {
        if (glob[i + 1] === "*") { regex += ".*"; i++; }
        else                     { regex += "[^/]*"; }
      } else if ("\\^$.|?+()[]{}".indexOf(c) >= 0) {
        regex += "\\" + c;
      } else {
        regex += c;
      }
    }
    regex += "$";
    return (_cache[glob] = new RegExp(regex));
  }

  function matches(glob, path) {
    if (typeof glob !== "string" || typeof path !== "string") return false;
    if (glob === "" || glob === "*" || glob === "**") return true;
    try {
      return _compile(glob).test(path);
    } catch (e) {
      console.warn("[Jaal urlGlob] bad pattern:", glob, e && e.message);
      return false;
    }
  }

  ns.urlGlob = { matches };
  console.log("[Jaal] url-glob loaded");
})(typeof globalThis !== "undefined" ? globalThis : this);
