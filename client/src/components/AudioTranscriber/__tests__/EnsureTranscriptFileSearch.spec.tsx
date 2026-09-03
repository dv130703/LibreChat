import { render } from '@testing-library/react';
import { RecoilRoot, useRecoilValue } from 'recoil';
import type { MutableSnapshot } from 'recoil';
import { MemoryRouter } from 'react-router-dom';
import EnsureTranscriptFileSearch from '../EnsureTranscriptFileSearch';
import { ephemeralAgentByConvoId } from '~/store';

let mockConvoData: { files?: string[] } | undefined;

jest.mock('~/hooks', () => ({
  useAuthContext: () => ({ isAuthenticated: true }),
}));

jest.mock('~/data-provider', () => ({
  useGetConvoIdQuery: () => ({ data: mockConvoData }),
}));

function ReadEphemeralAgent({
  conversationId,
  onRead,
}: {
  conversationId: string;
  onRead: (value: unknown) => void;
}) {
  const value = useRecoilValue(ephemeralAgentByConvoId(conversationId));
  onRead(value);
  return null;
}

function renderAt(
  path: string,
  conversationId: string,
  onRead: (value: unknown) => void,
  initializeState?: (mutableSnapshot: MutableSnapshot) => void,
) {
  return render(
    <RecoilRoot initializeState={initializeState}>
      <MemoryRouter initialEntries={[path]}>
        <EnsureTranscriptFileSearch />
        <ReadEphemeralAgent conversationId={conversationId} onRead={onRead} />
      </MemoryRouter>
    </RecoilRoot>,
  );
}

describe('EnsureTranscriptFileSearch (transcription/ARCHITECTURE.md §12)', () => {
  beforeEach(() => {
    mockConvoData = undefined;
  });

  it('forces file_search on for a conversation with a transcript file', async () => {
    mockConvoData = { files: ['source-1', 'source-1-transcript'] };
    const reads: unknown[] = [];
    renderAt('/c/convo-1', 'convo-1', (v) => reads.push(v));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads[reads.length - 1]).toMatchObject({ file_search: true });
  });

  it('does not touch conversations with no transcript file', async () => {
    mockConvoData = { files: ['just-a-regular-attachment'] };
    const reads: unknown[] = [];
    renderAt('/c/convo-2', 'convo-2', (v) => reads.push(v));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads[reads.length - 1]).toBeNull();
  });

  it('merges file_search into the existing ephemeral agent state instead of replacing it', async () => {
    mockConvoData = { files: ['source-1', 'source-1-transcript'] };
    const reads: unknown[] = [];
    // Real bug this guards: `updateEphemeralAgent` writes the whole atom,
    // not just the key it's given - a naive `updateEphemeralAgent(id, {
    // file_search: true })` would silently wipe out `execute_code` (or any
    // other ephemeral tool) already active for this conversation.
    renderAt(
      '/c/convo-3',
      'convo-3',
      (v) => reads.push(v),
      ({ set }) => {
        set(ephemeralAgentByConvoId('convo-3'), { execute_code: true });
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads[reads.length - 1]).toMatchObject({ execute_code: true, file_search: true });
  });

  it('does not run at all outside a /c/:id route', async () => {
    mockConvoData = { files: ['source-1', 'source-1-transcript'] };
    const reads: unknown[] = [];
    renderAt('/search', '', (v) => reads.push(v));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads[reads.length - 1]).toBeNull();
  });
});
