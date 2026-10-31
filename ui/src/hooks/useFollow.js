import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Keeps a scrolling list on its newest line while the reader is at the bottom. When they scroll up to
 * read, it stays where they are and counts what arrived, so new lines never yank the view away.
 * Only the list scrolls, never the page.
 * @param {number} count  number of items in the list
 */
export function useFollow(count) {
  const ref = useRef(/** @type {HTMLElement | null} */ (null));
  const pinned = useRef(true);
  const latest = useRef(count);
  const base = useRef(count);
  const [unseen, setUnseen] = useState(0);

  useLayoutEffect(() => {
    latest.current = count;
    const el = ref.current;
    if (!el) return;
    if (pinned.current || count < base.current) {
      el.scrollTop = el.scrollHeight;
      base.current = count;
      setUnseen(0);
    } else setUnseen(count - base.current);
  }, [count]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (bottom !== pinned.current) {
      base.current = latest.current;
      setUnseen(0);
    }
    pinned.current = bottom;
  };

  const jump = () => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    pinned.current = true;
    base.current = latest.current;
    setUnseen(0);
  };

  return { ref, onScroll, unseen, jump };
}
