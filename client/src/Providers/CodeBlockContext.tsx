import { createIndexCounterContext } from './IndexCounterContext';

const {
  context: CodeBlockContext,
  useIndexCounterContext: useCodeBlockContext,
  Provider: CodeBlockProvider,
} = createIndexCounterContext('CodeBlockContext');

export { CodeBlockContext, useCodeBlockContext, CodeBlockProvider };
