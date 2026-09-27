import { buildTranslationMessages } from './translate';
import { buildAttributionMessages, buildAttributionTool } from './attributionModel';
import {
  buildAssignSpeakerTool,
  buildIdentificationMessages,
  buildNotePresentPersonTool,
} from './speakerModel';
import type {
  ParsedTranscriptLine,
  TTranscriptionPromptTool,
  TTranscriptionPromptsResponse,
} from 'librechat-data-provider';
import type { AttributionCandidate } from './attribution';
import type { SpeakerModelConfig } from './speakerModel';

/**
 * Everything a model is asked during a transcription, in the words it is
 * actually asked in.
 *
 * Three stages of a job send a transcript to an LLM, and none of them are
 * visible from the UI - a reviewer sees the corrected transcript and has no
 * way of knowing what was put to a model to produce it. On investigation
 * material that is not acceptable: the reviewer has to be able to read the
 * instructions themselves and judge whether the result can be trusted.
 *
 * Nothing here is a copy of a prompt. Every string below is produced by
 * calling the very builder the live stage calls, against a small worked
 * example, so a disclosure that drifts from what is really sent is not
 * possible - changing a prompt changes this automatically, and the spec
 * pins that.
 */

/** The stand-in transcript every example is rendered from. Deliberately
 *  banal and obviously synthetic, so nothing in the disclosure can be
 *  mistaken for a line out of the reviewer's own recording. */
const EXAMPLE_TRANSCRIPT: ParsedTranscriptLine[] = [
  {
    lineIndex: 0,
    timestamp: '00:00:00',
    speaker: 'Speaker 1',
    text: 'For the record, please state your full name.',
  },
  {
    lineIndex: 1,
    timestamp: '00:00:04',
    speaker: 'Speaker 2',
    text: 'Rowan Danbury, finance director.',
  },
  {
    lineIndex: 2,
    timestamp: '00:00:08',
    speaker: 'Speaker 1',
    text: 'And you were present on the fourteenth? Yes, I was.',
  },
];

const EXAMPLE_SPEAKERS = ['Speaker 1', 'Speaker 2'];

const EXAMPLE_CANDIDATE: AttributionCandidate = {
  lineIndex: 2,
  reason: 'trailing_interjection',
  context: EXAMPLE_TRANSCRIPT,
};

function describeTool(tool: {
  function: { name: string; description: string; parameters: object };
}): TTranscriptionPromptTool {
  return {
    name: tool.function.name,
    description: tool.function.description,
    parameters: JSON.stringify(tool.function.parameters, null, 2),
  };
}

export function describeTranscriptionPrompts(
  config?: SpeakerModelConfig,
): TTranscriptionPromptsResponse {
  if (!config) {
    return { enabled: false, stages: [] };
  }

  const [identifySystem, identifyUser] = buildIdentificationMessages({
    evidence: EXAMPLE_TRANSCRIPT.map((line) => ({
      lineIndex: line.lineIndex,
      speaker: line.speaker,
      text: line.text,
    })),
    unidentified: ['Speaker 2'],
    candidates: [{ profileId: 'example', fullName: 'Rowan Danbury', role: 'Finance director' }],
  });
  const [attributionSystem, attributionUser] = buildAttributionMessages(
    [EXAMPLE_CANDIDATE],
    EXAMPLE_SPEAKERS,
  );
  const [translateSystem, translateUser] = buildTranslationMessages(EXAMPLE_TRANSCRIPT);

  return {
    enabled: true,
    model: config.model,
    endpoint: config.baseURL,
    stages: [
      {
        stage: 'identifying_speakers',
        systemPrompt: identifySystem.content,
        exampleUserMessage: identifyUser.content,
        tools: [
          describeTool(buildAssignSpeakerTool(['Speaker 2'])),
          describeTool(buildNotePresentPersonTool()),
        ],
      },
      {
        stage: 'reviewing_attribution',
        systemPrompt: attributionSystem.content,
        exampleUserMessage: attributionUser.content,
        tools: [describeTool(buildAttributionTool(EXAMPLE_SPEAKERS))],
      },
      {
        stage: 'translating',
        systemPrompt: translateSystem.content,
        exampleUserMessage: translateUser.content,
        tools: [],
      },
    ],
  };
}
