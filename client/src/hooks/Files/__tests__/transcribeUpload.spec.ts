import { QueryKeys } from 'librechat-data-provider';
import { attemptTranscribeUpload, buildTranscribeFormData } from '../transcribeUpload';

describe('buildTranscribeFormData', () => {
  it('builds the multipart body POST /api/transcribe expects', () => {
    const file = new File(['x'], 'recording.mp3', { type: 'audio/mpeg' });
    const formData = buildTranscribeFormData({
      targetConversationId: 'convo-1',
      parentMessageId: 'parent-1',
      originalFile: file,
      options: { includeTimestamps: true },
      endpoint: 'openAI',
      agentId: 'agent-1',
    });

    expect(formData.get('conversationId')).toBe('convo-1');
    expect(formData.get('parentMessageId')).toBe('parent-1');
    expect(formData.get('endpoint')).toBe('openAI');
    expect(formData.get('agent_id')).toBe('agent-1');
    expect(formData.get('options')).toBe(JSON.stringify({ includeTimestamps: true }));
    expect((formData.get('file') as File).name).toBe('recording.mp3');
  });

  it('omits endpoint/agent_id when not given', () => {
    const formData = buildTranscribeFormData({
      targetConversationId: 'convo-1',
      parentMessageId: 'parent-1',
      originalFile: new File(['x'], 'a.mp3', { type: 'audio/mpeg' }),
      options: {},
    });
    expect(formData.get('endpoint')).toBeNull();
    expect(formData.get('agent_id')).toBeNull();
  });
});

describe('attemptTranscribeUpload', () => {
  const baseArgs = {
    pendingId: 'pending-1',
    targetConversationId: 'convo-1',
    parentMessageId: 'parent-1',
    originalFile: new File(['x'], 'recording.mp3', { type: 'audio/mpeg' }),
    options: {},
    fallbackErrorMessage: 'Upload failed',
  };

  it(
    'awaits both the messages and conversation refetch before clearing the pending record, ' +
      'and reports the fresh conversation back to the caller - regression: (1) the ' +
      "conversation-created mutation's own onSuccess only *fires* its own refetch without " +
      'waiting for it, which (for a brand-new conversation TranscriptPanel has been polling ' +
      "since before this upload even started) left a window where the panel's pending-upload " +
      'guard could lift while the conversation query was still caching its earlier 404 - a ' +
      'brief "Failed to load the transcript." flash right as the upload that just succeeded; ' +
      '(2) an ordinary `ask()` send right after this resolves computes its `parentMessageId` ' +
      'from the SAME messages cache - if only invalidated, not awaited, it can still be empty, ' +
      'making that next message a sibling of (not a reply to) the one just created here, which ' +
      "LibreChat's message list would then show in place of it.",
    async () => {
      const callOrder: string[] = [];
      const mutateAsync = jest.fn(async () => {
        callOrder.push('mutateAsync');
        return {
          sourceFile: { file_id: 'source-1', filename: 'recording.mp3' },
          messageId: 'message-1',
        } as any;
      });
      const refetchQueries = jest.fn(async () => {
        callOrder.push('refetchQueries');
      });
      const invalidateQueries = jest.fn(() => {
        callOrder.push('invalidateQueries');
      });
      const freshConversation = { conversationId: 'convo-1', createdAt: '2024-01-01' };
      const getQueryData = jest.fn(() => freshConversation);
      const setPendingUploads = jest.fn((_conversationId: string, updater: (c: any[]) => any[]) => {
        callOrder.push('setPendingUploads');
        updater([]);
      });
      const onUploaded = jest.fn(() => {
        callOrder.push('onUploaded');
      });
      const onConversationRefreshed = jest.fn(() => {
        callOrder.push('onConversationRefreshed');
      });

      await attemptTranscribeUpload({
        ...baseArgs,
        mutateAsync,
        queryClient: { invalidateQueries, refetchQueries, getQueryData } as any,
        setPendingUploads,
        onUploaded,
        onConversationRefreshed,
      });

      expect(refetchQueries).toHaveBeenCalledWith([QueryKeys.messages, 'convo-1']);
      expect(refetchQueries).toHaveBeenCalledWith([QueryKeys.conversation, 'convo-1']);
      expect(getQueryData).toHaveBeenCalledWith([QueryKeys.conversation, 'convo-1']);
      expect(onConversationRefreshed).toHaveBeenCalledWith(freshConversation);
      // The pending record is only cleared, and the caller only told about
      // the real file id, *after* both refetches have settled.
      expect(callOrder.indexOf('refetchQueries')).toBeLessThan(
        callOrder.indexOf('setPendingUploads'),
      );
      expect(callOrder.indexOf('refetchQueries')).toBeLessThan(callOrder.indexOf('onUploaded'));
      expect(callOrder.indexOf('onConversationRefreshed')).toBeLessThan(
        callOrder.indexOf('onUploaded'),
      );
      expect(onUploaded).toHaveBeenCalledWith('source-1');
    },
  );

  it('does not treat a failing refetch as an upload failure - the file already uploaded successfully', async () => {
    const setPendingUploads = jest.fn((_conversationId: string, updater: (c: any[]) => any[]) =>
      updater([{ pendingId: 'pending-1', status: 'uploading' }] as any),
    );
    const onUploaded = jest.fn();

    await attemptTranscribeUpload({
      ...baseArgs,
      mutateAsync: async () => ({ sourceFile: { file_id: 'source-1', filename: 'r.mp3' } }) as any,
      queryClient: {
        invalidateQueries: jest.fn(),
        refetchQueries: jest.fn().mockRejectedValue(new Error('network hiccup')),
        getQueryData: jest.fn(),
      } as any,
      setPendingUploads,
      onUploaded,
    });

    // Still resolves the upload as successful - only the refetch failed.
    expect(onUploaded).toHaveBeenCalledWith('source-1');
    const removalUpdater = setPendingUploads.mock.calls.at(-1)?.[1];
    expect(removalUpdater?.([{ pendingId: 'pending-1' }])).toEqual([]);
  });

  it('marks the pending record failed, without calling onUploaded, when the upload itself fails', async () => {
    const setPendingUploads = jest.fn();
    const onUploaded = jest.fn();

    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    await attemptTranscribeUpload({
      ...baseArgs,
      mutateAsync: async () => {
        throw new Error('boom');
      },
      queryClient: {
        invalidateQueries: jest.fn(),
        refetchQueries: jest.fn(),
        getQueryData: jest.fn(),
      } as any,
      setPendingUploads,
      onUploaded,
    });

    expect(onUploaded).not.toHaveBeenCalled();
    expect(setPendingUploads).toHaveBeenCalledTimes(1);
    const [conversationId, updater] = setPendingUploads.mock.calls[0];
    expect(conversationId).toBe('convo-1');
    expect(updater([{ pendingId: 'pending-1', status: 'uploading' }])).toEqual([
      { pendingId: 'pending-1', status: 'failed', errorMessage: 'Upload failed' },
    ]);

    consoleError.mockRestore();
  });
});
