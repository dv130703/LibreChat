import { useEffect } from 'react';
import { LocalStorageKeys, isEphemeralAgentId, Constants } from 'librechat-data-provider';
import {
  atom,
  selector,
  atomFamily,
  DefaultValue,
  selectorFamily,
  useRecoilValue,
  useSetRecoilState,
  useRecoilCallback,
} from 'recoil';
import type {
  EModelEndpoint,
  TConversation,
  TSubmission,
  TMessage,
  TPreset,
  TTranscribeOptions,
} from 'librechat-data-provider';
import type { TOptionSettings, ExtendedFile } from '~/common';
import {
  clearModelForNonEphemeralAgent,
  createChatSearchParams,
  storeEndpointSettings,
  logger,
} from '~/utils';
import { useSetConvoContext } from '~/Providers/SetConvoContext';

const submissionKeysAtom = atom<(string | number)[]>({
  key: 'submissionKeys',
  default: [],
});

const submissionByIndex = atomFamily<TSubmission | null, string | number>({
  key: 'submissionByIndex',
  default: null,
});

const submissionKeysSelector = selector<(string | number)[]>({
  key: 'submissionKeysSelector',
  get: ({ get }) => {
    const keys = get(conversationKeysAtom);
    return keys.filter((key) => get(submissionByIndex(key)) !== null);
  },
  set: ({ set }, newKeys) => {
    logger.log('setting submissionKeysAtom', newKeys);
    set(submissionKeysAtom, newKeys);
  },
});

const conversationByIndex = atomFamily<TConversation | null, string | number>({
  key: 'conversationByIndex',
  default: null,
  effects: [
    ({ onSet, node }) => {
      onSet(async (newValue, oldValue) => {
        const index = Number(node.key.split('__')[1]);
        logger.log('conversation', 'Setting conversation:', { index, newValue, oldValue });
        if (newValue?.assistant_id != null && newValue.assistant_id) {
          localStorage.setItem(
            `${LocalStorageKeys.ASST_ID_PREFIX}${index}${newValue.endpoint}`,
            newValue.assistant_id,
          );
        }
        if (newValue?.agent_id != null && !isEphemeralAgentId(newValue.agent_id)) {
          localStorage.setItem(`${LocalStorageKeys.AGENT_ID_PREFIX}${index}`, newValue.agent_id);
        }
        if (newValue?.spec != null && newValue.spec) {
          localStorage.setItem(LocalStorageKeys.LAST_SPEC, newValue.spec);
        }
        if (newValue?.tools && Array.isArray(newValue.tools)) {
          localStorage.setItem(
            LocalStorageKeys.LAST_TOOLS,
            JSON.stringify(newValue.tools.filter((el) => !!el)),
          );
        }

        if (!newValue) {
          return;
        }

        storeEndpointSettings(newValue);

        const convoToStore = { ...newValue };
        clearModelForNonEphemeralAgent(convoToStore);
        localStorage.setItem(
          `${LocalStorageKeys.LAST_CONVO_SETUP}_${index}`,
          JSON.stringify(convoToStore),
        );

        const disableParams = newValue.disableParams === true;
        const shouldUpdateParams =
          index === 0 &&
          !disableParams &&
          newValue.createdAt === '' &&
          JSON.stringify(newValue) !== JSON.stringify(oldValue) &&
          (oldValue as TConversation)?.conversationId === Constants.NEW_CONVO;

        if (shouldUpdateParams) {
          const newParams = createChatSearchParams(newValue);
          if (newValue.chatProjectId) {
            newParams.set('projectId', newValue.chatProjectId);
          }
          // Merges onto whatever's already in the URL rather than replacing
          // the query string outright - this raw `pushState` bypasses React
          // Router entirely, so a concurrent flow that just navigated via the
          // router (e.g. the audio transcriber's instant-navigate, which opens
          // `?panel=transcript&file=<id>` on this exact same `/c/new` -> real-id
          // transition) has those params silently erased the moment this runs
          // right after, with nothing left to signal they ever existed - the
          // side panel then closes itself moments later when its own next
          // legitimate URL update reconciles against this now-corrupted
          // address bar and finds its params gone.
          const mergedParams = new URLSearchParams(window.location.search);
          newParams.forEach((value, key) => {
            mergedParams.set(key, value);
          });
          const url = `${window.location.pathname}?${mergedParams.toString()}`;
          window.history.pushState({}, '', url);
        }
      });
    },
  ] as const,
});

const filesByIndex = atomFamily<Map<string, ExtendedFile>, string | number>({
  key: 'filesByIndex',
  default: new Map(),
});

const conversationKeysAtom = atom<(string | number)[]>({
  key: 'conversationKeys',
  default: [],
});

const allConversationsSelector = selector({
  key: 'allConversationsSelector',
  get: ({ get }) => {
    const keys = get(conversationKeysAtom);
    return keys.map((key) => get(conversationByIndex(key))).map((convo) => convo?.conversationId);
  },
});

const conversationIdByIndex = selectorFamily<string | null, string | number>({
  key: 'conversationIdByIndex',
  get:
    (index: string | number) =>
    ({ get }) =>
      get(conversationByIndex(index))?.conversationId ?? null,
});

const conversationEndpointByIndex = selectorFamily<EModelEndpoint | null, string | number>({
  key: 'conversationEndpointByIndex',
  get:
    (index: string | number) =>
    ({ get }) =>
      get(conversationByIndex(index))?.endpoint ?? null,
});

/** Returns `endpointType ?? endpoint`, matching the effective endpoint used for feature gating. */
const effectiveEndpointByIndex = selectorFamily<EModelEndpoint | null, string | number>({
  key: 'effectiveEndpointByIndex',
  get:
    (index: string | number) =>
    ({ get }) => {
      const convo = get(conversationByIndex(index));
      return convo?.endpointType ?? convo?.endpoint ?? null;
    },
});

const conversationModelByIndex = selectorFamily<string | null, string | number>({
  key: 'conversationModelByIndex',
  get:
    (index: string | number) =>
    ({ get }) =>
      get(conversationByIndex(index))?.model ?? null,
});

const conversationSpecByIndex = selectorFamily<string | null, string | number>({
  key: 'conversationSpecByIndex',
  get:
    (index: string | number) =>
    ({ get }) =>
      get(conversationByIndex(index))?.spec ?? null,
});

const conversationAgentIdByIndex = selectorFamily<string | null, string | number>({
  key: 'conversationAgentIdByIndex',
  get:
    (index: string | number) =>
    ({ get }) =>
      get(conversationByIndex(index))?.agent_id ?? null,
});

const conversationAssistantIdByIndex = selectorFamily<string | null, string | number>({
  key: 'conversationAssistantIdByIndex',
  get:
    (index: string | number) =>
    ({ get }) =>
      get(conversationByIndex(index))?.assistant_id ?? null,
});

const presetByIndex = atomFamily<TPreset | null, string | number>({
  key: 'presetByIndex',
  default: null,
});

const textByIndex = atomFamily<string, string | number>({
  key: 'textByIndex',
  default: '',
});

const showStopButtonByIndex = atomFamily<boolean, string | number>({
  key: 'showStopButtonByIndex',
  default: false,
});

const abortScrollFamily = atomFamily<boolean, string | number>({
  key: 'abortScrollByIndex',
  default: false,
  effects: [
    ({ onSet, node }) => {
      onSet(async (newValue) => {
        const key = Number(node.key.split(Constants.COMMON_DIVIDER)[1]);
        logger.log('message_scrolling', 'Recoil Effect: Setting abortScrollByIndex', {
          key,
          newValue,
        });
      });
    },
  ] as const,
});

const isSubmittingFamily = atomFamily({
  key: 'isSubmittingByIndex',
  default: false,
  effects: [
    ({ onSet, node }) => {
      onSet(async (newValue) => {
        const key = Number(node.key.split(Constants.COMMON_DIVIDER)[1]);
        logger.log('message_stream', 'Recoil Effect: Setting isSubmittingByIndex', {
          key,
          newValue,
        });
      });
    },
  ],
});

const anySubmittingSelector = selector<boolean>({
  key: 'anySubmittingSelector',
  get: ({ get }) => {
    const keys = get(conversationKeysAtom);
    return keys.some((key) => get(isSubmittingFamily(key)) === true);
  },
});

const optionSettingsFamily = atomFamily<TOptionSettings, string | number>({
  key: 'optionSettingsByIndex',
  default: {},
});

const showPopoverFamily = atomFamily({
  key: 'showPopoverByIndex',
  default: false,
});

const activePromptByIndex = atomFamily<string | undefined, string | number | null>({
  key: 'activePromptByIndex',
  default: undefined,
});

const showMentionPopoverFamily = atomFamily<boolean, string | number | null>({
  key: 'showMentionPopoverByIndex',
  default: false,
});

const showPlusPopoverFamily = atomFamily<boolean, string | number | null>({
  key: 'showPlusPopoverByIndex',
  default: false,
});

const showPromptsPopoverFamily = atomFamily<boolean, string | number | null>({
  key: 'showPromptsPopoverByIndex',
  default: false,
});

const showSkillsPopoverFamily = atomFamily<boolean, string | number | null>({
  key: 'showSkillsPopoverByIndex',
  default: false,
});

/**
 * Per-conversation queue of skill names the user invoked manually via the
 * `$` popover for the next submission. Structured channel that the submit
 * pipeline (`useChatFunctions.ask`) drains and pins onto the user message's
 * `manualSkills` field (also echoed at the top of the payload for the
 * runtime resolver), then resets to `[]`. Compose-time chips above the
 * textarea read this atom directly so users see (and can dismiss) their
 * current selection before hitting send.
 */
const pendingManualSkillsByConvoId = atomFamily<string[], string>({
  key: 'pendingManualSkillsByConvoId',
  default: [],
});

/**
 * Per-conversation queue of verbatim excerpts the user quoted via the
 * "Add to chat" selection popup for the next submission. The submit pipeline
 * (`useChatFunctions.ask`) drains this onto the user message's `quotes` field
 * (which the backend merges into the model-facing text and persists for the
 * `MessageQuotes` UI), then resets to `[]`. Compose-time chips above the
 * textarea read this atom directly so users can see and dismiss each quote
 * before sending.
 */
const pendingQuotesByConvoId = atomFamily<string[], string>({
  key: 'pendingQuotesByConvoId',
  default: [],
});

/**
 * A steer message submitted mid-run. Server truth: `sending` covers the POST
 * in flight, `pending` means the server queued it (awaiting a tool-batch
 * boundary), `failed` keeps the text recoverable after a rejected POST. The
 * chip disappears when `on_steer_applied` lands (the inline content part
 * becomes the durable record).
 */
export type PendingSteer = {
  steerId: string;
  text: string;
  status: 'sending' | 'pending' | 'failed';
  createdAt: number;
  /** Attachments steered with the message (refs; already uploaded). */
  files?: TMessage['files'];
  /** Quote chips carried by a queued-origin steer (client-only; never sent to
   *  the server), restored onto the queued item if the run ends first. */
  quotes?: string[];
  /** Manual skill picks carried the same way as `quotes`. */
  manualSkills?: string[];
};

/**
 * Per-conversation steers awaiting injection. Reconciled against the server:
 * `on_steer_applied` removes its chip; `sync`/`resumeState.pendingSteers`
 * replaces the list on reconnect; run-end reports convert leftovers into
 * `queuedMessagesByConvoId` entries.
 */
const pendingSteersByConvoId = atomFamily<PendingSteer[], string>({
  key: 'pendingSteersByConvoId',
  default: [],
});

/** One audio/video file the composer's transcribe flow has committed to
 *  uploading, before `POST /api/transcribe` has resolved - the navigate into
 *  `?panel=transcript&file=<pendingId>` happens the instant the options
 *  dialog is confirmed (not once the upload finishes), so nothing exists
 *  server-side yet for `TranscriptPanel` to poll. `pendingId` (not a real
 *  file id) is what the URL carries in the meantime; `TranscriptPanel` swaps
 *  it for the real `sourceFile.file_id` once the upload succeeds, and the
 *  ordinary `queued`/`transcribing` polling takes over from there.
 *
 *  `status: 'failed'` here means the UPLOAD itself failed (network error,
 *  validation, ffmpeg extraction) - before any `sourceFileId` exists, so the
 *  ordinary `POST /:sourceFileId/retry` endpoint doesn't apply. `file` is
 *  kept alive specifically so a "retry upload" action can re-run the exact
 *  same attempt without asking the user to re-pick it.
 *
 *  Plain in-memory Recoil, deliberately not persisted: a reload while an
 *  upload is still in flight loses this record (and with it, the retry
 *  affordance) - accepted as a narrow gap, since this window is normally
 *  just the upload + ffmpeg extraction (seconds), not the transcription job
 *  itself. */
export type PendingTranscriptionUpload = {
  pendingId: string;
  conversationId: string;
  filename: string;
  file: File;
  options: TTranscribeOptions;
  /** A plain id once resolved, or still the promise `maybeInterceptAudioVideo`
   *  chained this attach's parent onto - see its own comment on
   *  `transcribeLeafChainRef` for why a second recording queued before the
   *  first's message id is known can't just read a plain string here. A
   *  retry (`attemptTranscribeUpload` awaits either) reuses whichever this
   *  already resolved to, rather than recomputing against whatever the
   *  conversation's latest message happens to be by the time of the retry. */
  parentMessageId: string | Promise<string>;
  isNewConversation: boolean;
  /** When this attach started - `PendingTranscriptionMessages` shows it next
   *  to the header name, matching the timestamp every real message header
   *  carries (`MessageTimestamp`), so the row's height/layout doesn't shift
   *  once the real message replaces it. */
  createdAt: string;
  /** Carried so a retry (`usePendingUploadRetry`) resends the same value the
   *  original attempt did - retry re-runs `attemptTranscribeUpload` from
   *  scratch, with no other way to know what the composer's temporary-chat
   *  setting was at attach time. */
  isTemporary?: boolean;
  status: 'uploading' | 'failed';
  errorMessage?: string;
};

const pendingTranscriptionUploadsByConvoId = atomFamily<PendingTranscriptionUpload[], string>({
  key: 'pendingTranscriptionUploadsByConvoId',
  default: [],
});

/** A message composed during a run, queued to send after it finishes.
 *  Attachments ride the queued item (already uploaded at attach time) and are
 *  passed to `ask` as `overrideFiles` on drain — steering itself is text-only,
 *  so any during-run submit with media routes here as one unit. */
export type QueuedMessage = {
  id: string;
  text: string;
  createdAt: number;
  files?: TMessage['files'];
  /** Quote chips consumed from the composer at enqueue time; passed to `ask`
   *  as `overrideQuotes` on drain so they pair with THIS message. */
  quotes?: string[];
  /** Manual skill picks consumed from the composer at enqueue time; passed
   *  to `ask` as `overrideManualSkills` on drain. */
  manualSkills?: string[];
  /** Front-inserted by "Interrupt & send": stays ahead of chronologically
   *  older items when leftover steers are merged back into the queue. */
  priority?: boolean;
};

/**
 * Per-conversation client-side queue of follow-up messages. Drained one per
 * run completion by `useQueueDrain` (each dequeued message starts a normal
 * turn whose own final event drains the next).
 */
const queuedMessagesByConvoId = atomFamily<QueuedMessage[], string>({
  key: 'queuedMessagesByConvoId',
  default: [],
});

/**
 * Run-end signals whose conversation was NOT active when they arrived —
 * parked here (keyed by conversation) so a later run finishing on the same
 * chat index cannot overwrite them; `useQueueDrain` consumes the parked
 * signal when the user returns to that conversation.
 */
const pendingRunEndByConvoId = atomFamily<RunEnd | null, string>({
  key: 'pendingRunEndByConvoId',
  default: null,
});

/**
 * One-shot run-termination signal written by the SSE final/error handlers and
 * consumed (reset to null) by `useQueueDrain`. Keyed by chat index like
 * `isSubmittingFamily`. Carrying the outcome lets the drain skip auto-send on
 * user aborts/errors while `startedAsNewConvo` migrates a queue keyed under
 * `Constants.NEW_CONVO` to the real conversation id.
 */
export type RunEnd = {
  conversationId: string | null;
  outcome: 'completed' | 'aborted' | 'error';
  startedAsNewConvo?: boolean;
  endedAt: number;
  /** Armed "Interrupt & send" flag traveling with a PARKED signal, so
   *  another run on the same pane can neither consume nor clear it. */
  interruptArmed?: boolean;
};

const runEndByIndex = atomFamily<RunEnd | null, string | number>({
  key: 'runEndByIndex',
  default: null,
});

/**
 * One-shot override armed by "interrupt & send": the next `aborted` run-end
 * drains the queue exactly once (a plain Stop press leaves queued chips for
 * manual send).
 */
const drainAfterAbortByIndex = atomFamily<boolean, string | number>({
  key: 'drainAfterAbortByIndex',
  default: false,
});

/**
 * Server steer ids whose `on_steer_applied` event already landed. The 202 ACK
 * and the SSE ride different connections, so the applied event can arrive
 * FIRST — the ACK handler checks this set and drops its local chip instead of
 * minting a `pending` chip whose only removal event has already passed. A late
 * ACK can land after the run's final event, so the set is capped
 * (`appendAppliedSteerIds`), never cleared.
 */
const appliedSteerIdsByConvoId = atomFamily<string[], string>({
  key: 'appliedSteerIdsByConvoId',
  default: [],
});

const globalAudioURLFamily = atomFamily<string | null, string | number | null>({
  key: 'globalAudioURLByIndex',
  default: null,
});

const globalAudioFetchingFamily = atomFamily<boolean, string | number | null>({
  key: 'globalAudioisFetchingByIndex',
  default: false,
});

const globalAudioPlayingFamily = atomFamily<boolean, string | number | null>({
  key: 'globalAudioisPlayingByIndex',
  default: false,
});

const activeRunFamily = atomFamily<string | null, string | number | null>({
  key: 'activeRunByIndex',
  default: null,
});

const audioRunFamily = atomFamily<string | null, string | number | null>({
  key: 'audioRunByIndex',
  default: null,
});

const messagesSiblingIdxFamily = atomFamily<number, string | null | undefined>({
  key: 'messagesSiblingIdx',
  default: 0,
});

/** Setter-only access to the conversation atom: registers the key like
 * `useCreateConversationAtom` but never subscribes to the value, so callers
 * that only write (navigation, per-row actions) don't re-render on every
 * conversation update. */
function useSetConversationAtom(key: string | number) {
  const hasSetConversation = useSetConvoContext();
  const setKeys = useSetRecoilState(conversationKeysAtom);
  const setConversation = useSetRecoilState(conversationByIndex(key));

  useEffect(() => {
    setKeys((prevKeys) => {
      if (prevKeys.includes(key)) {
        return prevKeys;
      }
      return [...prevKeys, key];
    });
  }, [key, setKeys]);

  return { hasSetConversation, setConversation };
}

function useCreateConversationAtom(key: string | number) {
  const { hasSetConversation, setConversation } = useSetConversationAtom(key);
  const conversation = useRecoilValue(conversationByIndex(key));

  return { hasSetConversation, conversation, setConversation };
}

function useClearConvoState() {
  /** Clears all active conversations. Pass `true` to skip the first or root conversation */
  const clearAllConversations = useRecoilCallback(
    ({ reset, snapshot }) =>
      async (skipFirst?: boolean) => {
        const conversationKeys = await snapshot.getPromise(conversationKeysAtom);

        for (const conversationKey of conversationKeys) {
          if (skipFirst === true && conversationKey == 0) {
            continue;
          }

          // Unlike every other per-conversation atom this loop implicitly
          // covers via `conversationByIndex`, `pendingTranscriptionUploadsByConvoId`
          // is keyed by conversation id, not pane index - reset it for
          // whichever conversation this pane actually held, read from the
          // snapshot before that pane's own atom is reset below.
          const paneConversation = await snapshot.getPromise(conversationByIndex(conversationKey));
          if (paneConversation?.conversationId) {
            reset(pendingTranscriptionUploadsByConvoId(paneConversation.conversationId));
          }

          reset(conversationByIndex(conversationKey));
        }

        reset(conversationKeysAtom);
      },
    [],
  );

  return clearAllConversations;
}

const conversationByKeySelector = conversationByIndex;

function useClearSubmissionState() {
  const clearAllSubmissions = useRecoilCallback(
    ({ reset, set, snapshot }) =>
      async (skipFirst?: boolean) => {
        const submissionKeys = await snapshot.getPromise(submissionKeysSelector);
        logger.log('submissionKeys', submissionKeys);

        for (const key of submissionKeys) {
          if (skipFirst === true && key == 0) {
            continue;
          }

          logger.log('resetting submission', key);
          reset(submissionByIndex(key));
        }

        set(submissionKeysSelector, []);
      },
    [],
  );

  return clearAllSubmissions;
}

const updateConversationSelector = selectorFamily({
  key: 'updateConversationSelector',
  get: () => () => null as Partial<TConversation> | null,
  set:
    (conversationId: string) =>
    ({ set, get }, newPartialConversation) => {
      if (newPartialConversation instanceof DefaultValue) {
        return;
      }

      const keys = get(conversationKeysAtom);
      keys.forEach((key) => {
        set(conversationByIndex(key), (prevConversation) => {
          if (prevConversation && prevConversation.conversationId === conversationId) {
            return {
              ...prevConversation,
              ...newPartialConversation,
            };
          }
          return prevConversation;
        });
      });
    },
});

export default {
  conversationKeysAtom,
  conversationByIndex,
  filesByIndex,
  presetByIndex,
  submissionByIndex,
  textByIndex,
  showStopButtonByIndex,
  abortScrollFamily,
  isSubmittingFamily,
  optionSettingsFamily,
  showPopoverFamily,
  messagesSiblingIdxFamily,
  anySubmittingSelector,
  allConversationsSelector,
  conversationIdByIndex,
  conversationEndpointByIndex,
  effectiveEndpointByIndex,
  conversationModelByIndex,
  conversationSpecByIndex,
  conversationAgentIdByIndex,
  conversationAssistantIdByIndex,
  conversationByKeySelector,
  useClearConvoState,
  useCreateConversationAtom,
  useSetConversationAtom,
  showMentionPopoverFamily,
  globalAudioURLFamily,
  activeRunFamily,
  audioRunFamily,
  globalAudioPlayingFamily,
  globalAudioFetchingFamily,
  showPlusPopoverFamily,
  activePromptByIndex,
  useClearSubmissionState,
  showPromptsPopoverFamily,
  showSkillsPopoverFamily,
  pendingManualSkillsByConvoId,
  pendingQuotesByConvoId,
  pendingSteersByConvoId,
  pendingTranscriptionUploadsByConvoId,
  queuedMessagesByConvoId,
  runEndByIndex,
  pendingRunEndByConvoId,
  drainAfterAbortByIndex,
  appliedSteerIdsByConvoId,
  updateConversationSelector,
};
