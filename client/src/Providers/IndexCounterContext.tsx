import { createContext, useContext, useCallback, useRef } from 'react';
import type { ReactNode } from 'react';

type TIndexCounterContext = {
  getNextIndex: (skip: boolean) => number;
  resetCounter: () => void;
};

/**
 * Creates a context/provider pair that hands out sequential indices via
 * `getNextIndex`, offset by a `baseIndex` prop so per-block memoized
 * rendering can seed each block's provider with the count of items in
 * earlier blocks and keep document-order indices stable.
 */
export function createIndexCounterContext(name: string) {
  const context = createContext<TIndexCounterContext>({} as TIndexCounterContext);
  context.displayName = name;

  const useIndexCounterContext = () => useContext(context);

  function Provider({
    children,
    baseIndex = 0,
  }: {
    children: ReactNode;
    /** Offset added to every assigned index. */
    baseIndex?: number;
  }) {
    const counterRef = useRef(0);

    const getNextIndex = useCallback(
      (skip: boolean) => {
        if (skip) {
          return baseIndex + counterRef.current;
        }
        const nextIndex = counterRef.current;
        counterRef.current += 1;
        return baseIndex + nextIndex;
      },
      [baseIndex],
    );

    const resetCounter = useCallback(() => {
      counterRef.current = 0;
    }, []);

    return <context.Provider value={{ getNextIndex, resetCounter }}>{children}</context.Provider>;
  }

  return { context, useIndexCounterContext, Provider };
}
