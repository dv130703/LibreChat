import { Tools } from 'librechat-data-provider';
import type { TConversationTranscript } from 'librechat-data-provider';
import {
  deriveTranscriptToolState,
  applyTranscriptToolState,
  buildUnavailableTranscriptNotice,
} from './tools';

const transcript = (overrides: Partial<TConversationTranscript>): TConversationTranscript => ({
  sourceFileId: 'source-1',
  displayName: 'standup.m4a',
  transcriptFileId: 'source-1-transcript',
  diarizationDetailFileId: null,
  jobStatus: 'ready',
  jobError: null,
  cancelled: false,
  indexStatus: 'indexed',
  isQueryable: true,
  unqueryableReason: null,
  ...overrides,
});

describe('deriveTranscriptToolState', () => {
  it('reports nothing for a conversation with no recordings', () => {
    expect(deriveTranscriptToolState([])).toEqual({
      hasQueryableTranscript: false,
      unavailable: [],
    });
  });

  it('reports a queryable transcript', () => {
    const state = deriveTranscriptToolState([transcript({})]);
    expect(state.hasQueryableTranscript).toBe(true);
    expect(state.unavailable).toEqual([]);
  });

  it('does not name an in-progress recording as unavailable', () => {
    // It is not a fault, the user can already see it processing, and naming
    // it would only invite an apology for something about to work.
    const state = deriveTranscriptToolState([
      transcript({
        transcriptFileId: null,
        jobStatus: 'transcribing',
        indexStatus: null,
        isQueryable: false,
        unqueryableReason: 'in_progress',
      }),
    ]);
    expect(state).toEqual({ hasQueryableTranscript: false, unavailable: [] });
  });

  it('names a failed index as unavailable, with its reason', () => {
    const state = deriveTranscriptToolState([
      transcript({
        displayName: 'interview.m4a',
        indexStatus: 'index_failed',
        isQueryable: false,
        unqueryableReason: 'index_failed',
      }),
    ]);
    expect(state.hasQueryableTranscript).toBe(false);
    expect(state.unavailable).toEqual([{ displayName: 'interview.m4a', reason: 'index_failed' }]);
  });

  it('reports both facts independently for a mixed conversation', () => {
    const state = deriveTranscriptToolState([
      transcript({ sourceFileId: 'a' }),
      transcript({
        sourceFileId: 'b',
        displayName: 'broken.m4a',
        isQueryable: false,
        unqueryableReason: 'stale_index',
      }),
    ]);
    expect(state.hasQueryableTranscript).toBe(true);
    expect(state.unavailable).toHaveLength(1);
  });
});

describe('applyTranscriptToolState', () => {
  it('turns file_search on when the conversation has a queryable transcript', () => {
    const result = applyTranscriptToolState(undefined, {
      hasQueryableTranscript: true,
      unavailable: [],
    });
    expect(result?.[Tools.file_search]).toBe(true);
  });

  it('preserves other ephemeral tools rather than replacing the object', () => {
    // Regression guard: writing only `{ file_search: true }` would silently
    // drop a user's execute_code / web_search / mcp selections.
    const result = applyTranscriptToolState(
      { execute_code: true, web_search: true, mcp: ['server-a'] },
      { hasQueryableTranscript: true, unavailable: [] },
    );
    expect(result).toMatchObject({
      execute_code: true,
      web_search: true,
      mcp: ['server-a'],
      [Tools.file_search]: true,
    });
  });

  it('never turns anything on when nothing is queryable', () => {
    const ephemeral = { execute_code: true };
    expect(
      applyTranscriptToolState(ephemeral, {
        hasQueryableTranscript: false,
        unavailable: [{ displayName: 'x.m4a', reason: 'index_failed' }],
      }),
    ).toBe(ephemeral);
  });

  it('never turns a tool off', () => {
    const result = applyTranscriptToolState(
      { [Tools.file_search]: true },
      { hasQueryableTranscript: false, unavailable: [] },
    );
    expect(result?.[Tools.file_search]).toBe(true);
  });
});

describe('buildUnavailableTranscriptNotice', () => {
  it('is absent when every recording is searchable', () => {
    expect(
      buildUnavailableTranscriptNotice({ hasQueryableTranscript: true, unavailable: [] }),
    ).toBeNull();
  });

  it('names the recording, the reason, and forbids retrying', () => {
    const notice = buildUnavailableTranscriptNotice({
      hasQueryableTranscript: false,
      unavailable: [{ displayName: 'interview.m4a', reason: 'index_failed' }],
    });
    expect(notice).toContain('interview.m4a');
    expect(notice).toContain('could not be indexed');
    expect(notice).toContain('do not retry');
  });

  it('distinguishes a stale index from a failed one', () => {
    const stale = buildUnavailableTranscriptNotice({
      hasQueryableTranscript: false,
      unavailable: [{ displayName: 'a.m4a', reason: 'stale_index' }],
    });
    expect(stale).toContain('edited since it was last indexed');
  });
});
