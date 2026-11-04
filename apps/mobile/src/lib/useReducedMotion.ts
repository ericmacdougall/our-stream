// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/** Follows the system "reduce motion" setting; defaults to false until the first read. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let live = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => {
        if (live) setReduced(v);
      })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
  return reduced;
}
