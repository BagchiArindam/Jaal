/**
 * Jaal content-script entry point (isolated world).
 *
 * Routes background → content activation messages to the appropriate overlay.
 * Guards against double-load (context menu clicked twice).
 *
 * Handled messages:
 *   jaal-activate-skeleton      → window.Jaal.skeletonOverlay.show()
 *   jaal-activate-net-recorder  → window.Jaal.netRecorderOverlay.show()
 */
(function () {
  "use strict";

  if (window.__jaalContentMainLoaded) {
    console.log("[Jaal content-main] already loaded — skipping re-init");
    return;
  }
  window.__jaalContentMainLoaded = true;

  const log = (window.Jaal && window.Jaal.makeLogger)
    ? window.Jaal.makeLogger("content-main")
    : console;

  const B = typeof browser !== "undefined" ? browser : chrome;

  B.runtime.onMessage.addListener(function (msg) {
    if (!msg || typeof msg.type !== "string") return;

    if (msg.type === "jaal-activate-skeleton") {
      if (window.Jaal && window.Jaal.skeletonOverlay && window.Jaal.skeletonOverlay.show) {
        log.info("activate_skeleton", { phase: "mutate" });
        window.Jaal.skeletonOverlay.show();
      } else {
        console.error("[Jaal content-main] skeletonOverlay not available");
      }

    } else if (msg.type === "jaal-activate-net-recorder") {
      if (window.Jaal && window.Jaal.netRecorderOverlay && window.Jaal.netRecorderOverlay.show) {
        log.info("activate_net_recorder", { phase: "mutate" });
        window.Jaal.netRecorderOverlay.show();
      } else {
        console.error("[Jaal content-main] netRecorderOverlay not available");
      }
    }
  });

  log.info("content_main_ready", { phase: "init" });
})();
