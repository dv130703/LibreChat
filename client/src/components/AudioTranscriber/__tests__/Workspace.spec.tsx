import { render } from '@testing-library/react';
import { RecoilRoot } from 'recoil';
import { SetConvoProvider, useSetConvoContext } from '~/Providers';
import Workspace from '../Workspace';

/** What `ChatRoute` saw on each of its renders. `ChatRoute` itself can't be
 *  rendered here - it needs auth, startup config, models and endpoint queries -
 *  but the only thing this test cares about is the one fact `Workspace` is
 *  responsible for handing it, so a stand-in that records that fact is enough. */
const hydrationFlagPerRender: boolean[] = [];

jest.mock('~/routes/ChatRoute', () => ({
  __esModule: true,
  default: () => {
    const hasSetConversation = jest.requireActual('~/Providers').useSetConvoContext();
    hydrationFlagPerRender.push(hasSetConversation.current);
    return <div data-testid="chat-route" />;
  },
}));

jest.mock('../TranscriptPanel', () => ({
  __esModule: true,
  default: () => <div data-testid="transcript-panel" />,
}));

function MarkAlreadyHydrated() {
  // Stands in for any earlier chat in the session: `ChatRoute` sets this true
  // the first time it hydrates anything, and nothing ever sets it back.
  const hasSetConversation = useSetConvoContext();
  hasSetConversation.current = true;
  return null;
}

function renderWorkspace(conversationId: string) {
  return render(
    <RecoilRoot>
      <SetConvoProvider>
        <MarkAlreadyHydrated />
        <Workspace conversationId={conversationId} />
      </SetConvoProvider>
    </RecoilRoot>,
  );
}

describe('AudioTranscriber Workspace', () => {
  beforeEach(() => {
    hydrationFlagPerRender.length = 0;
  });

  it('clears the hydration flag before ChatRoute renders, so it loads this conversation', () => {
    renderWorkspace('transcriber-convo-1');

    // Left standing, `ChatRoute` skips its fetch and its hydration effect, and
    // the chat pane keeps whatever conversation was already in the atom - the
    // empty `new` draft - so the next message is posted under `new` and the
    // server mints a different conversation for it.
    expect(hydrationFlagPerRender.length).toBeGreaterThan(0);
    expect(hydrationFlagPerRender[0]).toBe(false);
  });

  it('clears it again when switching to a different transcription', () => {
    const { rerender } = renderWorkspace('transcriber-convo-1');

    // `MarkAlreadyHydrated` re-marks it on every render, standing in for
    // `ChatRoute` having hydrated the first transcription by now.
    hydrationFlagPerRender.length = 0;

    rerender(
      <RecoilRoot>
        <SetConvoProvider>
          <MarkAlreadyHydrated />
          <Workspace conversationId="transcriber-convo-2" />
        </SetConvoProvider>
      </RecoilRoot>,
    );

    expect(hydrationFlagPerRender[0]).toBe(false);
  });
});
