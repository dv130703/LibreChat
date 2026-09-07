import { renderHook, act } from '@testing-library/react';
import {
  Constants,
  QueryKeys,
  EModelEndpoint,
  getEndpointFileConfig,
} from 'librechat-data-provider';

beforeAll(() => {
  global.URL.createObjectURL = jest.fn(() => 'blob:mock-url');
  global.URL.revokeObjectURL = jest.fn();
  Object.defineProperty(global, 'Image', {
    writable: true,
    value: class {
      width = 640;
      height = 480;
      onload: (() => void) | null = null;

      set src(_src: string) {
        queueMicrotask(() => this.onload?.());
      }
    },
  });
});

const mockShowToast = jest.fn();
const mockSetFilesLoading = jest.fn();
const mockMutate = jest.fn();
const mockNavigate = jest.fn();
const mockSetSearchParams = jest.fn();
const mockHasSetConversation = { current: true };

jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useSearchParams: () => [new URLSearchParams(), mockSetSearchParams],
}));

jest.mock('~/Providers/SetConvoContext', () => ({
  useSetConvoContext: () => mockHasSetConversation,
}));
const mockProcessFileForUpload = jest.fn(
  async (_file: File, _quality?: number, _onProgress?: (progress: number) => void) => _file,
);
const mockLocalize = jest.fn((key: string) => key);

let mockConversation: Record<string, string | null | undefined> = {};
let mockIsTemporary = false;
let mockLatestMessageId: string | undefined;
const mockSetConversation = jest.fn();

jest.mock('~/Providers/ChatContext', () => ({
  useChatContext: jest.fn(() => ({
    files: new Map(),
    setFiles: jest.fn(),
    setFilesLoading: mockSetFilesLoading,
    conversation: mockConversation,
    latestMessageId: mockLatestMessageId,
    setConversation: mockSetConversation,
  })),
}));

jest.mock('@librechat/client', () => ({
  useToastContext: jest.fn(() => ({
    showToast: mockShowToast,
  })),
}));

const mockRecoilSet = jest.fn();

jest.mock('recoil', () => ({
  ...jest.requireActual('recoil'),
  useSetRecoilState: jest.fn(() => jest.fn()),
  useRecoilValue: jest.fn(() => mockIsTemporary),
  // Real `useRecoilCallback` requires a `RecoilRoot` this test doesn't
  // provide - `maybeInterceptAudioVideo`'s pending-upload record is written
  // through one (rather than `useSetRecoilState`) specifically because its
  // conversation id is only known at call time (a freshly minted one for a
  // brand-new draft), not at render time. Mocked the same narrow way as
  // `useSetRecoilState`/`useRecoilValue` above: exercise the real call
  // shape, not the real Recoil store.
  useRecoilCallback: jest.fn(
    (factory: (callbackInterface: { set: typeof mockRecoilSet }) => unknown) =>
      factory({ set: mockRecoilSet }),
  ),
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    isTemporary: { key: 'isTemporary' },
    pendingTranscriptionUploadsByConvoId: jest.fn((conversationId: string) => ({
      key: `pendingTranscriptionUploadsByConvoId-${conversationId}`,
    })),
  },
  ephemeralAgentByConvoId: jest.fn(() => ({ key: 'mock' })),
}));

const mockInvalidateQueries = jest.fn();
const mockGetQueryData = jest.fn();
const mockRefetchQueries = jest.fn().mockResolvedValue(undefined);

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: jest.fn(() => ({
    getQueryData: mockGetQueryData,
    refetchQueries: mockRefetchQueries,
    invalidateQueries: mockInvalidateQueries,
  })),
}));

const mockTranscribeMutateAsync = jest.fn();
type MockInterceptResult =
  | { action: 'attach' }
  | { action: 'cancel' }
  | { action: 'transcribe'; options: Record<string, unknown> };
const mockInterceptAudioVideo = jest.fn<Promise<MockInterceptResult>, [File, boolean]>(
  async () => ({ action: 'attach' }),
);

jest.mock('~/data-provider', () => ({
  useGetFileConfig: jest.fn(() => ({ data: null })),
  useUploadFileMutation: jest.fn((_opts: Record<string, unknown>) => ({
    mutate: mockMutate,
  })),
  useTranscribeAudioMutation: jest.fn(() => ({
    mutateAsync: mockTranscribeMutateAsync,
  })),
}));

jest.mock('~/Providers/TranscribeIntentContext', () => ({
  useTranscribeIntent: () => ({ interceptAudioVideo: mockInterceptAudioVideo }),
}));

jest.mock('~/hooks/useLocalize', () => {
  const fn = jest.fn(() => mockLocalize) as jest.Mock & {
    TranslationKeys: Record<string, never>;
  };
  fn.TranslationKeys = {};
  return { __esModule: true, default: fn, TranslationKeys: {} };
});

jest.mock('../useDelayedUploadToast', () => ({
  useDelayedUploadToast: jest.fn(() => ({
    startUploadTimer: jest.fn(),
    clearUploadTimer: jest.fn(),
  })),
}));

jest.mock('~/utils/heicConverter', () => ({
  processFileForUpload: mockProcessFileForUpload,
}));

jest.mock('../useClientResize', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    resizeImageIfNeeded: jest.fn(async (file: File) => ({ file, resized: false })),
  })),
}));

const mockAddFile = jest.fn();

jest.mock('../useUpdateFiles', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    addFile: mockAddFile,
    replaceFile: jest.fn(),
    updateFileById: jest.fn(),
    deleteFileById: jest.fn(),
  })),
}));

jest.mock('~/utils', () => ({
  logger: { log: jest.fn() },
  validateFiles: jest.fn(() => true),
  cachePreview: jest.fn(),
  getCachedPreview: jest.fn(() => undefined),
  isAudioOrVideoMimeType: jest.fn(
    (type?: string | null) =>
      type != null && (type.startsWith('audio/') || type.startsWith('video/')),
  ),
}));

const mockValidateFiles = jest.requireMock('~/utils').validateFiles;

describe('useFileHandling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockProcessFileForUpload.mockImplementation(async (file: File) => file);
    mockConversation = {};
    mockIsTemporary = false;
    mockLatestMessageId = undefined;
    // Mirrors the real-world starting state: the draft the user typed into
    // before dropping the file already hydrated once, same as ChatRoute
    // leaves it set for every conversation after the first.
    mockHasSetConversation.current = true;
  });

  const loadHook = async () => (await import('../useFileHandling')).default;

  describe('endpointOverride', () => {
    it('uploads non-HEIC images without running HEIC conversion', async () => {
      const useFileHandling = await loadHook();
      const { result } = renderHook(() => useFileHandling());

      const imageFile = new File(['maybe-heic'], 'photo.jpg', { type: 'image/jpeg' });

      await act(async () => {
        await result.current.handleFiles([imageFile]);
      });

      expect(mockProcessFileForUpload).not.toHaveBeenCalled();
      expect(mockMutate).toHaveBeenCalledTimes(1);
    });

    it('uses conversation endpoint when no override is provided', async () => {
      mockConversation = {
        conversationId: 'convo-1',
        endpoint: 'openAI',
        endpointType: 'custom',
      };

      const useFileHandling = await loadHook();
      const { result } = renderHook(() => useFileHandling());

      const textFile = new File(['hello'], 'test.txt', { type: 'text/plain' });

      await act(async () => {
        await result.current.handleFiles([textFile]);
      });

      expect(mockValidateFiles).toHaveBeenCalledTimes(1);
      const validateCall = mockValidateFiles.mock.calls[0][0];
      const configResult = getEndpointFileConfig({
        endpoint: 'openAI',
        endpointType: 'custom',
        fileConfig: null,
      });
      expect(validateCall.endpointFileConfig).toEqual(configResult);
    });

    it('uses endpointOverride for validation instead of conversation endpoint', async () => {
      mockConversation = {
        conversationId: 'convo-1',
        endpoint: 'openAI',
        endpointType: 'custom',
      };

      const useFileHandling = await loadHook();
      const { result } = renderHook(() =>
        useFileHandling({ endpointOverride: EModelEndpoint.agents }),
      );

      const textFile = new File(['hello'], 'test.txt', { type: 'text/plain' });

      await act(async () => {
        await result.current.handleFiles([textFile]);
      });

      expect(mockValidateFiles).toHaveBeenCalledTimes(1);
      const validateCall = mockValidateFiles.mock.calls[0][0];
      const agentsConfig = getEndpointFileConfig({
        endpoint: EModelEndpoint.agents,
        endpointType: EModelEndpoint.agents,
        fileConfig: null,
      });
      expect(validateCall.endpointFileConfig).toEqual(agentsConfig);
    });

    it('falls back to conversation endpoint when endpointOverride is undefined', async () => {
      mockConversation = {
        conversationId: 'convo-1',
        endpoint: 'anthropic',
        endpointType: undefined,
      };

      const useFileHandling = await loadHook();
      const { result } = renderHook(() => useFileHandling({ endpointOverride: undefined }));

      const textFile = new File(['hello'], 'test.txt', { type: 'text/plain' });

      await act(async () => {
        await result.current.handleFiles([textFile]);
      });

      expect(mockValidateFiles).toHaveBeenCalledTimes(1);
      const validateCall = mockValidateFiles.mock.calls[0][0];
      const anthropicConfig = getEndpointFileConfig({
        endpoint: 'anthropic',
        endpointType: undefined,
        fileConfig: null,
      });
      expect(validateCall.endpointFileConfig).toEqual(anthropicConfig);
    });

    it('sends correct endpoint in upload form data when override is set', async () => {
      mockConversation = {
        conversationId: 'convo-1',
        endpoint: 'openAI',
        endpointType: 'custom',
      };

      const useFileHandling = await loadHook();
      const { result } = renderHook(() =>
        useFileHandling({
          endpointOverride: EModelEndpoint.agents,
          additionalMetadata: { agent_id: 'agent-123' },
        }),
      );

      const textFile = new File(['hello'], 'test.txt', { type: 'text/plain' });

      await act(async () => {
        await result.current.handleFiles([textFile]);
      });

      expect(mockMutate).toHaveBeenCalledTimes(1);
      const formData: FormData = mockMutate.mock.calls[0][0];
      expect(formData.get('endpoint')).toBe(EModelEndpoint.agents);
      expect(formData.get('endpointType')).toBe(EModelEndpoint.agents);
      expect(formData.get('conversationId')).toBeNull();
    });

    it('does not enter assistants upload path when override is agents', async () => {
      mockConversation = {
        conversationId: 'convo-1',
        endpoint: 'assistants',
        endpointType: 'assistants',
      };

      const useFileHandling = await loadHook();
      const { result } = renderHook(() =>
        useFileHandling({
          endpointOverride: EModelEndpoint.agents,
          additionalMetadata: { agent_id: 'agent-123' },
        }),
      );

      const textFile = new File(['hello'], 'test.txt', { type: 'text/plain' });

      await act(async () => {
        await result.current.handleFiles([textFile]);
      });

      expect(mockMutate).toHaveBeenCalledTimes(1);
      const formData: FormData = mockMutate.mock.calls[0][0];
      expect(formData.get('endpoint')).toBe(EModelEndpoint.agents);
      expect(formData.get('message_file')).toBeNull();
      expect(formData.get('version')).toBeNull();
      expect(formData.get('model')).toBeNull();
      expect(formData.get('assistant_id')).toBeNull();
    });

    it('enters assistants path without override when conversation is assistants', async () => {
      mockConversation = {
        conversationId: 'convo-1',
        endpoint: 'assistants',
        endpointType: 'assistants',
        assistant_id: 'asst-456',
        model: 'gpt-4',
      };

      const useFileHandling = await loadHook();
      const { result } = renderHook(() => useFileHandling());

      const textFile = new File(['hello'], 'test.txt', { type: 'text/plain' });

      await act(async () => {
        await result.current.handleFiles([textFile]);
      });

      expect(mockMutate).toHaveBeenCalledTimes(1);
      const formData: FormData = mockMutate.mock.calls[0][0];
      expect(formData.get('endpoint')).toBe('assistants');
      expect(formData.get('message_file')).toBe('true');
    });

    it('falls back to "default" when no conversation endpoint and no override', async () => {
      mockConversation = {
        conversationId: Constants.NEW_CONVO as string,
        endpoint: null,
        endpointType: undefined,
      };

      const useFileHandling = await loadHook();
      const { result } = renderHook(() => useFileHandling());

      const textFile = new File(['hello'], 'test.txt', { type: 'text/plain' });

      await act(async () => {
        await result.current.handleFiles([textFile]);
      });

      expect(mockMutate).toHaveBeenCalledTimes(1);
      const formData: FormData = mockMutate.mock.calls[0][0];
      expect(formData.get('endpoint')).toBe('default');
      expect(formData.get('conversationId')).toBeNull();
    });

    it('sends temporary flag for temporary chat uploads', async () => {
      mockIsTemporary = true;
      mockConversation = {
        conversationId: Constants.NEW_CONVO as string,
        endpoint: 'openAI',
        endpointType: 'custom',
      };

      const useFileHandling = await loadHook();
      const { result } = renderHook(() => useFileHandling());

      const textFile = new File(['hello'], 'test.txt', { type: 'text/plain' });

      await act(async () => {
        await result.current.handleFiles([textFile]);
      });

      expect(mockMutate).toHaveBeenCalledTimes(1);
      const formData: FormData = mockMutate.mock.calls[0][0];
      expect(formData.get('conversationId')).toBeNull();
      expect(formData.get('isTemporary')).toBe('true');
    });

    it('does not send temporary flag for assistant builder uploads', async () => {
      mockIsTemporary = true;
      mockConversation = {
        conversationId: 'temporary-convo',
        endpoint: 'openAI',
        endpointType: 'custom',
      };

      const useFileHandling = await loadHook();
      const { result } = renderHook(() =>
        useFileHandling({
          additionalMetadata: { assistant_id: 'asst-123' },
        }),
      );

      const textFile = new File(['hello'], 'test.txt', { type: 'text/plain' });

      await act(async () => {
        await result.current.handleFiles([textFile]);
      });

      expect(mockMutate).toHaveBeenCalledTimes(1);
      const formData: FormData = mockMutate.mock.calls[0][0];
      expect(formData.get('assistant_id')).toBe('asst-123');
      expect(formData.get('conversationId')).toBeNull();
      expect(formData.get('isTemporary')).toBeNull();
    });

    it('does not send temporary flag for agent builder uploads', async () => {
      mockIsTemporary = true;
      mockConversation = {
        conversationId: 'temporary-convo',
        endpoint: 'openAI',
        endpointType: 'custom',
      };

      const useFileHandling = await loadHook();
      const { result } = renderHook(() =>
        useFileHandling({
          endpointOverride: EModelEndpoint.agents,
          additionalMetadata: { agent_id: 'agent-123' },
        }),
      );

      const textFile = new File(['hello'], 'test.txt', { type: 'text/plain' });

      await act(async () => {
        await result.current.handleFiles([textFile]);
      });

      expect(mockMutate).toHaveBeenCalledTimes(1);
      const formData: FormData = mockMutate.mock.calls[0][0];
      expect(formData.get('agent_id')).toBe('agent-123');
      expect(formData.get('conversationId')).toBeNull();
      expect(formData.get('isTemporary')).toBeNull();
    });

    it('awaits HEIC conversion before uploading the converted file', async () => {
      const convertedFile = new File(['jpeg data'], 'photo.jpg', { type: 'image/jpeg' });
      mockProcessFileForUpload.mockImplementationOnce(
        async (_file: File, _quality?: number, onProgress?: (progress: number) => void) => {
          onProgress?.(1);
          return convertedFile;
        },
      );

      const useFileHandling = await loadHook();
      const { result } = renderHook(() => useFileHandling());

      const heicFile = new File(['heic data'], 'photo.bin', { type: 'image/heic' });

      await act(async () => {
        await result.current.handleFiles([heicFile]);
      });

      expect(mockShowToast).toHaveBeenCalledWith({
        message: 'com_info_heic_converting',
        status: 'info',
        duration: 3000,
      });
      expect(mockProcessFileForUpload).toHaveBeenCalledWith(heicFile, 0.9, expect.any(Function));
      expect(mockMutate).toHaveBeenCalledTimes(1);
      const formData: FormData = mockMutate.mock.calls[0][0];
      const uploadedFile = formData.get('file') as File;
      expect(uploadedFile.name).toBe('photo.jpg');
      expect(uploadedFile.type).toBe('image/jpeg');
    });
  });

  describe('audio/video transcription interception', () => {
    it('mints a new conversation, queues the job, and navigates into it when dropped on a brand-new draft', async () => {
      mockConversation = {
        conversationId: Constants.NEW_CONVO as string,
        endpoint: 'openAI',
        endpointType: 'openAI',
      };
      mockInterceptAudioVideo.mockResolvedValueOnce({
        action: 'transcribe',
        options: { includeTimestamps: true, diarize: true },
      });
      mockTranscribeMutateAsync.mockResolvedValueOnce({
        conversationId: 'minted-convo-id',
        messageId: 'message-1',
        sourceFile: { file_id: 'source-file-1', filename: 'recording.mp3' },
        status: 'queued',
        queuePosition: 1,
      });
      // What the awaited conversation refetch would leave in the cache -
      // the real, now-fully-created conversation (a real `createdAt`, not
      // the `''` placeholder the draft carried).
      mockGetQueryData.mockReturnValueOnce({
        endpoint: 'openAI',
        endpointType: 'openAI',
        createdAt: '2024-01-01T00:00:00.000Z',
        title: 'recording.mp3',
      });

      const useFileHandling = await loadHook();
      const { result } = renderHook(() => useFileHandling());

      const audioFile = new File(['x'], 'recording.mp3', { type: 'audio/mpeg' });

      await act(async () => {
        await result.current.handleFiles([audioFile]);
      });

      expect(mockTranscribeMutateAsync).toHaveBeenCalledTimes(1);
      const formData: FormData = mockTranscribeMutateAsync.mock.calls[0][0].formData;
      // A real, minted id - not the literal "new" placeholder the draft carried.
      expect(formData.get('conversationId')).not.toBe(Constants.NEW_CONVO);
      expect(formData.get('conversationId')).toEqual(expect.any(String));
      // A brand-new conversation has no leaf message to link onto.
      expect(formData.get('parentMessageId')).toBe(Constants.NO_PARENT);
      expect(mockMutate).not.toHaveBeenCalled();
      // Navigates the instant the options dialog is confirmed - before the
      // upload itself even starts - so the URL carries a client-only
      // `pendingId` placeholder, not the real `source-file-1` id the upload
      // eventually resolves to (neither exists yet at navigate time). The
      // minted conversation id is the same one the upload's own formData
      // carries.
      expect(mockNavigate).toHaveBeenCalledTimes(1);
      const [navigateUrl, navigateOptions] = mockNavigate.mock.calls[0];
      const navigateMatch = /^\/c\/([^?]+)\?panel=transcript&file=([^&]+)$/.exec(navigateUrl);
      expect(navigateMatch).not.toBeNull();
      const [, mintedConversationId, pendingFileId] = navigateMatch as unknown as [
        string,
        string,
        string,
      ];
      expect(mintedConversationId).toBe(formData.get('conversationId'));
      expect(mintedConversationId).not.toBe(Constants.NEW_CONVO);
      expect(pendingFileId).not.toBe('source-file-1');
      expect(navigateOptions).toEqual({ replace: true });
      // Only the initial pending-upload placeholder - no second `addFile`
      // for the transcribed source file, since it's carried by the real
      // message the backend created instead of a composer chip.
      expect(mockAddFile).toHaveBeenCalledTimes(1);
      expect(mockAddFile).not.toHaveBeenCalledWith(
        expect.objectContaining({ file_id: 'source-file-1' }),
      );
      // Awaited (not fire-and-forget) - a normal `ask()` send right after
      // this resolves reads this same cache to compute its own
      // `parentMessageId`; leaving it merely invalidated (not refetched)
      // risks that next message landing as a sibling instead of a reply.
      expect(mockRefetchQueries).toHaveBeenCalledWith([QueryKeys.messages, mintedConversationId]);
      // Real bug this guards: `targetConversationId` doesn't exist
      // server-side yet (the upload is what creates it) - if this stayed
      // `false` (as it used to, to force `ChatRoute`'s hydration effect to
      // "notice" the new id), that effect would instead fetch the not-yet-
      // existing conversation itself, get a 404, and treat it as
      // "conversation not found": resetting straight back to `/c/new` and
      // wiping this navigate's URL out from under it. Seeding the
      // conversation atom directly (below) and leaving this `true` is what
      // keeps that fetch from ever firing.
      expect(mockHasSetConversation.current).toBe(true);
      // The exact atom `ChatRoute`/`ChatView` read the conversation from is
      // seeded synchronously with the real minted id, no server round trip.
      expect(mockSetConversation).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          conversationId: mintedConversationId,
          endpoint: 'openAI',
          endpointType: 'openAI',
        }),
      );
      // Real bug this guards: without a second call once the conversation
      // is genuinely created, this atom would carry the "brand-new, unsent
      // draft" shape (`createdAt: ''`) forever - since this flow never goes
      // through `ask()`/SSE, nothing else would ever clear it, and every
      // ordinary send afterward computes against a conversation that still
      // looks uncreated.
      expect(mockSetConversation).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          createdAt: '2024-01-01T00:00:00.000Z',
          title: 'recording.mp3',
        }),
      );
      // The pending-upload record is written (so `TranscriptPanel` has
      // something to render the instant it mounts on the new URL) and then
      // cleared once the upload actually succeeds.
      expect(mockRecoilSet).toHaveBeenCalledTimes(2);
      const [addAtom, addUpdater] = mockRecoilSet.mock.calls[0];
      expect(addAtom).toEqual({
        key: `pendingTranscriptionUploadsByConvoId-${mintedConversationId}`,
      });
      const afterAdd = addUpdater([]);
      expect(afterAdd).toHaveLength(1);
      expect(afterAdd[0]).toMatchObject({
        pendingId: pendingFileId,
        conversationId: mintedConversationId,
        status: 'uploading',
        filename: 'recording.mp3',
      });
      const [, removeUpdater] = mockRecoilSet.mock.calls[1];
      expect(removeUpdater(afterAdd)).toHaveLength(0);
    });

    it('stops processing further files in the same drop once one of them navigates to a new conversation', async () => {
      mockConversation = {
        conversationId: Constants.NEW_CONVO as string,
        endpoint: 'openAI',
        endpointType: 'openAI',
      };
      mockInterceptAudioVideo.mockResolvedValueOnce({
        action: 'transcribe',
        options: { includeTimestamps: true, diarize: true },
      });
      mockTranscribeMutateAsync.mockResolvedValueOnce({
        conversationId: 'minted-convo-id',
        sourceFile: { file_id: 'source-file-1', filename: 'recording-1.mp3' },
        status: 'queued',
        queuePosition: 1,
      });

      const useFileHandling = await loadHook();
      const { result } = renderHook(() => useFileHandling());

      const firstFile = new File(['x'], 'recording-1.mp3', { type: 'audio/mpeg' });
      const secondFile = new File(['y'], 'recording-2.mp3', { type: 'audio/mpeg' });

      await act(async () => {
        await result.current.handleFiles([firstFile, secondFile]);
      });

      // The first file navigated away - real bug this guards against: the
      // second file would otherwise keep running against a `ChatView`/
      // `TranscribeIntentProvider` instance that's already unmounted, whose
      // dialog can never actually be shown to (or clicked through by) the
      // user, leaving it stuck mid-upload forever with no visible chip and
      // no way to finish or cancel it.
      expect(mockInterceptAudioVideo).toHaveBeenCalledTimes(1);
      expect(mockTranscribeMutateAsync).toHaveBeenCalledTimes(1);
      expect(mockNavigate).toHaveBeenCalledTimes(1);
    });

    it('queues against the existing conversation, refreshes its message list, and opens the transcript panel in place', async () => {
      mockConversation = {
        conversationId: 'existing-convo-id',
        endpoint: 'openAI',
        endpointType: 'openAI',
      };
      mockLatestMessageId = 'leaf-message-id';
      mockInterceptAudioVideo.mockResolvedValueOnce({
        action: 'transcribe',
        options: { includeTimestamps: true, diarize: true },
      });
      mockTranscribeMutateAsync.mockResolvedValueOnce({
        conversationId: 'existing-convo-id',
        sourceFile: { file_id: 'source-file-1', filename: 'recording.mp3' },
        status: 'queued',
        queuePosition: 1,
      });

      const useFileHandling = await loadHook();
      const { result } = renderHook(() => useFileHandling());

      const audioFile = new File(['x'], 'recording.mp3', { type: 'audio/mpeg' });

      await act(async () => {
        await result.current.handleFiles([audioFile]);
      });

      expect(mockTranscribeMutateAsync).toHaveBeenCalledTimes(1);
      const formData: FormData = mockTranscribeMutateAsync.mock.calls[0][0].formData;
      expect(formData.get('conversationId')).toBe('existing-convo-id');
      // The new message links onto the conversation's current branch, not a
      // fresh root - dropped mid-conversation, not at the start of one.
      expect(formData.get('parentMessageId')).toBe('leaf-message-id');
      // Already on this conversation's URL - the panel opens by adding query
      // params to it, not a full navigate (which would be a needless remount).
      expect(mockNavigate).not.toHaveBeenCalled();
      // Only the initial pending-upload placeholder - no second `addFile`
      // for the transcribed source file (carried by the real message now).
      expect(mockAddFile).toHaveBeenCalledTimes(1);
      expect(mockAddFile).not.toHaveBeenCalledWith(
        expect.objectContaining({ file_id: 'source-file-1' }),
      );
      expect(mockRefetchQueries).toHaveBeenCalledWith([QueryKeys.messages, 'existing-convo-id']);
      // No navigation, no reason to touch the hydration flag or seed the
      // conversation atom - it already carries the right id.
      expect(mockHasSetConversation.current).toBe(true);
      expect(mockSetConversation).not.toHaveBeenCalled();
      // Opens the transcript panel immediately, before the upload itself has
      // even resolved - the audio player and a pending "uploading" state -
      // instead of leaving only the inert `TranscriptCard` "Transcribing..."
      // chip with nothing to look at.
      expect(mockSetSearchParams).toHaveBeenCalledTimes(2);
      const firstUpdater = mockSetSearchParams.mock.calls[0][0];
      const afterFirst = firstUpdater(new URLSearchParams());
      expect(afterFirst.get('panel')).toBe('transcript');
      const pendingFileId = afterFirst.get('file');
      expect(pendingFileId).not.toBe('source-file-1');
      // Once the upload actually succeeds, the second call swaps the URL's
      // `pendingId` placeholder for the real `sourceFile.file_id` -
      // `TranscriptPanel`'s ordinary `queued`/`transcribing` polling takes
      // over from there.
      const secondUpdater = mockSetSearchParams.mock.calls[1][0];
      const afterSecond = secondUpdater(afterFirst);
      expect(afterSecond.get('panel')).toBe('transcript');
      expect(afterSecond.get('file')).toBe('source-file-1');
      // The pending-upload record is written and then cleared the same way
      // as the brand-new-conversation case.
      expect(mockRecoilSet).toHaveBeenCalledTimes(2);
      const [addAtom, addUpdater] = mockRecoilSet.mock.calls[0];
      expect(addAtom).toEqual({
        key: 'pendingTranscriptionUploadsByConvoId-existing-convo-id',
      });
      const afterAdd = addUpdater([]);
      expect(afterAdd[0]).toMatchObject({
        pendingId: pendingFileId,
        conversationId: 'existing-convo-id',
        status: 'uploading',
      });
      const [, removeUpdater] = mockRecoilSet.mock.calls[1];
      expect(removeUpdater(afterAdd)).toHaveLength(0);
    });

    it(
      "chains a second recording onto the first one's real message id, even when attached " +
        'before the first upload has resolved - regression: computing both from the same ' +
        "stale `latestMessageId` made them siblings, which LibreChat's message list renders " +
        'as only the newest, making the first recording appear to vanish',
      async () => {
        mockConversation = {
          conversationId: 'existing-convo-id',
          endpoint: 'openAI',
          endpointType: 'openAI',
        };
        // No messages exist yet from this conversation's own query cache -
        // matches a conversation whose only content so far is recordings
        // attached via this same flow, which never go through the ordinary
        // `ask()` path that keeps `latestMessageId` current.
        mockLatestMessageId = undefined;
        mockInterceptAudioVideo.mockResolvedValue({
          action: 'transcribe',
          options: { includeTimestamps: true, diarize: true },
        });

        // The first upload's own `POST /api/transcribe` doesn't resolve
        // until released explicitly - reproduces "attach a second file
        // before the first has finished uploading."
        let releaseFirstUpload: (() => void) | undefined;
        const firstUploadGate = new Promise<void>((resolve) => {
          releaseFirstUpload = resolve;
        });
        mockTranscribeMutateAsync.mockImplementationOnce(async () => {
          await firstUploadGate;
          return {
            conversationId: 'existing-convo-id',
            messageId: 'first-message-id',
            sourceFile: { file_id: 'source-file-1', filename: 'recording-1.mp3' },
            status: 'queued',
            queuePosition: 1,
          };
        });
        const useFileHandling = await loadHook();
        const { result } = renderHook(() => useFileHandling());

        const firstFile = new File(['x'], 'recording-1.mp3', { type: 'audio/mpeg' });
        const secondFile = new File(['y'], 'recording-2.mp3', { type: 'audio/mpeg' });

        // Fire both attaches before the first upload resolves - `handleFiles`
        // itself awaits each file in sequence, but `maybeInterceptAudioVideo`
        // only awaits the composer-facing bits (the intercept dialog), not
        // the upload itself, so this reflects a real back-to-back drop.
        const firstHandle = result.current.handleFiles([firstFile]);
        await act(async () => {
          await Promise.resolve();
        });
        mockTranscribeMutateAsync.mockResolvedValueOnce({
          conversationId: 'existing-convo-id',
          messageId: 'second-message-id',
          sourceFile: { file_id: 'source-file-2', filename: 'recording-2.mp3' },
          status: 'queued',
          queuePosition: 2,
        });
        const secondHandle = result.current.handleFiles([secondFile]);
        await act(async () => {
          await Promise.resolve();
        });

        // The second attach's own POST doesn't fire yet - it awaits the
        // first attach's `parentMessageId` promise (chained, since the first
        // hasn't resolved) before it can even build its form data. Pending
        // upload + navigation/search-params for the SECOND file already
        // happened synchronously regardless (asserted implicitly by this not
        // hanging) - only the actual network call is what waits.
        expect(mockTranscribeMutateAsync).toHaveBeenCalledTimes(1);

        await act(async () => {
          releaseFirstUpload?.();
          await firstHandle;
          await secondHandle;
        });

        expect(mockTranscribeMutateAsync).toHaveBeenCalledTimes(2);
        const firstFormData: FormData = mockTranscribeMutateAsync.mock.calls[0][0].formData;
        const secondFormData: FormData = mockTranscribeMutateAsync.mock.calls[1][0].formData;
        expect(firstFormData.get('parentMessageId')).toBe(Constants.NO_PARENT);
        // Chained onto the first recording's real message id - not
        // `Constants.NO_PARENT` (which is what the stale `latestMessageId`
        // theory would have produced, making the two siblings).
        expect(secondFormData.get('parentMessageId')).toBe('first-message-id');
      },
    );

    it(
      "chains a second recording onto the conversation's real current leaf, not a stale " +
        'earlier recording - regression: an ordinary ask() reply sent between two recordings ' +
        "advanced the conversation's real leaf with no way for the transcribe-only chain to " +
        'find out, so the second recording chained onto the FIRST recording instead, landing ' +
        'as a sibling of the question-and-answer that followed it - which LibreChat renders ' +
        'as only the newest sibling, making the whole exchange appear to vanish',
      async () => {
        mockConversation = {
          conversationId: 'existing-convo-id',
          endpoint: 'openAI',
          endpointType: 'openAI',
        };
        mockLatestMessageId = undefined;
        mockInterceptAudioVideo.mockResolvedValue({
          action: 'transcribe',
          options: { includeTimestamps: true, diarize: true },
        });
        mockTranscribeMutateAsync.mockResolvedValueOnce({
          conversationId: 'existing-convo-id',
          messageId: 'first-message-id',
          sourceFile: { file_id: 'source-file-1', filename: 'recording-1.mp3' },
          status: 'queued',
          queuePosition: 1,
        });

        const useFileHandling = await loadHook();
        const { result, rerender } = renderHook(() => useFileHandling());

        const firstFile = new File(['x'], 'recording-1.mp3', { type: 'audio/mpeg' });
        await act(async () => {
          await result.current.handleFiles([firstFile]);
        });
        expect(mockTranscribeMutateAsync).toHaveBeenCalledTimes(1);

        // An ordinary ask() reply lands after the first recording, advancing
        // the conversation's real leaf - the chain has no visibility into
        // this, only `latestMessageId` (from chat context) reflects it.
        mockLatestMessageId = 'assistant-reply-id';
        rerender();

        mockTranscribeMutateAsync.mockResolvedValueOnce({
          conversationId: 'existing-convo-id',
          messageId: 'second-message-id',
          sourceFile: { file_id: 'source-file-2', filename: 'recording-2.mp3' },
          status: 'queued',
          queuePosition: 2,
        });
        const secondFile = new File(['y'], 'recording-2.mp3', { type: 'audio/mpeg' });
        await act(async () => {
          await result.current.handleFiles([secondFile]);
        });

        expect(mockTranscribeMutateAsync).toHaveBeenCalledTimes(2);
        const secondFormData: FormData = mockTranscribeMutateAsync.mock.calls[1][0].formData;
        // Chained onto the conversation's real current leaf (the assistant's
        // reply) - not the first recording's own message id, which would
        // orphan the question-and-answer in between as a sibling branch.
        expect(secondFormData.get('parentMessageId')).toBe('assistant-reply-id');
      },
    );
  });
});
