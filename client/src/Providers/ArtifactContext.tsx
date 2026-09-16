import { createIndexCounterContext } from './IndexCounterContext';

const {
  context: ArtifactContext,
  useIndexCounterContext: useArtifactContext,
  Provider: ArtifactProvider,
} = createIndexCounterContext('ArtifactContext');

export { ArtifactContext, useArtifactContext, ArtifactProvider };
