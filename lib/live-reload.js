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
