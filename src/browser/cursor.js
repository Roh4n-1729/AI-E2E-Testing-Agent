/**
 * A visible cursor + click ripple, injected into every page so a human can WATCH what the agent does
 * (live view, headed window, screenshots, demo GIF). Browser automation moves no real OS cursor, so
 * without this the page just changes by itself.
 *
 * Automation delivers a click as a single mousemove, so the raw event would make the cursor teleport.
 * The overlay therefore GLIDES: each new target starts an eased tween (duration scales with distance,
 * driven by requestAnimationFrame and wall-clock time, so it stays correct under frame drops). The
 * last position is kept in sessionStorage so after a navigation the cursor continues from where it
 * was instead of restarting in the corner.
 *
 * It only listens to the page's own mouse events, so it works for any driver that produces them
 * (Stagehand/CDP clicks and Playwright replay alike). It never intercepts events (pointer-events: none).
 * `window.__aie2eCursorPos` is always the TARGET (where the mouse really is); the drawn cursor lags it
 * by at most a few hundred ms. Runs as a string because it is executed inside the page, not in Node.
 */
export const CURSOR_SCRIPT = `(() => { try {
  if (window.__aie2eCursor) return;
  window.__aie2eCursor = true;
  const ID = '__aie2e_cursor';
  const KEY = '__aie2e_cursor_pos';
  let root = null;
  let cur = null;       // where the cursor is DRAWN right now
  let target = null;    // where the mouse really is
  let from = null, t0 = 0, dur = 0, raf = 0;

  try { const s = JSON.parse(sessionStorage.getItem(KEY) || 'null'); if (s && isFinite(s.x) && isFinite(s.y)) { cur = target = { x: s.x, y: s.y }; } } catch (_) {}

  const mount = () => {
    const host = document.documentElement || document.body;
    if (!host) return null;
    const existing = document.getElementById(ID);
    if (existing) return (root = existing);
    root = document.createElement('div');
    root.id = ID;
    root.setAttribute('aria-hidden', 'true');
    root.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;will-change:transform;';
    root.innerHTML =
      '<svg width="22" height="22" viewBox="0 0 22 22" style="position:absolute;left:0;top:0;transform:translate(-3px,-2px);filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))">' +
      '<path d="M3 2 L3 17 L7.2 13.2 L10 19.5 L12.6 18.4 L9.9 12.2 L15.5 12.2 Z" fill="#e96c2f" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    host.appendChild(root);
    return root;
  };
  const draw = () => {
    const r = mount();
    if (r && cur) r.style.transform = 'translate3d(' + cur.x + 'px,' + cur.y + 'px,0)';
  };
  const ease = (t) => 1 - Math.pow(1 - t, 3); // easeOutCubic: quick start, soft landing
  const frame = (now) => {
    raf = 0;
    if (!from || !target) return;
    const t = Math.min(1, (now - t0) / dur);
    const k = ease(t);
    cur = { x: from.x + (target.x - from.x) * k, y: from.y + (target.y - from.y) * k };
    draw();
    if (t < 1) raf = requestAnimationFrame(frame);
  };
  const persist = () => { try { sessionStorage.setItem(KEY, JSON.stringify(target)); } catch (_) {} };
  const move = (x, y) => {
    target = { x, y };
    window.__aie2eCursorPos = target;
    persist();
    if (!cur) { cur = { x, y }; draw(); return; } // first sighting: nothing to glide from
    const dist = Math.hypot(x - cur.x, y - cur.y);
    if (dist < 1) return;
    from = { x: cur.x, y: cur.y };
    t0 = performance.now();
    dur = Math.max(140, Math.min(520, 120 + dist * 0.45));
    if (!raf) raf = requestAnimationFrame(frame);
  };
  const ripple = (x, y) => {
    const host = document.documentElement;
    if (!host) return;
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;left:' + (x - 14) + 'px;top:' + (y - 14) + 'px;width:28px;height:28px;border-radius:50%;border:3px solid #e96c2f;pointer-events:none;z-index:2147483646;opacity:.9;transition:transform .45s ease-out,opacity .45s ease-out;';
    host.appendChild(d);
    requestAnimationFrame(() => { d.style.transform = 'scale(2.2)'; d.style.opacity = '0'; });
    setTimeout(() => d.remove(), 520);
  };
  const opts = { capture: true, passive: true };
  addEventListener('mousemove', (e) => move(e.clientX, e.clientY), opts);
  addEventListener('mousedown', (e) => { move(e.clientX, e.clientY); ripple(e.clientX, e.clientY); }, opts);
  addEventListener('DOMContentLoaded', () => { draw(); });
  if (target) window.__aie2eCursorPos = target;
  draw();
} catch (_) { /* a debugging aid must never break or pollute the page under test */ } })();`;
