import { RefObject, useCallback } from 'react';
import throttle from 'lodash/throttle';

type TUseScrollToRef = {
  targetRef: RefObject<HTMLDivElement>;
  callback: () => void;
  smoothCallback: () => void;
};

type ThrottledFunction = (() => void) & {
  cancel: () => void;
};

type ScrollToRefReturn = {
  scrollToRef?: ThrottledFunction;
  handleSmoothToRef: React.MouseEventHandler<HTMLButtonElement>;
};

/** Same leading+trailing coalescing as lodash's `throttle`, but keyed to
 *  animation frames instead of a fixed millisecond window - during streaming,
 *  a ResizeObserver can call this many times a second, and a fixed-ms window
 *  (the previous 145ms) makes the follow-scroll visibly step once per window
 *  instead of tracking new content continuously. */
function rafThrottle(fn: () => void): ThrottledFunction {
  let rafId: number | null = null;
  let pending = false;

  const flushOnNextFrame = () => {
    rafId = null;
    if (pending) {
      pending = false;
      fn();
      rafId = window.requestAnimationFrame(flushOnNextFrame);
    }
  };

  const throttled = (() => {
    if (rafId === null) {
      fn();
      rafId = window.requestAnimationFrame(flushOnNextFrame);
    } else {
      pending = true;
    }
  }) as ThrottledFunction;

  throttled.cancel = () => {
    if (rafId !== null) {
      window.cancelAnimationFrame(rafId);
      rafId = null;
    }
    pending = false;
  };

  return throttled;
}

export default function useScrollToRef({
  targetRef,
  callback,
  smoothCallback,
}: TUseScrollToRef): ScrollToRefReturn {
  const logAndScroll = (behavior: 'instant' | 'smooth', callbackFn: () => void) => {
    // Debugging:
    // console.log(`Scrolling with behavior: ${behavior}, Time: ${new Date().toISOString()}`);
    targetRef.current?.scrollIntoView({ behavior });
    callbackFn();
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const scrollToRef = useCallback(
    rafThrottle(() => logAndScroll('instant', callback)),
    [targetRef],
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const scrollToRefSmooth = useCallback(
    throttle(() => logAndScroll('smooth', smoothCallback), 750, { leading: true }),
    [targetRef],
  );

  const handleSmoothToRef: React.MouseEventHandler<HTMLButtonElement> = (e) => {
    e.preventDefault();
    scrollToRefSmooth();
  };

  return {
    scrollToRef,
    handleSmoothToRef,
  };
}
