/*
 * Cognito - Fullscreen for Claude Artifacts
 *
 * Design constraints:
 *  1. Never move the artifact iframe in the DOM. Reparenting reloads it,
 *     destroying the injected artifact and any in-panel state.
 *  2. position:fixed resolves against the nearest transformed ancestor,
 *     not the viewport. Transform-type properties are neutralized up the
 *     ancestor chain while maximized.
 *  3. z-index only competes globally from the root stacking context.
 *     Ancestors that create stacking contexts trap the iframe's z-index,
 *     letting the backdrop paint on top. Those are neutralized too.
 *  4. The page observer must never react to mutations this extension
 *     makes, and must never do layout-forcing work synchronously.
 *  5. The toggle button is anchored to the artifact iframe, not the
 *     viewport, so it tracks the native toolbar/close-X in any layout
 *     (e.g. pushed down by the incognito banner) and never collides.
 *  6. Claude's own modals (e.g. the "open external link?" confirm) render
 *     in the page at a normal z-index; while maximized the iframe buries
 *     them, so they are lifted above it and restored exactly on exit.
 */

(() => {
  const IFRAME_SELECTOR = 'iframe[src*="claudeusercontent.com"]';
  const ALLOWED_PATHS = ["/chat", "/new"];

  // ---- Button placement (all px) ----
  const RIGHT_GAP = 14; // docked: distance from the right edge
  const TOP_GAP_NORMAL = 4; // docked: relative to the iframe's top edge
  const RIGHT_GAP_MAX = 12; // fullscreen: distance from the right edge
  const TOP_GAP_MAX = 12; // fullscreen: distance from the top

  function onAllowedPage() {
    const p = location.pathname;
    return ALLOWED_PATHS.some((a) => p === a || p.startsWith(a + "/"));
  }

  const NEUTRALIZE = [
    ["transform", "none"],
    ["perspective", "none"],
    ["filter", "none"],
    ["backdrop-filter", "none"],
    ["will-change", "auto"],
    ["contain", "none"],
    ["container-type", "normal"],
    ["z-index", "auto"],
    ["isolation", "auto"],
    ["opacity", "1"],
    ["mix-blend-mode", "normal"],
  ];

  const SVG_OPEN =
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  const ICON_MAXIMIZE =
    SVG_OPEN +
    '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';
  const ICON_MINIMIZE =
    SVG_OPEN +
    '<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/></svg>';

  const Z_OVERLAY = 2147483640; // above the maximized iframe (z 2147483600 in content.css)

  let state = null;
  let button = null;
  let liftedOverlays = [];

  function artifactIframeExists() {
    return !!document.querySelector(IFRAME_SELECTOR);
  }

  function findArtifactIframe() {
    const frames = [...document.querySelectorAll(IFRAME_SELECTOR)];
    let best = null;
    let bestArea = 0;
    for (const f of frames) {
      const r = f.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) {
        bestArea = area;
        best = f;
      }
    }
    return bestArea > 0 ? best : null;
  }

  function patchAncestors(iframe) {
    const patches = [];
    let el = iframe.parentElement;
    while (el && el !== document.documentElement) {
      const cs = getComputedStyle(el);
      for (const [prop, neutral] of NEUTRALIZE) {
        const current = cs.getPropertyValue(prop);
        if (current && current !== neutral && current !== "") {
          patches.push({
            el,
            prop,
            value: el.style.getPropertyValue(prop),
            priority: el.style.getPropertyPriority(prop),
          });
          el.style.setProperty(prop, neutral, "important");
        }
      }
      el = el.parentElement;
    }
    return patches;
  }

  function unpatchAncestors(patches) {
    for (const { el, prop, value, priority } of patches) {
      if (value) {
        el.style.setProperty(prop, value, priority);
      } else {
        el.style.removeProperty(prop);
      }
    }
  }

  function isOursOrShell(el) {
    if (!el || el.nodeType !== 1) return false;
    if (button && (el === button || button.contains(el))) return true;
    if (state && state.backdrop && el === state.backdrop) return true;
    if (state && state.iframe && (el === state.iframe || el.contains(state.iframe))) return true;
    return false;
  }

  function liftableAncestor(el) {
    let last = null, p = el;
    while (p && p !== document.body) {
      if (getComputedStyle(p).position !== "static") last = p;
      p = p.parentElement;
    }
    return last;
  }

  function liftOverlays() {
    if (!state) return;
    const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"]');
    for (const d of dialogs) {
      const top = liftableAncestor(d);
      if (!top || isOursOrShell(top) || liftedOverlays.some((o) => o.el === top)) continue;
      liftedOverlays.push({
        el: top,
        value: top.style.getPropertyValue("z-index"),
        priority: top.style.getPropertyPriority("z-index"),
      });
      top.style.setProperty("z-index", String(Z_OVERLAY), "important");
    }
  }

  function unliftOverlays() {
    for (const { el, value, priority } of liftedOverlays) {
      if (value) el.style.setProperty("z-index", value, priority);
      else el.style.removeProperty("z-index");
    }
    liftedOverlays = [];
  }

  function maximize() {
    if (state || !onAllowedPage()) return;
    const iframe = findArtifactIframe();
    if (!iframe) return;

    const backdrop = document.createElement("div");
    backdrop.className = "cgn-backdrop";
    document.body.appendChild(backdrop);

    const patches = patchAncestors(iframe);
    iframe.classList.add("cgn-max");
    document.documentElement.classList.add("cgn-noscroll");

    state = { iframe, patches, backdrop };
    liftOverlays();
    syncButton();
  }

  function restore() {
    if (!state) return;
    const { iframe, patches, backdrop } = state;
    state = null;

    iframe.classList.remove("cgn-max");
    unpatchAncestors(patches);
    unliftOverlays();
    backdrop.remove();
    document.documentElement.classList.remove("cgn-noscroll");
    syncButton();
  }

  function toggle() {
    state ? restore() : maximize();
  }

  function ensureButton() {
    if (button) return;
    button = document.createElement("button");
    button.className = "cgn-toggle";
    button.type = "button";
    button.addEventListener("click", toggle);
    document.body.appendChild(button);
    syncButton();
  }

  // Anchor to the artifact iframe's top-right corner. Reads layout (docked
  // only) then writes once; called from the throttled queueSync path.
  function positionButton() {
    if (!button) return;

    let top, right;
    if (state) {
      top = TOP_GAP_MAX;
      right = RIGHT_GAP_MAX;
    } else {
      const iframe = findArtifactIframe();
      if (!iframe) return;
      top = Math.max(0, Math.round(iframe.getBoundingClientRect().top + TOP_GAP_NORMAL));
      right = RIGHT_GAP;
    }

    const topPx = top + "px";
    const rightPx = right + "px";
    if (button.style.top !== topPx) button.style.top = topPx;
    if (button.style.right !== rightPx) button.style.right = rightPx;
  }

  function syncButton() {
    if (!button) return;

    const visible = state || (onAllowedPage() && artifactIframeExists());
    const display = visible ? "" : "none";
    if (button.style.display !== display) button.style.display = display;

    const mode = state ? "restore" : "maximize";
    if (button.dataset.mode !== mode) {
      button.dataset.mode = mode;
      button.innerHTML = state ? ICON_MINIMIZE : ICON_MAXIMIZE;
      button.setAttribute(
        "aria-label",
        state ? "Restore artifact (Esc)" : "Expand artifact edge-to-edge"
      );
      button.title = state
        ? "Restore artifact (Esc)"
        : "Expand artifact edge-to-edge";
    }

    if (visible) positionButton();
  }

  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && state) {
        e.stopPropagation();
        restore();
      }
    },
    true
  );

  let syncQueued = false;
  function queueSync() {
    if (syncQueued) return;
    syncQueued = true;
    setTimeout(() => {
      syncQueued = false;
      if (state && !document.contains(state.iframe)) {
        restore();
        return;
      }
      if (state) liftOverlays();
      syncButton();
    }, 250);
  }

  function isOwnMutation(m) {
    const t = m.target;
    if (button && (t === button || button.contains(t))) return true;
    if (state && state.backdrop && t === state.backdrop) return true;
    if (liftedOverlays.some((o) => o.el === t || (o.el.contains && o.el.contains(t)))) return true;
    return false;
  }

  const pageObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (!isOwnMutation(m)) {
        if (state) liftOverlays();
        queueSync();
        return;
      }
    }
  });

  function init() {
    ensureButton();
    pageObserver.observe(document.body, { childList: true, subtree: true });
    // Reposition on layout shifts the observer won't catch (docked anchor
    // tracks the iframe's top). Capture scroll so nested containers are seen.
    window.addEventListener("resize", queueSync, { passive: true });
    window.addEventListener("scroll", queueSync, { passive: true, capture: true });
    setInterval(queueSync, 2000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();