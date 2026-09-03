import { splitFileIds } from '../fileIds';

describe('splitFileIds', () => {
  it('resolves source/transcript ids in normal array order', () => {
    const result = splitFileIds(['source-1', 'source-1-transcript', 'source-1-diarization-detail']);
    expect(result).toEqual({ sourceFileId: 'source-1', transcriptFileId: 'source-1-transcript' });
  });

  it('does not misidentify the diarization-detail file as the source when it sorts before the real source id', () => {
    // Regression: a looser "whatever isn't the transcript" check would
    // resolve sourceFileId to the diarization-detail id here instead - the
    // same bug already fixed server-side (see transcription/ARCHITECTURE.md I3).
    const result = splitFileIds(['source-1-transcript', 'source-1-diarization-detail', 'source-1']);
    expect(result.sourceFileId).toBe('source-1');
    expect(result.transcriptFileId).toBe('source-1-transcript');
  });

  it('returns undefined ids for an empty list', () => {
    expect(splitFileIds([])).toEqual({ sourceFileId: undefined, transcriptFileId: undefined });
  });
});
