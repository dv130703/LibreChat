import { ChevronRight, Bot } from 'lucide-react';
import { Spinner } from '@librechat/client';
import type { TTranscriptionPromptStage, TranscriptionPromptStage } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks/useLocalize';
import { useTranscribePromptsQuery } from '~/data-provider';
import { useLocalize } from '~/hooks';

/**
 * What every LLM stage of transcription is told, in the words it is really
 * told, read straight off the server that will run them.
 *
 * A reviewer otherwise sees only the corrected transcript, with no way to
 * know what was asked of a model to produce it - which on investigation
 * material is not something to take on trust. The prompts come from
 * `GET /api/transcribe/prompts`, which renders them by calling the same
 * builders the live stages call, so nothing here can quietly drift from what
 * is actually sent.
 *
 * Collapsed by default and fetched only once opened: it is several KB of
 * prompt text, and it is a thing you go and check rather than something to
 * put between a reviewer and the transcribe button. Built on `<details>`
 * rather than open/closed state of its own - the browser already does this.
 */

const STAGE_TITLE_KEYS = {
  identifying_speakers: 'com_ui_transcript_stage_identifying_speakers',
  reviewing_attribution: 'com_ui_transcript_stage_reviewing_attribution',
  translating: 'com_ui_transcribe_prompts_stage_translating',
} as const satisfies Record<TranscriptionPromptStage, TranslationKeys>;

const STAGE_WHEN_KEYS = {
  identifying_speakers: 'com_ui_transcribe_prompts_when_identifying_speakers',
  reviewing_attribution: 'com_ui_transcribe_prompts_when_reviewing_attribution',
  translating: 'com_ui_transcribe_prompts_when_translating',
} as const satisfies Record<TranscriptionPromptStage, TranslationKeys>;

function PromptBlock({ label, text }: { label: string; text: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
        {label}
      </p>
      <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border-light bg-surface-primary p-2.5 font-mono text-[11px] leading-relaxed text-text-secondary">
        {text}
      </pre>
    </div>
  );
}

function StageDisclosure({ stage }: { stage: TTranscriptionPromptStage }) {
  const localize = useLocalize();

  return (
    <div className="flex min-w-0 flex-col gap-2.5 rounded-lg border border-border-light p-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h4 className="text-sm font-medium text-text-primary">
          {localize(STAGE_TITLE_KEYS[stage.stage])}
        </h4>
        <p className="text-xs text-text-secondary">{localize(STAGE_WHEN_KEYS[stage.stage])}</p>
      </div>
      <PromptBlock label={localize('com_ui_transcribe_prompts_system')} text={stage.systemPrompt} />
      <PromptBlock
        label={localize('com_ui_transcribe_prompts_example')}
        text={stage.exampleUserMessage}
      />
      {stage.tools.length > 0 && (
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
            {localize('com_ui_transcribe_prompts_tools')}
          </p>
          {stage.tools.map((tool) => (
            <details key={tool.name} className="group min-w-0">
              <summary className="flex cursor-pointer list-none items-start gap-1.5 text-xs text-text-secondary">
                <ChevronRight
                  className="mt-0.5 h-3 w-3 shrink-0 transition-transform group-open:rotate-90"
                  aria-hidden="true"
                />
                <span className="min-w-0">
                  <span className="font-mono text-text-primary">{tool.name}</span>
                  {' — '}
                  {tool.description}
                </span>
              </summary>
              <pre className="mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border-light bg-surface-primary p-2.5 font-mono text-[11px] leading-relaxed text-text-secondary">
                {tool.parameters}
              </pre>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

export default function PromptDisclosure() {
  const localize = useLocalize();
  // `enabled: false` until the reviewer opens it - `<details>`'s own toggle
  // event is what turns the query on, so an unopened disclosure costs a
  // dialog nothing.
  const { data, isLoading, isError, refetch, isFetched } = useTranscribePromptsQuery({
    enabled: false,
  });

  return (
    <details
      className="group min-w-0"
      onToggle={(event) => {
        if ((event.currentTarget as HTMLDetailsElement).open && !isFetched) {
          refetch();
        }
      }}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 text-sm text-text-secondary transition-colors hover:text-text-primary">
        <Bot className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">{localize('com_ui_transcribe_prompts_show')}</span>
        <ChevronRight
          className="h-4 w-4 shrink-0 transition-transform group-open:rotate-90"
          aria-hidden="true"
        />
      </summary>

      <div className="mt-3 flex min-w-0 flex-col gap-3">
        {isLoading && (
          <div className="flex justify-center py-4">
            <Spinner className="h-4 w-4 text-text-secondary" />
          </div>
        )}
        {isError && (
          <p role="alert" className="text-xs text-red-500">
            {localize('com_ui_transcribe_prompts_error')}
          </p>
        )}
        {data != null && !data.enabled && (
          <p className="text-xs text-text-secondary">
            {localize('com_ui_transcribe_prompts_disabled')}
          </p>
        )}
        {data?.enabled === true && (
          <>
            <p className="text-xs text-text-secondary">
              {localize('com_ui_transcribe_prompts_destination', {
                0: data.model ?? '',
                1: data.endpoint ?? '',
              })}
            </p>
            {data.stages.map((stage) => (
              <StageDisclosure key={stage.stage} stage={stage} />
            ))}
          </>
        )}
      </div>
    </details>
  );
}
