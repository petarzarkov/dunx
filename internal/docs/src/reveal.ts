import { useEffect, useRef, useState } from 'react';

/**
 * Tracks an element against the viewport, for CSS to key motion off.
 *
 * `revealed` latches on the first intersection and drives the one-shot entrance
 * transitions. `inView` keeps following, which is what lets a looping animation
 * stop when nobody is looking at it: an infinite keyframe animation off screen
 * costs what one on screen costs, and the request pulse in `RequestFlow` runs
 * for as long as the page is open.
 *
 * One observer answers both, so the live half adds no second subscription. It is
 * no longer disconnected after the first hit for that reason.
 * `prefers-reduced-motion` is honoured in CSS rather than here, so both flags land
 * either way and only the motion is dropped.
 */
export const useReveal = <T extends HTMLElement>(): {
  ref: React.RefObject<T | null>;
  revealed: boolean;
  inView: boolean;
} => {
  const ref = useRef<T>(null);
  // Initialized from the capability check rather than set from the effect: with no
  // observer there is nothing to wait for, so the first paint is the revealed one
  // and the animation runs.
  const blind = typeof IntersectionObserver === 'undefined';
  const [revealed, setRevealed] = useState(blind);
  const [inView, setInView] = useState(blind);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          setInView(entry.isIntersecting);
          if (entry.isIntersecting) setRevealed(true);
        }
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.12 },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return { ref, revealed, inView };
};
