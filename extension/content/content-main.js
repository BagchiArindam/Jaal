/**
 * Jaal content-script entry point.
 *
 * Bootstrapper: waits for activation messages from background and dispatches
 * to the appropriate feature. Currently handles:
 *   - "jaal-activate-skeleton" → window.Jaal.skeletonOverlay.show()
 *
 * Additional handlers arrive as later phases land (picker, toolbar, net recorder).
 */
(function () {
  "use strict";

  // Guard against double-load when the user invokes the context menu twice.
  if (window.__jaalContentMainLoaded) {
    console.log("[Jaal content-main] already loaded — skipping re-init");
  } else {
    window.__jaalContentMainLoaded = true;

    const log = (window.Jaal && window.Jaal.makeLogger)
      ? window.Jaal.makeLogger("content-main")
      : console;

    const B = typeof browser !== "undefined" ? browser : chrome;

    B.runtime.onMessage.addListener((msg) => {
      if (!msg || typeof msg.type !== "string") return;
      if (msg.type === "jaal-activate-skeleton") {
        if (window.Jaal && window.Jaal.skeletonOverlay && window.Jaal.skeletonOverlay.show) {
          log.info("activate_skeleton", { phase: "mutate" });
          window.Jaal.skeletonOverlay.show();
        } else {
          console.error("[Jaal content-main] skeletonOverlay not available");
        }
      }
    });

    log.info("content_main_ready", { phase: "init" });
  }
})();
