/*
 * Live reload, injected by lib/studio-ui.mjs.
 *
 * The reconnect branch is the important one: `node --watch` restarts the whole
 * server, which drops this stream — so a successful reconnect after an error
 * means new code is serving, and the page should reload.
 *
 * But a reload is not free. render() calls dropEditor(), which unmounts the
 * native editor view, so reloading while the editor is open destroys it — and if
 * a video was playing, it stops. That is fine when you are editing the Studio and
 * looking at the Studio. It is not fine when someone is using the editor and a
 * file changes underneath them, which is exactly what happens now that the
 * watcher is on by default in a checkout.
 *
 * So a reload waits for the editor to be dismissed. `has-editor` on <body> is set
 * when the view is mounted and cleared by dropEditor, so it is the same signal
 * the placement logic uses rather than a second guess at it.
 */
(() => {
  const RETRY_MS = 400;
  let dropped = false;
  let pending = false;

  /** True while the native editor view is placed over the page. */
  const editorOpen = () => document.body.classList.contains("has-editor");

  const reload = () => location.reload();

  const want = () => {
    if (!editorOpen()) return reload();
    if (pending) return;
    pending = true;
    console.info("[rm-studio] update ready — holding the reload until the editor is closed");
    /*
     * Say so on screen, not just in the console.
     *
     * Holding the reload protects an open timeline, but held silently it means the
     * page you are looking at is not the code on disk — and there is no way to tell
     * from the outside. That cost real time: a CSS fix sat undelivered while the
     * stale sheet was debugged as if it were current. So the hold is visible, and
     * clicking it takes the update now.
     */
    const note = document.createElement("button");
    note.type = "button";
    note.textContent = "Update ready — reload";
    note.style.cssText =
      "position:fixed;inset-block-end:var(--op-space-medium);inset-inline-end:var(--op-space-medium);" +
      "z-index:60;font:inherit;font-size:var(--op-font-small);cursor:pointer;" +
      "padding:var(--op-space-2x-small) var(--op-space-small);border-radius:var(--op-radius-medium);" +
      "border:var(--op-border-width) solid var(--op-color-border);" +
      "background:var(--op-color-primary-minus-six);color:var(--op-color-neutral-minus-max)";
    note.onclick = reload;
    document.body.append(note);
    // Class changes are the signal, so watch for them rather than polling. Falling
    // back to an interval because a MutationObserver misses a page that replaced
    // <body> wholesale, and a missed update means a stale page forever.
    const check = () => {
      if (editorOpen()) return;
      clearInterval(timer);
      observer.disconnect();
      reload();
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    const timer = setInterval(check, 1000);
  };

  const connect = () => {
    const s = new EventSource("/api/reload");
    s.onopen = () => {
      if (dropped) want();
    };
    s.onmessage = () => want();
    s.onerror = () => {
      dropped = true;
      s.close();
      setTimeout(connect, RETRY_MS);
    };
  };
  connect();
})();
