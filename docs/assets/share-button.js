/* NEAR share button: adds an accessible "Share" button at the top right of the page header.
 *  - Uses the Web Share API (navigator.share) where available (phones, Safari, Edge, Chrome on Windows/Android).
 *  - Otherwise copies the page link (including any scenario in the URL hash) to the clipboard and shows a "Link copied" toast.
 * No external services, no analytics, no tracking.
 */
(function () {
  "use strict";
  if (window.__nearShareButton) return;
  window.__nearShareButton = true;
  var ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/><line x1="15.4" y1="6.5" x2="8.6" y2="10.5"/></svg>';
  var toast, timer;
  function showToast(msg) {
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "share-toast"; toast.setAttribute("role", "status"); toast.setAttribute("aria-live", "polite");
      document.body.appendChild(toast);
    }
    toast.textContent = msg; void toast.offsetWidth; toast.classList.add("on");
    clearTimeout(timer); timer = setTimeout(function () { toast.classList.remove("on"); }, 2200);
  }
  function legacyCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", ""); ta.setAttribute("aria-hidden", "true");
    ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px";
    document.body.appendChild(ta); ta.focus(); ta.select();
    try { ta.setSelectionRange(0, text.length); } catch (e) {}
    var ok = false; try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(ta); return ok;
  }
  function copyLink(url) {
    function done(ok) { if (ok) showToast("Link copied"); else window.prompt("Copy this link:", url); }
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      navigator.clipboard.writeText(url).then(function () { done(true); }, function () { done(legacyCopy(url)); });
    } else done(legacyCopy(url));
  }
  function share() {
    var url = location.href, data = { title: document.title, url: url };
    if (navigator.share) {
      navigator.share(data).catch(function (err) { if (err && err.name === "AbortError") return; copyLink(url); });
    } else copyLink(url);
  }
  function init() {
    if (document.querySelector(".share-btn")) return;
    var btn = document.createElement("button");
    btn.type = "button"; btn.className = "share-btn";
    btn.setAttribute("aria-label", "Share this page"); btn.setAttribute("title", "Share this page");
    btn.innerHTML = ICON + '<span class="share-text">Share</span>';
    btn.addEventListener("click", share);
    var host = document.querySelector(".header-inner");
    if (host) host.appendChild(btn); else { btn.className += " share-fixed"; document.body.appendChild(btn); }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
