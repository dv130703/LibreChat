import { memo, useRef, useMemo, useEffect, useState, useCallback } from 'react';
import type { ReactNode } from 'react';
import { useWatch } from 'react-hook-form';
import { TextareaAutosize } from '@librechat/client';
import { useRecoilState, useRecoilValue, useRecoilCallback } from 'recoil';
import { Constants, isAgentsEndpoint } from 'librechat-data-provider';
import type { TMessage, TConversation } from 'librechat-data-provider';
import type { ExtendedFile, FileSetter, ConvoGenerator } from '~/common';
import type { QueuedMessageContext } from '~/hooks/Chat/useSteering';
import {
  useTextarea,
  useAutoSave,
  useLocalize,
  useRequiresKey,
  useHandleKeyUp,
  useQueryParams,
  useSubmitMessage,
  useFocusChatEffect,
} from '~/hooks';
import { useChatContext, useChatFormContext, useAddedChatContext } from '~/Providers';
import PendingManualSkillsChips from './PendingManualSkillsChips';
import useAskAnswerMode from '~/hooks/Input/useAskAnswerMode';
import AskUserQuestionPopover from './AskUserQuestionPopover';
import { cn, getModelSpec, removeFocusRings } from '~/utils';
import DuringRunSendButton from './DuringRunSendButton';
import { useGetStartupConfig, useCancelTranscriptionMutation } from '~/data-provider';
import { useConversationTranscriptionStatus } from '~/hooks/AudioTranscriber/useConversationTranscriptionStatus';
import { mainTextareaId, BadgeItem } from '~/common';
import PendingSteerChips from './PendingSteerChips';
import PendingQuoteChips from './PendingQuoteChips';
import ModelSelector from '~/components/Chat/Menus/Endpoints/ModelSelector';
import AttachFileChat from './Files/AttachFileChat';
import useSteering from '~/hooks/Chat/useSteering';
import FileFormChat from './Files/FileFormChat';
import InFlightSteers from './InFlightSteers';
import TextareaHeader from './TextareaHeader';
import PromptsCommand from './PromptsCommand';
import SkillsCommand from './SkillsCommand';
import AudioRecorder from './AudioRecorder';
import CollapseChat from './CollapseChat';
import QuoteButton from './QuoteButton';
import StreamAudio from './StreamAudio';
import TokenUsage from './TokenUsage';
import StopButton from './StopButton';
import SendButton from './SendButton';
import EditBadges from './EditBadges';
import BadgeRow from './BadgeRow';
import Mention from './Mention';
import store from '~/store';

interface ChatFormProps {
  index: number;
  placeholder?: string;
  /** From ChatContext — individual values so memo can compare them */
  files: Map<string, ExtendedFile>;
  setFiles: FileSetter;
  conversation: TConversation | null;
  setConversation?: (conversation: TConversation) => void;
  latestMessageId?: string;
  isSubmitting: boolean;
  filesLoading: boolean;
  setFilesLoading: React.Dispatch<React.SetStateAction<boolean>>;
  newConversation: ConvoGenerator;
  handleStopGenerating: (e: React.MouseEvent<HTMLButtonElement>) => void;
  stopGenerating: () => void;
}

const ChatForm = memo(function ChatForm({
  index,
  placeholder,
  files,
  setFiles,
  conversation,
  setConversation,
  latestMessageId,
  isSubmitting,
  filesLoading,
  setFilesLoading,
  newConversation,
  handleStopGenerating,
  stopGenerating,
}: ChatFormProps) {
  const submitButtonRef = useRef<HTMLButtonElement>(null);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  useFocusChatEffect(textAreaRef);
  const localize = useLocalize();

  const [isCollapsed, setIsCollapsed] = useState(false);
  const [, setIsScrollable] = useState(false);
  const [visualRowCount, setVisualRowCount] = useState(1);
  const [isTextAreaFocused, setIsTextAreaFocused] = useState(false);
  const [backupBadges, setBackupBadges] = useState<Pick<BadgeItem, 'id'>[]>([]);

  const SpeechToText = useRecoilValue(store.speechToText);
  const TextToSpeech = useRecoilValue(store.textToSpeech);
  const chatDirection = useRecoilValue(store.chatDirection);
  const automaticPlayback = useRecoilValue(store.automaticPlayback);
  const maximizeChatSpace = useRecoilValue(store.maximizeChatSpace);
  const centerFormOnLanding = useRecoilValue(store.centerFormOnLanding);
  const isTemporary = useRecoilValue(store.isTemporary);

  const [badges, setBadges] = useRecoilState(store.chatBadges);
  const [isEditingBadges, setIsEditingBadges] = useRecoilState(store.isEditingBadges);
  const [showStopButton, setShowStopButton] = useRecoilState(store.showStopButtonByIndex(index));
  const plusPopoverAtom = useMemo(() => store.showPlusPopoverFamily(index), [index]);
  const mentionPopoverAtom = useMemo(() => store.showMentionPopoverFamily(index), [index]);

  const { requiresKey } = useRequiresKey();
  const methods = useChatFormContext();
  const {
    generateConversation,
    conversation: addedConvo,
    setConversation: setAddedConvo,
  } = useAddedChatContext();
  const { data: startupConfig } = useGetStartupConfig();

  const endpoint = useMemo(
    () => conversation?.endpointType ?? conversation?.endpoint,
    [conversation?.endpointType, conversation?.endpoint],
  );
  const modelSpec = useMemo(
    () => getModelSpec({ specName: conversation?.spec, startupConfig }),
    [conversation?.spec, startupConfig],
  );
  const hideBadgeRow = modelSpec?.hideBadgeRow === true;
  const conversationId = useMemo(
    () => conversation?.conversationId ?? Constants.NEW_CONVO,
    [conversation?.conversationId],
  );
  const isRTL = useMemo(
    () => (chatDirection != null ? chatDirection?.toLowerCase() === 'rtl' : false),
    [chatDirection],
  );
  /** A recording still uploading (before `POST /api/transcribe` has even
   *  resolved into a real, cancellable job) - `useConversationTranscriptionStatus`
   *  below only knows about a job that already exists server-side, so on its
   *  own this window left the composer fully usable: free to type and send a
   *  new message while a recording was still going up, instead of showing
   *  the same busy/locked state a real transcription or LLM run gets. */
  const hasPendingTranscriptionUpload = useRecoilValue(
    store.pendingTranscriptionUploadsByConvoId(conversationId),
  ).some((upload) => upload.status === 'uploading');
  const disableInputs = useMemo(
    () => requiresKey || hasPendingTranscriptionUpload,
    [requiresKey, hasPendingTranscriptionUpload],
  );

  const handleContainerClick = useCallback(() => {
    /** Check if the device is a touchscreen */
    if (window.matchMedia?.('(pointer: coarse)').matches) {
      return;
    }
    textAreaRef.current?.focus();
  }, []);

  const handleFocusOrClick = useCallback(() => {
    if (isCollapsed) {
      setIsCollapsed(false);
    }
  }, [isCollapsed]);

  const handleTextareaFocus = useCallback(() => {
    handleFocusOrClick();
    setIsTextAreaFocused(true);
  }, [handleFocusOrClick]);

  const handleTextareaBlur = useCallback(() => {
    setIsTextAreaFocused(false);
  }, []);

  const answerMode = useAskAnswerMode(conversationId);
  const { isTranscribing, nonTerminalSourceFileIds } =
    useConversationTranscriptionStatus(conversationId);
  const cancelTranscription = useCancelTranscriptionMutation();
  const handleCancelTranscription = useCallback(() => {
    // Never more than one in practice (the job queue only ever runs one at a
    // time), but a conversation can carry more than one recording - cancel
    // every non-terminal one this button is currently standing in for.
    nonTerminalSourceFileIds.forEach((sourceFileId) => {
      cancelTranscription.mutate({ sourceFileId });
    });
  }, [nonTerminalSourceFileIds, cancelTranscription]);

  useAutoSave({
    files,
    setFiles,
    textAreaRef,
    conversationId,
    isSubmitting,
    // While a question pause is live the composer is the answer box: drafts
    // swap to the answer's own key, and the conversation draft is restored
    // when the question resolves.
    draftId: answerMode.draftId,
  });

  const { submitMessage, submitPrompt } = useSubmitMessage();

  /** Queued/steered sends carry their FULL submission context: explicit
   *  (possibly empty) overrides stop `ask` from vacuuming quotes or skill
   *  picks the user has staged in the composer for their NEXT message. */
  const sendNow = useCallback(
    (text: string, overrideFiles?: TMessage['files'], context?: QueuedMessageContext) =>
      submitMessage({
        text,
        overrideFiles,
        overrideQuotes: context?.quotes ?? [],
        overrideManualSkills: context?.manualSkills ?? [],
      }),
    [submitMessage],
  );
  /** Chip "Edit message" restore: quote chips + skill picks merge back into
   *  their compose-time atoms (the chips above the textarea re-render them). */
  const restoreComposerContext = useRecoilCallback(
    ({ set }) =>
      (context?: QueuedMessageContext) => {
        const { quotes, manualSkills } = context ?? {};
        if (quotes != null && quotes.length > 0) {
          set(store.pendingQuotesByConvoId(conversationId), (prev) => [
            ...new Set([...prev, ...quotes]),
          ]);
        }
        if (manualSkills != null && manualSkills.length > 0) {
          set(store.pendingManualSkillsByConvoId(conversationId), (prev) => [
            ...new Set([...prev, ...manualSkills]),
          ]);
        }
      },
    [conversationId],
  );
  /** Chip "Edit message": the text replaces the composer draft and the chip's
   *  attachments merge back into the composer file map (already uploaded, so
   *  they restore as completed entries — same shape as draft recovery). */
  const editToComposer = useCallback(
    (text: string, chipFiles?: TMessage['files'], context?: QueuedMessageContext) => {
      methods.setValue('text', text, { shouldDirty: true });
      if (chipFiles != null && chipFiles.length > 0) {
        setFiles((prev) => {
          const next = new Map(prev);
          for (const file of chipFiles) {
            if (!file.file_id) {
              continue;
            }
            next.set(file.file_id, {
              file_id: file.file_id,
              filename: file.filename,
              filepath: file.filepath,
              type: file.type ?? '',
              height: file.height,
              width: file.width,
              size: file.bytes ?? 0,
              progress: 1,
              attached: true,
            });
          }
          return next;
        });
      }
      restoreComposerContext(context);
      textAreaRef.current?.focus();
    },
    [methods, setFiles, restoreComposerContext],
  );
  const steering = useSteering({
    index,
    conversationId,
    conversation,
    isSubmitting,
    answerModeActive: answerMode.active,
    files,
    setFiles,
    filesLoading,
    sendNow,
    stopGenerating,
  });

  /** Read at call time, not captured: a reclaim resolves into the callback from
   *  the render it was clicked in, so the closure's `conversationId` is the OLD
   *  chat — comparing it against itself would pass while `methods` (one form,
   *  reused across conversations) writes into the chat now on screen. */
  const liveConversationIdRef = useRef(conversationId);
  liveConversationIdRef.current = conversationId;
  /** Same reason: attachments staged after the click must be seen. */
  const liveFilesRef = useRef(files);
  liveFilesRef.current = files;
  /** Same reason: the run can pause on `ask_user_question` mid-reclaim. */
  const liveAnswerModeRef = useRef(answerMode.active);
  liveAnswerModeRef.current = answerMode.active;
  /** A reclaim can resolve after this form unmounts (left the route, closed the
   *  pane). Its refs still hold the origin chat, so the restore would pass its
   *  checks and write into a dead form — reporting success and making the caller
   *  drop the steer, losing the text. Track mount so the restore refuses and the
   *  caller queues it instead. */
  const composerMountedRef = useRef(true);
  useEffect(
    () => () => {
      composerMountedRef.current = false;
    },
    [],
  );

  /** A draft is anything the user has staged, not just typed: `editToComposer`
   *  MERGES the steer's attachments into the composer's file map and its quotes
   *  and skill picks into their atoms, so restoring over staged context would
   *  glue the two submissions together. */
  const hasStagedComposerContext = useRecoilCallback(
    ({ snapshot }) =>
      (convoId: string) =>
        snapshot.getLoadable(store.pendingQuotesByConvoId(convoId)).getValue().length > 0 ||
        snapshot.getLoadable(store.pendingManualSkillsByConvoId(convoId)).getValue().length > 0,
    [],
  );

  /**
   * `editToComposer` for a steer whose reclaim was a round-trip: by the time it
   * resolves the composer may have moved on. Refuses (returning false, so the
   * caller re-homes the words instead of dropping them) rather than overwrite a
   * draft the user has since staged, or drop a steer into whatever chat they
   * navigated to.
   */
  const restoreReclaimedSteer = useCallback(
    (
      text: string,
      steerFiles: TMessage['files'],
      context: QueuedMessageContext,
      originConversationId: string,
    ): boolean => {
      if (!composerMountedRef.current) {
        return false;
      }
      const liveConversationId = liveConversationIdRef.current;
      if (originConversationId !== liveConversationId) {
        return false;
      }
      /** Answer mode owns the composer: `onSubmit` hands its text to
       *  `answerMode.submitText` before any send/steer routing, so restoring
       *  here would turn the steer into the tool's answer on the next Enter. */
      if (liveAnswerModeRef.current) {
        return false;
      }
      if (
        (methods.getValues('text') ?? '').trim().length > 0 ||
        (liveFilesRef.current?.size ?? 0) > 0 ||
        hasStagedComposerContext(liveConversationId)
      ) {
        return false;
      }
      editToComposer(text, steerFiles, context);
      return true;
    },
    [methods, editToComposer, hasStagedComposerContext],
  );

  /** ⌘/Ctrl+Enter = the non-default during-run action, ⌥/Alt+Enter =
   *  interrupt & send — the counterpart of Enter's `submitDuringRun`. */
  const handleDuringRunModifier = useCallback(
    (kind: 'other' | 'interrupt') => {
      const text = methods.getValues('text');
      let consumed = false;
      if (kind === 'interrupt') {
        consumed = steering.interruptAndSend(text);
      } else if (steering.effectiveAction === 'steer') {
        consumed = steering.queueFromComposer(text);
      } else {
        consumed = steering.steerFromComposer(text);
      }
      if (consumed) {
        methods.reset();
      }
    },
    [methods, steering],
  );

  const handleKeyUp = useHandleKeyUp({
    index,
    textAreaRef,
  });
  const {
    isNotAppendable,
    handlePaste,
    handleKeyDown,
    handleCompositionStart,
    handleCompositionEnd,
  } = useTextarea({
    textAreaRef,
    submitButtonRef,
    setIsScrollable,
    disabled: disableInputs,
    // Disabled for a reason that has nothing to do with a missing key -
    // the generic fallback copy `disabled` alone would show is actively
    // misleading here.
    disabledPlaceholder: hasPendingTranscriptionUpload
      ? localize('com_ui_transcript_panel_awaiting_upload')
      : undefined,
    // The composer IS the free-form answer box while a question pause is live.
    placeholder: answerMode.active
      ? (answerMode.otherLabel ?? localize('com_ui_something_else'))
      : placeholder,
    // Enter stays live during a run when it can steer/queue instead of send.
    allowSubmitWhileGenerating: steering.duringRunActive,
    onDuringRunModifier: steering.duringRunActive ? handleDuringRunModifier : undefined,
  });

  useQueryParams({ textAreaRef });

  const { ref, ...registerProps } = methods.register('text', {
    /** A caption-less attachment ("just send the photo") is a valid submission —
     *  only require typed text when there's nothing else to send. */
    required: files.size === 0,
    onChange: useCallback(
      (e: React.ChangeEvent<HTMLTextAreaElement>) =>
        methods.setValue('text', e.target.value, { shouldValidate: true }),
      [methods],
    ),
  });

  const textValue = useWatch({ control: methods.control, name: 'text' });

  useEffect(() => {
    if (textAreaRef.current) {
      const style = window.getComputedStyle(textAreaRef.current);
      const lineHeight = parseFloat(style.lineHeight);
      setVisualRowCount(Math.floor(textAreaRef.current.scrollHeight / lineHeight));
    }
  }, [textValue]);

  useEffect(() => {
    if (isEditingBadges && backupBadges.length === 0) {
      setBackupBadges([...badges]);
    }
  }, [isEditingBadges, badges, backupBadges.length]);

  const handleSaveBadges = useCallback(() => {
    setIsEditingBadges(false);
    setBackupBadges([]);
  }, [setIsEditingBadges, setBackupBadges]);

  const handleCancelBadges = useCallback(() => {
    if (backupBadges.length > 0) {
      setBadges([...backupBadges]);
    }
    setIsEditingBadges(false);
    setBackupBadges([]);
  }, [backupBadges, setBadges, setIsEditingBadges]);

  const isMoreThanThreeRows = visualRowCount > 3;

  /** One button slot while a run is generating: with composer text the send
   *  button takes over (Enter steers/queues; hover reveals all actions);
   *  clearing the text restores Stop. */
  const duringRunSlot =
    steering.duringRunActive && (textValue?.trim() ?? '') !== '' ? (
      <DuringRunSendButton
        ref={submitButtonRef}
        control={methods.control}
        steering={steering}
        getText={() => methods.getValues('text')}
        onConsumed={() => methods.reset()}
        disabled={filesLoading}
      />
    ) : (
      <StopButton stop={handleStopGenerating} setShowStopButton={setShowStopButton} />
    );

  /** The composer's primary action slot outside an active LLM run - a
   *  transcription job in flight for this conversation reuses the same
   *  stop-square affordance `duringRunSlot` uses for LLM streaming (the
   *  composer is still "busy" from the user's point of view either way),
   *  otherwise the ordinary send button. Computed as its own variable,
   *  not a nested ternary in the JSX below, purely for lint-rule
   *  readability - three mutually exclusive states read better as early
   *  returns than as chained `? :`. */
  let composerActionSlot: ReactNode = null;
  if (isSubmitting && showStopButton && !answerMode.active) {
    composerActionSlot = duringRunSlot;
  } else if (isTranscribing || hasPendingTranscriptionUpload) {
    composerActionSlot = (
      <StopButton
        stop={handleCancelTranscription}
        setShowStopButton={() => {}}
        label={localize('com_ui_transcribe_stop_cancel')}
        // Nothing to cancel yet while the recording is still uploading - no
        // real job exists server-side until that resolves.
        disabled={!isTranscribing}
      />
    );
  } else if (endpoint) {
    composerActionSlot = (
      <SendButton
        ref={submitButtonRef}
        control={methods.control}
        hasFiles={files.size > 0}
        disabled={
          filesLoading || disableInputs || isNotAppendable || (isSubmitting && !answerMode.active)
        }
      />
    );
  }

  const baseClasses = useMemo(
    () =>
      cn(
        'md:py-3.5 m-0 w-full resize-none py-[13px] placeholder-black/60 bg-transparent dark:placeholder-white/60 [&:has(textarea:focus)]:shadow-[0_2px_6px_rgba(0,0,0,.05)]',
        isCollapsed ? 'max-h-[52px]' : 'max-h-[45vh] md:max-h-[55vh]',
        isMoreThanThreeRows ? 'pl-5' : 'px-5',
      ),
    [isCollapsed, isMoreThanThreeRows],
  );

  return (
    <form
      onSubmit={methods.handleSubmit((data) => {
        // Answer mode: composer text answers the paused run instead of
        // starting a new turn (submitText resets the composer itself).
        // Dismissing the popover restores normal sends.
        if (answerMode.active && answerMode.submitText(data.text)) {
          return;
        }
        // During a run, a submit steers or queues per the effective action
        // instead of starting a new turn (which would be dropped anyway).
        if (steering.duringRunActive) {
          if (steering.submitDuringRun(data.text)) {
            methods.reset();
          }
          return;
        }
        return submitMessage(data);
      })}
      className={cn(
        'mx-auto flex w-full flex-row gap-3 transition-[max-width] duration-300 sm:px-2',
        maximizeChatSpace ? 'max-w-full' : 'md:max-w-3xl xl:max-w-4xl',
        centerFormOnLanding &&
          (conversationId == null || conversationId === Constants.NEW_CONVO) &&
          !isSubmitting &&
          conversation?.messages?.length === 0
          ? 'transition-all duration-200 sm:mb-28'
          : 'sm:mb-10',
      )}
    >
      <div className="relative flex h-full flex-1 items-stretch md:flex-col">
        {/* Primary composer owns the selection popup so split-view doesn't double it. */}
        {index === 0 && <QuoteButton conversationId={conversationId} />}
        {/* `relative` anchors the in-flight steer overlay, which floats above
            the composer (`bottom-full`) over the bottom of the thread. */}
        <div className="relative flex w-full flex-col">
          {/* Run-scoped: `enabled` alone is any primary composer on a steerable
              endpoint, so a chip that outlives the run would strand a bubble. */}
          {steering.enabled && isSubmitting && (
            <InFlightSteers
              steering={steering}
              conversationId={conversationId}
              onRestoreToComposer={restoreReclaimedSteer}
            />
          )}
          <div className={cn('flex w-full items-center', isRTL && 'flex-row-reverse')}>
            <Mention
              index={index}
              popoverAtom={plusPopoverAtom}
              newConversation={generateConversation}
              textAreaRef={textAreaRef}
              commandChar="+"
              placeholder="com_ui_add_model_preset"
            />
            <Mention
              index={index}
              popoverAtom={mentionPopoverAtom}
              newConversation={newConversation}
              textAreaRef={textAreaRef}
            />
            <PromptsCommand index={index} textAreaRef={textAreaRef} submitPrompt={submitPrompt} />
            {index === 0 && (
              <AskUserQuestionPopover conversationId={conversationId} textAreaRef={textAreaRef} />
            )}
            <SkillsCommand
              index={index}
              textAreaRef={textAreaRef}
              conversationId={conversationId}
              agentId={conversation?.agent_id}
            />
            <div
              onClick={handleContainerClick}
              className={cn(
                'relative flex w-full flex-grow flex-col overflow-hidden rounded-t-3xl border pb-4 text-text-primary transition-all duration-200 sm:rounded-3xl sm:pb-0',
                isTextAreaFocused ? 'shadow-lg' : 'shadow-md',
                isTemporary
                  ? 'border-violet-800/60 bg-violet-950/10'
                  : 'border-border-light bg-surface-chat',
              )}
            >
              <TextareaHeader addedConvo={addedConvo} setAddedConvo={setAddedConvo} />
              <PendingManualSkillsChips conversationId={conversationId} />
              <PendingQuoteChips conversationId={conversationId} />
              {steering.enabled && (
                <PendingSteerChips
                  conversationId={conversationId}
                  steering={steering}
                  onEditToComposer={editToComposer}
                  onRestoreToComposer={restoreReclaimedSteer}
                />
              )}
              {/* WIP */}
              <EditBadges
                isEditingChatBadges={isEditingBadges}
                handleCancelBadges={handleCancelBadges}
                handleSaveBadges={handleSaveBadges}
                setBadges={setBadges}
              />
              <FileFormChat
                conversation={conversation}
                files={files}
                setFiles={setFiles}
                setFilesLoading={setFilesLoading}
              />
              {endpoint && (
                <div className={cn('flex', isRTL ? 'flex-row-reverse' : 'flex-row')}>
                  <div
                    className="relative flex-1"
                    style={
                      isCollapsed
                        ? {
                            WebkitMaskImage:
                              'linear-gradient(to bottom, black 60%, transparent 90%)',
                            maskImage: 'linear-gradient(to bottom, black 60%, transparent 90%)',
                          }
                        : undefined
                    }
                  >
                    <TextareaAutosize
                      {...registerProps}
                      ref={(e) => {
                        ref(e);
                        (
                          textAreaRef as React.MutableRefObject<HTMLTextAreaElement | null>
                        ).current = e;
                      }}
                      disabled={disableInputs || isNotAppendable}
                      onPaste={handlePaste}
                      onKeyDown={(e) => {
                        // Answer mode consumes option-navigation keys from the
                        // empty composer; everything else follows the normal path.
                        if (answerMode.handleComposerKeyDown(e)) {
                          return;
                        }
                        handleKeyDown(e);
                      }}
                      onKeyUp={handleKeyUp}
                      onCompositionStart={handleCompositionStart}
                      onCompositionEnd={handleCompositionEnd}
                      id={mainTextareaId}
                      tabIndex={0}
                      data-testid="text-input"
                      rows={1}
                      onFocus={handleTextareaFocus}
                      onBlur={handleTextareaBlur}
                      aria-label={localize('com_ui_message_input')}
                      onClick={handleFocusOrClick}
                      style={{ height: 44, overflowY: 'auto' }}
                      className={cn(
                        baseClasses,
                        removeFocusRings,
                        'scrollbar-hover transition-[max-height] duration-200 disabled:cursor-not-allowed',
                      )}
                    />
                  </div>
                  <div className="flex flex-col items-start justify-start pr-2.5 pt-1.5">
                    <CollapseChat
                      isCollapsed={isCollapsed}
                      isScrollable={isMoreThanThreeRows}
                      setIsCollapsed={setIsCollapsed}
                    />
                  </div>
                </div>
              )}
              <div
                // Fixed regardless of `isRTL`: this toolbar is icon controls,
                // not text content, so it doesn't mirror for RTL languages -
                // attach/tools stay left, send stays right, same as Claude's
                // own input bar. `isRTL` still governs the textarea above,
                // where it's genuinely about text direction.
                className="@container flex flex-row items-center gap-2 pb-2"
              >
                <div className="ml-2">
                  <AttachFileChat
                    conversation={conversation}
                    setConversation={setConversation}
                    latestMessageId={latestMessageId}
                    disableInputs={disableInputs}
                    files={files}
                    setFiles={setFiles}
                    setFilesLoading={setFilesLoading}
                  />
                </div>
                <BadgeRow
                  showEphemeralBadges={!!endpoint && !hideBadgeRow && !isAgentsEndpoint(endpoint)}
                  isSubmitting={isSubmitting}
                  conversationId={conversationId}
                  specName={conversation?.spec}
                  onChange={setBadges}
                  isInChat={
                    Array.isArray(conversation?.messages) && conversation.messages.length >= 1
                  }
                />
                <div className="mx-auto flex" />
                {/* Lives here, not the chat header, so the model/agent picker is
                    always in view right where the user is typing - see the
                    header's own note on why it moved. */}
                <div className="max-w-[220px] shrink-0">
                  <ModelSelector startupConfig={startupConfig} />
                </div>
                <TokenUsage index={index} conversation={conversation} isSubmitting={isSubmitting} />
                {SpeechToText && (
                  <AudioRecorder
                    methods={methods}
                    ask={submitMessage}
                    disabled={disableInputs || isNotAppendable}
                    isSubmitting={isSubmitting}
                  />
                )}
                <div className="mr-2">{composerActionSlot}</div>
              </div>
              {TextToSpeech && automaticPlayback && <StreamAudio index={index} />}
            </div>
          </div>
        </div>
      </div>
    </form>
  );
});
ChatForm.displayName = 'ChatForm';

/**
 * Wrapper that subscribes to ChatContext and passes stable individual values
 * to the memo'd ChatForm. This prevents ChatForm from re-rendering on every
 * streaming chunk — it only re-renders when the specific values it uses change.
 */
function ChatFormWrapper({ index = 0, placeholder }: { index?: number; placeholder?: string }) {
  const {
    files,
    setFiles,
    conversation,
    setConversation,
    latestMessageId,
    isSubmitting,
    filesLoading,
    setFilesLoading,
    newConversation,
    handleStopGenerating,
    stopGenerating,
  } = useChatContext();

  /**
   * Stabilize conversation reference: only update when rendering-relevant fields change,
   * not on every metadata update (e.g., title generation during streaming).
   */
  const hasMessages = (conversation?.messages?.length ?? 0) > 0;
  const stableConversation = useMemo(
    () => conversation,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      conversation?.conversationId,
      conversation?.endpoint,
      conversation?.endpointType,
      conversation?.agent_id,
      conversation?.assistant_id,
      conversation?.spec,
      conversation?.useResponsesApi,
      conversation?.model,
      conversation?.maxContextTokens,
      hasMessages,
    ],
  );

  /** Stabilize function refs so they never trigger ChatForm re-renders */
  const handleStopRef = useRef(handleStopGenerating);
  handleStopRef.current = handleStopGenerating;
  const stableHandleStop = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => handleStopRef.current(e),
    [],
  );

  const newConvoRef = useRef(newConversation);
  newConvoRef.current = newConversation;
  const stableNewConversation: ConvoGenerator = useCallback(
    (...args: Parameters<ConvoGenerator>): ReturnType<ConvoGenerator> =>
      newConvoRef.current(...args),
    [],
  );

  const stopRef = useRef(stopGenerating);
  stopRef.current = stopGenerating;
  const stableStop = useCallback(() => {
    void stopRef.current();
  }, []);

  return (
    <ChatForm
      index={index}
      placeholder={placeholder}
      files={files}
      setFiles={setFiles}
      conversation={stableConversation}
      setConversation={setConversation}
      latestMessageId={latestMessageId}
      isSubmitting={isSubmitting}
      filesLoading={filesLoading}
      setFilesLoading={setFilesLoading}
      newConversation={stableNewConversation}
      handleStopGenerating={stableHandleStop}
      stopGenerating={stableStop}
    />
  );
}

ChatFormWrapper.displayName = 'ChatFormWrapper';

export default ChatFormWrapper;
