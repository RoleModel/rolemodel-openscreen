/*
 * Live reload, served only under --watch and injected by lib/studio-ui.mjs.
 *
 * The reconnect branch is the important one: `node --watch` restarts the whole
 * server, which drops this stream — so a successful reconnect after an error
 * means new code is serving, and the page should reload.
 */
(() => {
  const RETRY_MS = 400;
  let dropped = false;
  const connect = () => {
    const s = new EventSource("/api/reload");
    s.onopen = () => { if (dropped) location.reload(); };
    s.onmessage = () => location.reload();
    s.onerror = () => { dropped = true; s.close(); setTimeout(connect, RETRY_MS); };
  };
  connect();
})();
