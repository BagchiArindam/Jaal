/**
 * content/net-recorder-injector.js — MV2 Firefox only.
 *
 * Runs in isolated world at document_start. Injects the MAIN-world net-hooks
 * scripts into the page via <script src> tags.
 *
 * Why: Firefox MV2 content_scripts always run in the isolated world; there is
 * no "world": "MAIN" option in MV2. The only way to execute code in the page's
 * main JS context (needed to intercept fetch/XHR) is to inject a <script> element
 * whose src resolves to a web_accessible_resource URL.
 *
 * The three injected scripts (logger.js, net-hooks.js, net-recorder-main.js)
 * are declared in manifest.v2.json web_accessible_resources so the browser
 * permits the chrome-extension:// URL to be loaded by the page.
 */
(function () {
  "use strict";

  const _ext = typeof browser !== "undefined" ? browser : chrome;
  const MAIN_SCRIPTS = [
    "shared/logger.js",
    "shared/net-hooks.js",
    "content/net-recorder-main.js",
  ];

  function inject(src) {
    const s = document.createElement("script");
    s.src = _ext.runtime.getURL(src);
    s.dataset.jaalMain = "1";
    (document.head || document.documentElement).appendChild(s);
  }

  MAIN_SCRIPTS.forEach(inject);
  console.log("[Jaal net-recorder-injector] injected", MAIN_SCRIPTS.length, "MAIN-world scripts");
})();
