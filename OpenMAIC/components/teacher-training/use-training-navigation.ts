'use client';

import { useEffect, useRef, useState } from 'react';
import {
  parseTrainingLocation,
  trainingHref,
  type TrainingLocation,
} from '@/lib/teacher-training/navigation';

/** Preserve Next's history state. Cancelled traversal restores the existing
 * entry instead of inserting a duplicate and destroying the forward stack. */
export function useTrainingNavigation(
  initialLocation: TrainingLocation,
  options: {
    canLeave: (target: TrainingLocation) => boolean;
    onNavigate: (target: TrainingLocation) => void;
  },
) {
  const [location, setLocation] = useState<TrainingLocation>(initialLocation);
  const callbacks = useRef(options);
  const current = useRef({ index: 0, href: '/teacher-training' });
  const restoring = useRef(false);
  useEffect(() => {
    callbacks.current = options;
  });

  useEffect(() => {
    const initial = parseTrainingLocation(window.location.search);
    const index = Number.isInteger(window.history.state?.trainingIndex)
      ? window.history.state.trainingIndex
      : 0;
    current.current = { index, href: trainingHref(initial) };
    window.history.replaceState(
      { ...window.history.state, trainingIndex: index },
      '',
      current.current.href,
    );
    const pop = (event: PopStateEvent) => {
      if (restoring.current) {
        restoring.current = false;
        return;
      }
      const target = parseTrainingLocation(window.location.search);
      if (!callbacks.current.canLeave(target)) {
        const targetIndex = event.state?.trainingIndex;
        if (Number.isInteger(targetIndex) && targetIndex !== current.current.index) {
          restoring.current = true;
          window.history.go(current.current.index - targetIndex);
        } else {
          window.history.pushState(
            { ...window.history.state, trainingIndex: current.current.index },
            '',
            current.current.href,
          );
        }
        return;
      }
      current.current = {
        index: event.state?.trainingIndex ?? 0,
        href: trainingHref(target),
      };
      setLocation(target);
      callbacks.current.onNavigate(target);
    };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);

  function commit(target: TrainingLocation, replace = false) {
    const href = trainingHref(target);
    if (href !== current.current.href) {
      const index = current.current.index + (replace ? 0 : 1);
      window.history[replace ? 'replaceState' : 'pushState'](
        { ...window.history.state, trainingIndex: index },
        '',
        href,
      );
      current.current = { index, href };
    }
    setLocation(target);
  }

  function navigate(target: TrainingLocation) {
    if (trainingHref(target) === current.current.href) return;
    if (restoring.current || !callbacks.current.canLeave(target)) return;
    commit(target);
    callbacks.current.onNavigate(target);
  }
  return { location, navigate, commit };
}
