import React, { useCallback, useEffect, useRef, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { v4 } from 'uuid';
import debounce from 'lodash/debounce';
import { useToastContext } from '@librechat/client';
import { useQueryClient } from '@tanstack/react-query';
import { useRecoilValue, useSetRecoilState, useRecoilCallback } from 'recoil';
import {
  QueryKeys,
  Constants,
  EToolResources,
  mergeFileConfig,
  isAssistantsEndpoint,
  getEndpointFileConfig,
  getConfiguredMimeAccept,
} from 'librechat-data-provider';
import type { EModelEndpoint, TError } from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import type { ExtendedFile, FileSetter } from '~/common';
import {
  logger,
  validateFiles,
  cachePreview,
  getCachedPreview,
  removePreviewEntry,
  isAudioOrVideoMimeType,
} from '~/utils';
import {
  useGetFileConfig,
  useUploadFileMutation,
  useTranscribeAudioMutation,
} from '~/data-provider';
import useLocalize, { TranslationKeys } from '~/hooks/useLocalize';
import { useDelayedUploadToast } from './useDelayedUploadToast';
import { useChatContext } from '~/Providers/ChatContext';
import { useTranscribeIntent } from '~/Providers/TranscribeIntentContext';
import { useSetConvoContext } from '~/Providers/SetConvoContext';
import store, { ephemeralAgentByConvoId } from '~/store';
import type { PendingTranscriptionUpload } from '~/store/families';
import useClientResize from './useClientResize';
import useUpdateFiles from './useUpdateFiles';
import { attemptTranscribeUpload } from './transcribeUpload';

type UseFileHandling = {
  fileSetter?: FileSetter;
  fileFilter?: (file: File) => boolean;
  additionalMetadata?: Record<string, string | undefined>;
  /** Overrides `endpoint` for upload routing; also used as `endpointType` fallback when `endpointTypeOverride` is not set */
  endpointOverride?: EModelEndpoint | string;
  /** Overrides `endpointType` independently from `endpointOverride` */
  endpointTypeOverride?: EModelEndpoint | string;
};

export type FileHandlingState = {
  files: Map<string, ExtendedFile>;
  setFiles: FileSetter;
  setFilesLoading?: React.Dispatch<React.SetStateAction<boolean>>;
  conversation?: TConversation | null;
  /** Current leaf message id for `conversation`, used as the `parentMessageId`
   *  of the synthetic message the transcribe-upload flow creates so it links
   *  onto the existing branch instead of becoming a disconnected root. */
  latestMessageId?: string;
  /** Same setter `ChatRoute`/`ChatView` read the conversation from
   *  (`useChatContext().setConversation`) - the transcribe flow uses this to
   *  seed a brand-new conversation's real id into that shared atom directly,
   *  instead of navigating to a URL the route itself would have to fetch. */
  setConversation?: (conversation: TConversation) => void;
};

const noop = () => {};

const useFileHandlingCore = (params: UseFileHandling | undefined, fileState: FileHandlingState) => {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const { showToast } = useToastContext();
  const [errors, setErrors] = useState<string[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);
  const { startUploadTimer, clearUploadTimer } = useDelayedUploadToast();
  const { files, setFiles, conversation, latestMessageId, setConversation } = fileState;
  const setFilesLoading = fileState.setFilesLoading ?? noop;
  const setEphemeralAgent = useSetRecoilState(
    ephemeralAgentByConvoId(conversation?.conversationId ?? Constants.NEW_CONVO),
  );
  const isTemporary = useRecoilValue(store.isTemporary);
  const setError = (error: string) => setErrors((prevErrors) => [...prevErrors, error]);
  const { addFile, replaceFile, updateFileById, deleteFileById } = useUpdateFiles(
    params?.fileSetter ?? setFiles,
  );
  const { resizeImageIfNeeded } = useClientResize();
  const { interceptAudioVideo } = useTranscribeIntent();
  const navigate = useNavigate();
  const [, setSearchParams] = useSearchParams();
  /** `useSearchParams`'s setter closes over the `searchParams` value from
   *  whichever render produced it (see its source: the function-updater form
   *  calls `nextInit(searchParams)` using that captured snapshot, not a fresh
   *  read at call time) - fine for a call made synchronously within the same
   *  render that captured it, but `onUploaded` below fires from deep inside
   *  an async upload that can take a second or more, well after this
   *  component has re-rendered (following this same function's own
   *  `navigate()` call) with a materially different `searchParams`. Calling
   *  the stale setter there sees an empty `prev` (this render's, from before
   *  the navigate), fails the "did the user navigate away" check that
   *  guards it, and - since this setter unconditionally calls `navigate()`
   *  with whatever the updater returns, unchanged or not - actually
   *  navigates to a blank query string, wiping `panel`/`file` and closing
   *  the transcript panel right as the real job starts. Reading through a
   *  ref updated on every render, same pattern `ChatPanelHost` already uses
   *  for its own callbacks, gets `onUploaded` the setter (and the fresh
   *  `searchParams` it's bound to) from whatever the LATEST render was. */
  const latestSetSearchParams = useRef(setSearchParams);
  latestSetSearchParams.current = setSearchParams;
  const hasSetConversation = useSetConvoContext();
  // `useRecoilCallback`, not `useSetRecoilState`, because `targetConversationId`
  // in `maybeInterceptAudioVideo` is only known at call time - a fresh v4()
  // for a brand-new conversation, not `conversation.conversationId` (which is
  // still `Constants.NEW_CONVO` at that point).
  const setPendingUploads = useRecoilCallback(
    ({ set }) =>
      (
        conversationId: string,
        updater: (current: PendingTranscriptionUpload[]) => PendingTranscriptionUpload[],
      ) => {
        set(store.pendingTranscriptionUploadsByConvoId(conversationId), updater);
      },
    [],
  );
  const transcribeAudioMutation = useTranscribeAudioMutation();
  /** One promise chain per conversation, so recordings queued back-to-back
   *  (before the first's own `POST /api/transcribe` has even resolved) still
   *  link up as parent/child in submission order, not as siblings under
   *  whatever `latestMessageId` happened to be at the moment each was
   *  attached - see `maybeInterceptAudioVideo`'s use of this below. */
  const transcribeLeafChainRef = useRef<Map<string, Promise<string>>>(new Map());
  /** What `latestMessageId` was the last time this ran, per conversation -
   *  lets the effect below tell "still the same leaf" from "the real
   *  conversation moved on" without re-deriving it from the chain's own
   *  (already-resolved, but not synchronously readable) promises. */
  const lastKnownLatestMessageIdRef = useRef<Map<string, string>>(new Map());
  /** An ordinary `ask()` reply sent after a transcribe upload advances the
   *  conversation's real leaf (`latestMessageId`, from chat context) with no
   *  way for `transcribeLeafChainRef` to find out - regression: attaching a
   *  second recording after asking a question about the first one chained it
   *  onto the FIRST recording's own message (the chain's last entry), making
   *  it a sibling of the question-and-answer that followed instead of a
   *  child of it. LibreChat's tree view renders only the newest sibling by
   *  default, so the whole exchange appeared to vanish the moment the second
   *  recording landed. Clearing the chain here whenever `latestMessageId`
   *  moves to something the chain didn't itself produce falls through to
   *  `maybeInterceptAudioVideo`'s own `latestMessageId` fallback below,
   *  which is correct again once nothing else has changed it - and is a
   *  no-op right after a transcribe upload resolves, since at that instant
   *  `latestMessageId` and the chain's own entry are the same value anyway. */
  useEffect(() => {
    const convoId = conversation?.conversationId;
    if (!convoId || !latestMessageId) {
      return;
    }
    if (lastKnownLatestMessageIdRef.current.get(convoId) !== latestMessageId) {
      lastKnownLatestMessageIdRef.current.set(convoId, latestMessageId);
      transcribeLeafChainRef.current.delete(convoId);
    }
  }, [conversation?.conversationId, latestMessageId]);

  const agent_id = params?.additionalMetadata?.agent_id ?? '';
  const assistant_id = params?.additionalMetadata?.assistant_id ?? '';
  const isConversationUpload = !agent_id && !assistant_id;
  const endpointOverride = params?.endpointOverride;
  const endpointTypeOverride = params?.endpointTypeOverride;
  const endpointType = useMemo(
    () => endpointTypeOverride ?? endpointOverride ?? conversation?.endpointType,
    [endpointTypeOverride, endpointOverride, conversation?.endpointType],
  );
  const endpoint = useMemo(
    () => endpointOverride ?? conversation?.endpoint ?? 'default',
    [endpointOverride, conversation?.endpoint],
  );

  const { data: fileConfig = null } = useGetFileConfig({
    select: (data) => mergeFileConfig(data),
  });

  const displayToast = useCallback(() => {
    if (errors.length > 1) {
      // TODO: this should not be a dynamic localize input!!
      const errorList = Array.from(new Set(errors))
        .map((e, i) => `${i > 0 ? '• ' : ''}${localize(e as TranslationKeys) || e}\n`)
        .join('');
      showToast({
        message: errorList,
        status: 'error',
        duration: 5000,
      });
    } else if (errors.length === 1) {
      // TODO: this should not be a dynamic localize input!!
      const message = localize(errors[0] as TranslationKeys) || errors[0];
      showToast({
        message,
        status: 'error',
        duration: 5000,
      });
    }

    setErrors([]);
  }, [errors, showToast, localize]);

  const debouncedDisplayToast = debounce(displayToast, 250);

  useEffect(() => {
    if (errors.length > 0) {
      debouncedDisplayToast();
    }

    return () => debouncedDisplayToast.cancel();
  }, [errors, debouncedDisplayToast]);

  const uploadFile = useUploadFileMutation(
    {
      onSuccess: (data) => {
        clearUploadTimer(data.temp_file_id);
        console.log('upload success', data);
        if (agent_id) {
          queryClient.refetchQueries([QueryKeys.agent, agent_id]);
          return;
        }
        updateFileById(
          data.temp_file_id,
          {
            progress: 0.9,
            filepath: data.filepath,
          },
          assistant_id ? true : false,
        );

        setTimeout(() => {
          const cachedBlob = getCachedPreview(data.temp_file_id);
          if (cachedBlob && data.file_id !== data.temp_file_id) {
            cachePreview(data.file_id, cachedBlob);
            removePreviewEntry(data.temp_file_id);
          }
          updateFileById(
            data.temp_file_id,
            {
              progress: 1,
              file_id: data.file_id,
              temp_file_id: data.temp_file_id,
              filepath: data.filepath,
              type: data.type,
              height: data.height,
              width: data.width,
              filename: data.filename,
              source: data.source,
              embedded: data.embedded,
            },
            assistant_id ? true : false,
          );
        }, 300);
      },
      onError: (_error, body) => {
        const error = _error as TError | undefined;
        console.log('upload error', error);
        const file_id = body.get('file_id');
        const tool_resource = body.get('tool_resource');
        if (tool_resource === EToolResources.execute_code) {
          setEphemeralAgent((prev) => ({
            ...prev,
            [EToolResources.execute_code]: false,
          }));
        }
        clearUploadTimer(file_id as string);
        deleteFileById(file_id as string);

        let errorMessage = 'com_error_files_upload';

        if (error?.code === 'ERR_CANCELED') {
          errorMessage = 'com_error_files_upload_canceled';
        } else if (error?.response?.data?.message) {
          errorMessage = error.response.data.message;
        }
        setError(errorMessage);
      },
    },
    abortControllerRef.current?.signal,
  );

  const startUpload = async (extendedFile: ExtendedFile) => {
    const filename = extendedFile.file?.name ?? 'File';
    startUploadTimer(extendedFile.file_id, filename, extendedFile.size);

    const formData = new FormData();
    formData.append('endpoint', endpoint);
    formData.append('endpointType', endpointType ?? '');
    formData.append('file', extendedFile.file as File, encodeURIComponent(filename));
    formData.append('file_id', extendedFile.file_id);
    if (
      isConversationUpload &&
      conversation?.conversationId &&
      conversation.conversationId !== Constants.NEW_CONVO
    ) {
      formData.append('conversationId', conversation.conversationId);
    }
    if (isTemporary && isConversationUpload) {
      formData.append('isTemporary', 'true');
    }

    const width = extendedFile.width ?? 0;
    const height = extendedFile.height ?? 0;
    if (width) {
      formData.append('width', width.toString());
    }
    if (height) {
      formData.append('height', height.toString());
    }

    const metadata = params?.additionalMetadata ?? {};
    if (params?.additionalMetadata) {
      for (const [key, value = ''] of Object.entries(metadata)) {
        if (value) {
          formData.append(key, value);
        }
      }
    }

    if (!isAssistantsEndpoint(endpointType ?? endpoint)) {
      if (!agent_id) {
        formData.append('message_file', 'true');
      }
      const tool_resource = extendedFile.tool_resource;
      if (tool_resource != null) {
        formData.append('tool_resource', tool_resource);
      }
      if (conversation?.agent_id != null && formData.get('agent_id') == null) {
        formData.append('agent_id', conversation.agent_id);
      }

      uploadFile.mutate(formData);
      return;
    }

    uploadFile.mutate(formData);
  };

  const loadImage = (extendedFile: ExtendedFile, preview: string) => {
    const img = new Image();
    img.onload = async () => {
      extendedFile.width = img.width;
      extendedFile.height = img.height;
      extendedFile = {
        ...extendedFile,
        progress: 0.6,
      };
      replaceFile(extendedFile);

      await startUpload(extendedFile);
    };
    img.src = preview;
  };

  /**
   * Composer entry point for transcription (Phase 4, transcription/
   * ARCHITECTURE.md §6.1/§6.4) - asks `TranscribeIntentProvider` whether the
   * user wants to transcribe or just attach, and on "transcribe" navigates
   * into the transcript panel immediately (before the upload itself even
   * starts) instead of waiting out the `POST /api/transcribe` round trip
   * first. Nothing exists server-side at that instant, so a client-only
   * pending record (`pendingTranscriptionUploadsByConvoId`) stands in for the
   * real file id until the upload resolves - `TranscriptPanel` renders it as
   * an "uploading" state and swaps it for the real id once `attemptTranscribeUpload`
   * (below) succeeds; a failure lands the same record in `status: 'failed'`
   * with a retry affordance, rather than losing the attempt.
   *
   * Two cases, because `POST /api/transcribe` always needs a real
   * `conversationId` up front (the async job has to know where to attach),
   * unlike a normal file upload, which can stay unassociated until the
   * conversation itself is created at first-message-send time:
   *  - An already-existing conversation: call it against that id directly,
   *    add the result to the composer's file strip like any other
   *    attachment - it becomes a `TranscriptCard` once the message is sent.
   *  - A brand-new, not-yet-sent draft (`Constants.NEW_CONVO`): there is no
   *    real id yet, so one is minted here and the job is queued against it
   *    immediately, then the app navigates into that conversation with the
   *    transcript panel open - mirroring what the standalone page always
   *    did for this exact case, rather than silently declining to transcribe
   *    it (the gap this used to fall into: the file would attach as a plain,
   *    inert upload the model has no way to actually read).
   */
  const maybeInterceptAudioVideo = async (
    extendedFile: ExtendedFile,
    originalFile: File,
  ): Promise<'attach' | 'handled' | 'navigated'> => {
    // `conversation` is only populated for the real chat composer (`useFileHandling`,
    // backed by `useChatContext`) - `useFileHandlingNoChatContext` callers like the
    // agent/assistant builder's Knowledge/CodeFiles panels pass no `conversation` at
    // all, and have no chat to queue a transcription job against.
    if (!isAudioOrVideoMimeType(originalFile.type) || conversation == null) {
      return 'attach';
    }

    const endpointFileConfig = getEndpointFileConfig({ endpoint, fileConfig, endpointType });
    const canAttachNatively =
      getConfiguredMimeAccept(endpointFileConfig?.supportedMimeTypes, {
        categories: ['audio', 'video'],
      }) != null;

    const result = await interceptAudioVideo(originalFile, canAttachNatively);
    if (result.action === 'attach') {
      return 'attach';
    }
    if (result.action === 'cancel') {
      deleteFileById(extendedFile.file_id);
      return 'handled';
    }

    const existingConversationId = conversation.conversationId;
    const isNewConversation =
      !existingConversationId || existingConversationId === Constants.NEW_CONVO;
    const targetConversationId = isNewConversation ? v4() : existingConversationId;
    const pendingId = v4();

    // Chains this attach onto whatever the PREVIOUS attach to this same
    // conversation resolves to, rather than reading `latestMessageId` (a
    // snapshot of a react-query cache that a same-conversation transcribe
    // upload updates via an un-awaited `invalidateQueries` - stale exactly
    // long enough for a second recording, attached moments after the first,
    // to compute the same parent the first one used). Both messages landing
    // under the same parent renders as siblings, and LibreChat's message
    // list shows only the newest sibling by default - the earlier recording
    // would visually vanish, not just show stale. `isNewConversation` has no
    // previous attach to chain onto; every subsequent attach to the
    // conversation this one is about to create/reuse does, via the entry
    // this call registers below regardless of which branch it takes.
    const previousLeafPromise = transcribeLeafChainRef.current.get(targetConversationId);
    const parentMessageIdPromise: Promise<string> = isNewConversation
      ? Promise.resolve(Constants.NO_PARENT as string)
      : (previousLeafPromise ??
        Promise.resolve(latestMessageId ?? (Constants.NO_PARENT as string)));
    let resolveThisLeaf: (messageId: string) => void = () => {};
    const thisLeafPromise = new Promise<string>((resolve) => {
      resolveThisLeaf = resolve;
    });
    transcribeLeafChainRef.current.set(targetConversationId, thisLeafPromise);
    // If this attach's own upload never reports a message id (queueing
    // failed before one existed), the chain must still advance - a next
    // attach waiting on `thisLeafPromise` would otherwise hang forever.
    // Falling through to this attach's OWN parent has the same effect as if
    // this failed attach had never happened.
    let queuedMessageId: string | undefined;

    setPendingUploads(targetConversationId, (current) => [
      ...current,
      {
        pendingId,
        conversationId: targetConversationId,
        filename: originalFile.name,
        file: originalFile,
        options: result.options,
        parentMessageId: parentMessageIdPromise,
        isNewConversation,
        isTemporary,
        status: 'uploading',
        createdAt: new Date().toISOString(),
      },
    ]);
    // The pending composer chip is discarded, not converted - the backend
    // creates a REAL message carrying this file once the upload resolves
    // (`POST /api/transcribe`, transcription/ARCHITECTURE.md #12), so the
    // recording shows up as its own "submitted file" bubble in the
    // conversation. Discarding it here rather than waiting for that message
    // is what makes the navigate below actually instant - the composer has
    // nothing further to show for this file either way.
    deleteFileById(extendedFile.file_id);

    if (isNewConversation) {
      // Seeds the exact Recoil atom `ChatRoute`/`ChatView` read the
      // conversation from, synchronously and with no server round trip -
      // mirrors `useNavigateToConvo`'s own pattern for jumping straight to a
      // conversation id (`hasSetConversation.current = true` BEFORE
      // `setConversation`, before navigating). `targetConversationId`
      // doesn't exist server-side yet - the upload below is what creates it
      // - so forcing `hasSetConversation.current = false` here (as this used
      // to) would instead make `ChatRoute`'s own hydration effect fetch that
      // id itself, get a 404 well before the upload finishes, and treat it
      // as "conversation not found": resetting straight back to `/c/new`
      // and wiping this navigate's URL out from under it (with the
      // transcript panel left showing a stale pending record for a URL the
      // app already abandoned). Keeping `hasSetConversation.current` true
      // keeps that fetch from ever firing in the first place.
      hasSetConversation.current = true;
      setConversation?.({ ...conversation, conversationId: targetConversationId });
      // Opens the transcript panel immediately, with the audio player and
      // an "uploading" placeholder, instead of landing on a bare empty chat
      // pane with nothing to do while the upload (and then the multi-minute
      // job) runs - matches the standalone page's old behavior for this
      // exact case (see the function doc comment above).
      navigate(
        `/c/${targetConversationId}?panel=transcript&file=${encodeURIComponent(pendingId)}`,
        { replace: true },
      );
    } else {
      // Same reasoning for an already-open conversation - queuing the job
      // leaves only an inert "Transcribing..." card in the message list
      // (`TranscriptCard`) until the panel is opened, same dead end while
      // nothing has uploaded yet. Already on this conversation's URL, so
      // just add the panel's query params to it instead of a full navigate.
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('panel', 'transcript');
          next.set('file', pendingId);
          return next;
        },
        { replace: false },
      );
    }

    // Fire-and-forget from this function's own perspective: the navigate
    // above already happened, so nothing here is on the caller's critical
    // path - `handleFiles`'s file-processing loop moves on immediately
    // (or, for a new conversation, is about to unmount anyway). Success/
    // failure is reported through the pending record itself, not this
    // promise - `attemptTranscribeUpload` never throws.
    void attemptTranscribeUpload({
      pendingId,
      targetConversationId,
      parentMessageId: parentMessageIdPromise,
      originalFile,
      options: result.options,
      endpoint,
      agentId: conversation?.agent_id,
      isTemporary,
      mutateAsync: transcribeAudioMutation.mutateAsync,
      queryClient,
      setPendingUploads,
      fallbackErrorMessage: localize('com_ui_audio_transcriber_error'),
      onQueued: (messageId) => {
        queuedMessageId = messageId;
        resolveThisLeaf(messageId);
      },
      // The earlier `setConversation` call (new-conversation branch above)
      // could only seed a client-side placeholder - nothing existed
      // server-side yet to fetch. This is what actually clears that
      // placeholder's "brand-new, unsent draft" shape (`createdAt: ''`,
      // etc.) once the conversation is genuinely real, the same way a
      // normal `ask()` send's SSE `final` event would - without it, every
      // ordinary send after this one keeps computing against a conversation
      // atom that still looks uncreated.
      onConversationRefreshed: (freshConversation) => {
        setConversation?.({ ...conversation, ...freshConversation });
      },
      onUploaded: (sourceFileId) => {
        latestSetSearchParams.current(
          (prev) => {
            if (prev.get('file') !== pendingId) {
              // The user has since navigated elsewhere (or opened a
              // different recording's panel) - swapping the URL here would
              // yank them back to a file they're no longer looking at.
              return prev;
            }
            const next = new URLSearchParams(prev);
            next.set('file', sourceFileId);
            return next;
          },
          { replace: true },
        );
      },
    }).then(async () => {
      // `onQueued` already resolved the chain on success. This only matters
      // when the upload failed before any message id existed (`onQueued`
      // never fired) - falls through to this attach's own parent so a next
      // attach chained on `thisLeafPromise` isn't left waiting forever on a
      // failed attempt, with the same effect as if this one had never
      // happened.
      if (queuedMessageId == null) {
        resolveThisLeaf(await parentMessageIdPromise);
      }
    });

    return isNewConversation ? 'navigated' : 'handled';
  };

  const handleFiles = async (_files: FileList | File[], _toolResource?: string) => {
    abortControllerRef.current = new AbortController();
    const fileList = Array.from(_files);
    /* Validate files */
    let filesAreValid: boolean;
    try {
      const endpointFileConfig = getEndpointFileConfig({
        endpoint,
        fileConfig,
        endpointType,
      });

      filesAreValid = validateFiles({
        files,
        fileList,
        setError,
        fileConfig,
        endpointFileConfig,
        toolResource: _toolResource,
      });
    } catch (error) {
      console.error('file validation error', error);
      setError('com_error_files_validation');
      return;
    }
    if (!filesAreValid) {
      setFilesLoading(false);
      return;
    }

    /* Process files */
    for (const originalFile of fileList) {
      const file_id = v4();
      try {
        // Create initial preview with original file
        const initialPreview = URL.createObjectURL(originalFile);
        cachePreview(file_id, initialPreview);

        // Create initial ExtendedFile to show immediately
        const initialExtendedFile: ExtendedFile = {
          file_id,
          file: originalFile,
          type: originalFile.type,
          preview: initialPreview,
          progress: 0.1, // Show as processing
          size: originalFile.size,
        };

        if (_toolResource != null && _toolResource !== '') {
          initialExtendedFile.tool_resource = _toolResource;
        }

        // Add file immediately to show in UI
        addFile(initialExtendedFile);

        const originalFileName = originalFile.name.toLowerCase();

        // Check if HEIC conversion is needed and show toast
        const isHEIC =
          originalFile.type === 'image/heic' ||
          originalFile.type === 'image/heif' ||
          /\.(heic|heif)$/.test(originalFileName);

        if (isHEIC) {
          showToast({
            message: localize('com_info_heic_converting'),
            status: 'info',
            duration: 3000,
          });
        }

        const heicProcessedFile = isHEIC
          ? await import('~/utils/heicConverter').then(({ processFileForUpload }) =>
              processFileForUpload(originalFile, 0.9, (conversionProgress) => {
                const adjustedProgress = 0.1 + conversionProgress * 0.4;
                replaceFile({
                  ...initialExtendedFile,
                  progress: adjustedProgress,
                });
              }),
            )
          : originalFile;

        let finalProcessedFile = heicProcessedFile;

        // Apply client-side resizing if available and appropriate
        if (heicProcessedFile.type.startsWith('image/')) {
          try {
            const resizeResult = await resizeImageIfNeeded(heicProcessedFile);
            finalProcessedFile = resizeResult.file;

            // Show toast notification if image was resized
            if (resizeResult.resized && resizeResult.result) {
              const { originalSize, newSize, compressionRatio } = resizeResult.result;
              const originalSizeMB = (originalSize / (1024 * 1024)).toFixed(1);
              const newSizeMB = (newSize / (1024 * 1024)).toFixed(1);
              const savedPercent = Math.round((1 - compressionRatio) * 100);

              showToast({
                message: `Image resized: ${originalSizeMB}MB → ${newSizeMB}MB (${savedPercent}% smaller)`,
                status: 'success',
                duration: 3000,
              });
            }
          } catch (resizeError) {
            console.warn('Image resize failed, using original:', resizeError);
            // Continue with HEIC processed file if resizing fails
          }
        }

        // If file was processed (HEIC converted or resized), update with new file and preview
        if (finalProcessedFile !== originalFile) {
          URL.revokeObjectURL(initialPreview); // Clean up original preview
          const newPreview = URL.createObjectURL(finalProcessedFile);
          cachePreview(file_id, newPreview);

          const updatedExtendedFile: ExtendedFile = {
            ...initialExtendedFile,
            file: finalProcessedFile,
            type: finalProcessedFile.type,
            preview: newPreview,
            progress: 0.5, // Processing complete, ready for upload
            size: finalProcessedFile.size,
          };

          replaceFile(updatedExtendedFile);

          const isImage = finalProcessedFile.type.split('/')[0] === 'image';
          if (isImage) {
            loadImage(updatedExtendedFile, newPreview);
            continue;
          }

          await startUpload(updatedExtendedFile);
        } else {
          // File wasn't processed, proceed with original
          const isImage = originalFile.type.split('/')[0] === 'image';

          // Update progress to show ready for upload
          const readyExtendedFile = {
            ...initialExtendedFile,
            progress: 0.2,
          };
          replaceFile(readyExtendedFile);

          if (isImage) {
            loadImage(readyExtendedFile, initialPreview);
            continue;
          }

          const interceptResult = await maybeInterceptAudioVideo(readyExtendedFile, originalFile);
          if (interceptResult === 'navigated') {
            // The transcribe flow just minted a brand-new conversation and
            // navigated into it - this component instance (and the whole
            // `ChatView`/`TranscribeIntentProvider` tree under it) is on its
            // way out. Any remaining files in this same drop/paste batch
            // would otherwise keep running against now-detached closures:
            // `addFile`/`setFiles` writing into an orphaned Recoil atom
            // nothing renders anymore, and `interceptAudioVideo` opening a
            // dialog inside a provider instance that's already unmounted -
            // which never resolves, since nothing is left to click through
            // it. Stopping here instead of continuing to the next file
            // avoids silently stranding it in an upload state the user can
            // never see or finish.
            break;
          }
          if (interceptResult === 'handled') {
            continue;
          }

          await startUpload(readyExtendedFile);
        }
      } catch (error) {
        deleteFileById(file_id);
        console.log('file handling error', error);
        if (error instanceof Error && error.message.includes('HEIC')) {
          setError('com_error_heic_conversion');
        } else {
          setError('com_error_files_process');
        }
      }
    }
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>, _toolResource?: string) => {
    event.stopPropagation();
    if (event.target.files) {
      setFilesLoading(true);
      handleFiles(event.target.files, _toolResource);
      // reset the input
      event.target.value = '';
    }
  };

  const abortUpload = () => {
    if (abortControllerRef.current) {
      logger.log('files', 'Aborting upload');
      abortControllerRef.current.abort('User aborted upload');
      abortControllerRef.current = null;
    }
  };

  return {
    handleFileChange,
    handleFiles,
    abortUpload,
    setFiles,
    files,
  };
};

export const useFileHandlingNoChatContext = (
  params: UseFileHandling | undefined,
  fileState: FileHandlingState,
) => useFileHandlingCore(params, fileState);

const useFileHandling = (params?: UseFileHandling) => {
  const { files, setFiles, setFilesLoading, conversation, latestMessageId, setConversation } =
    useChatContext();

  return useFileHandlingCore(params, {
    files,
    setFiles,
    conversation,
    setFilesLoading,
    latestMessageId,
    setConversation,
  });
};

export default useFileHandling;
