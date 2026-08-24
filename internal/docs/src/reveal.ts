import { useEffect, useRef, useState } from 'react';

/**
 * Marks an element once it has scrolled into view, so CSS can transition it in.
 *
 * The observer is dropped after the first intersection: these are one-shot
 * entrances, and leaving observers attached to every section on a long page
 * costs more than the effect is worth. `prefers-reduced-motion` is honoured in
 * CSS rather than here, so the attribute lands either way and only the
 * transition is dropped.
 */
export const useReveal = <T extends HTMLElement>(): {
  ref: React.RefObject<T | null>;
  revealed: boolean;
} => {
  const ref = useRef<T>(null);
  // Initialized from the capability check rather than set from the effect: with no
  // observer there is nothing to wait for, so the first paint is the revealed one.
  const [revealed, setRevealed] = useState(
    () => typeof IntersectionObserver === 'undefined',
  );

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          setRevealed(true);
          observer.disconnect();
        }
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.12 },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return { ref, revealed };
};
