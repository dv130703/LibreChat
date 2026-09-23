import type {
  PresentPerson,
  SpeakerAssignment,
  SpeakerIdentificationRequest,
  SpeakerIdentificationResult,
} from './identifySpeakers';

/**
 * The model transport for content-based speaker identification: prompt, tool
 * schema, and a plain OpenAI-compatible chat-completions call.
 *
 * Deliberately a bare `fetch` rather than a provider SDK. The request is one
 * non-streaming completion with one tool, which every OpenAI-compatible
 * server speaks - including a local Ollama, which is the sensible default
 * here because interview audio is sensitive and a local model keeps the
 * transcript on the machine that recorded it.
 *
 * The tool is the whole safety mechanism. `speakerId` is an enum built from
 * the speakers that still need naming, so the model cannot rename anyone
 * already identified, and the required evidence citation is what makes a
 * claimed identification checkable by `acceptAssignments`.
 */

export interface AssignSpeakerTool {
  type: 'function';
  function: {
    name: 'assign_speaker';
    description: string;
    parameters: {
      type: 'object';
      properties: {
        speakerId: { type: 'string'; enum: string[]; description: string };
        name: { type: 'string'; description: string };
        evidenceLineIndex: { type: 'integer'; description: string };
        evidenceQuote: { type: 'string'; description: string };
        confidence: { type: 'number'; minimum: number; maximum: number; description: string };
      };
      required: string[];
      additionalProperties: false;
    };
  };
}

export interface SpeakerModelMessage {
  role: 'system' | 'user';
  content: string;
}

export interface SpeakerModelToolCall {
  function?: { name?: string; arguments?: string };
}

export interface SpeakerModelResponse {
  choices?: Array<{ message?: { content?: string; tool_calls?: SpeakerModelToolCall[] } }>;
}

export interface SpeakerModelConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const TOOL_NAME = 'assign_speaker';
const PRESENT_TOOL_NAME = 'note_present_person';
const DEFAULT_TIMEOUT_MS = 120_000;

export function buildAssignSpeakerTool(unidentified: string[]): AssignSpeakerTool {
  return {
    type: 'function',
    function: {
      name: TOOL_NAME,
      description:
        'Record that a specific unidentified speaker label belongs to a named person. ' +
        'Call once per speaker you can identify from the transcript. ' +
        'Do not call it for a speaker whose identity the transcript does not establish.',
      parameters: {
        type: 'object',
        properties: {
          speakerId: {
            type: 'string',
            enum: unidentified,
            description: 'The unidentified speaker label being named.',
          },
          name: {
            type: 'string',
            description:
              'The full name of the person. Use the spelling from the known-people list ' +
              'when the transcript is referring to one of them, since the transcript ' +
              'itself misspells names.',
          },
          evidenceLineIndex: {
            type: 'integer',
            description: 'Index of the transcript line that establishes this identity.',
          },
          evidenceQuote: {
            type: 'string',
            description: 'Text copied verbatim from that line. It must appear in the line exactly.',
          },
          confidence: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            description: 'How certain the evidence makes this identification.',
          },
        },
        required: ['speakerId', 'name', 'evidenceLineIndex', 'evidenceQuote', 'confidence'],
        additionalProperties: false,
      },
    },
  };
}

export interface NotePresentPersonTool {
  type: 'function';
  function: {
    name: 'note_present_person';
    description: string;
    parameters: {
      type: 'object';
      properties: {
        name: { type: 'string'; description: string };
        evidenceLineIndex: { type: 'integer'; description: string };
        evidenceQuote: { type: 'string'; description: string };
      };
      required: string[];
      additionalProperties: false;
    };
  };
}

/** Records someone the transcript states is in the room. Separate from
 *  `assign_speaker` on purpose: knowing a person is present is a much weaker
 *  claim than knowing which voice is theirs, and only the arithmetic in
 *  `resolveByElimination` is allowed to turn the former into the latter. */
export function buildNotePresentPersonTool(): NotePresentPersonTool {
  return {
    type: 'function',
    function: {
      name: PRESENT_TOOL_NAME,
      description:
        'Record a person the transcript states is present, when you cannot tell which ' +
        'speaker is theirs. Call once per named attendee, including ones you have ' +
        'already identified with assign_speaker.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The full name of the person present.' },
          evidenceLineIndex: {
            type: 'integer',
            description: 'Index of the line stating this person is present.',
          },
          evidenceQuote: {
            type: 'string',
            description: 'Text copied verbatim from that line. It must appear in it exactly.',
          },
        },
        required: ['name', 'evidenceLineIndex', 'evidenceQuote'],
        additionalProperties: false,
      },
    },
  };
}

const SYSTEM_PROMPT = [
  'You identify who the speakers are in an interview transcript.',
  '',
  'Only two kinds of evidence establish a speaker identity:',
  '1. Self-introduction - the speaker states their own name ("my name is...",',
  '   "this is ... speaking", answering a request to state their name).',
  '2. Attribution by another speaker that the named person then answers - one',
  '   speaker addresses someone by name and the NEXT speaker responds as that',
  '   person. The reply is what completes the evidence; being addressed by name',
  '   in a line spoken by someone else does not identify the speaker of that line.',
  '',
  'Names are routinely misspelled in the transcript because they were produced by',
  'speech recognition, which mangles proper nouns ("Danbury" may appear as "Donbry"',
  'or "Danbry"). Treat a name that sounds like one in the known-people list as that',
  'person, and record the correct spelling from the list.',
  '',
  'Separately, use note_present_person for every person the transcript states is',
  'in the room - including ones you have already identified. An interview usually',
  'opens by putting the attendees on the record. Recording them does NOT claim to',
  'know which voice is theirs; it only says they are present, and a later step may',
  'close out a single remaining speaker from that list.',
  '',
  'Do not guess. Identifying nobody is a perfectly good answer, and most speakers',
  'in a real interview are never named. If the transcript does not establish who a',
  'speaker is, leave them alone and do not call the tool for them. Never infer an',
  "identity from someone's role, topic, or manner of speaking - only from a name",
  'that is actually spoken. Every call must quote the exact line that proves it.',
].join('\n');

export function buildIdentificationMessages(
  request: SpeakerIdentificationRequest,
): [SpeakerModelMessage, SpeakerModelMessage] {
  const roster =
    request.candidates.length > 0
      ? request.candidates
          .map((candidate) =>
            candidate.role
              ? `- ${candidate.fullName} (${candidate.role})`
              : `- ${candidate.fullName}`,
          )
          .join('\n')
      : '- (nobody on file; rely only on names spoken in the transcript)';

  const evidence = request.evidence
    .map((line) =>
      line.speaker
        ? `[${line.lineIndex}] ${line.speaker}: ${line.text}`
        : `[${line.lineIndex}] ${line.text}`,
    )
    .join('\n');

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        'Known people who may appear in this recording:',
        roster,
        '',
        'Speakers still needing identification:',
        request.unidentified.map((speaker) => `- ${speaker}`).join('\n'),
        '',
        'Relevant transcript excerpts, each prefixed by its line index:',
        evidence,
        '',
        'Identify only the speakers the excerpts actually establish. A person not on',
        'the known-people list is fine to name if the transcript introduces them.',
      ].join('\n'),
    },
  ];
}

/** The arguments of every call to one named tool in a completion, with
 *  malformed entries skipped rather than thrown - a background pass should
 *  degrade to "found nothing" instead of failing a transcription. */
export function parseToolCalls<T>(response: SpeakerModelResponse, toolName: string): T[] {
  const toolCalls = response?.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(toolCalls)) {
    return [];
  }
  const parsed: T[] = [];
  for (const toolCall of toolCalls) {
    if (toolCall?.function?.name !== toolName || typeof toolCall.function.arguments !== 'string') {
      continue;
    }
    try {
      parsed.push(JSON.parse(toolCall.function.arguments) as T);
    } catch {
      continue;
    }
  }
  return parsed;
}

/** One non-streaming, tool-enabled completion against an OpenAI-compatible
 *  endpoint. Shared by every transcription pass that asks a model something. */
export async function postChatCompletion(
  config: SpeakerModelConfig,
  { messages, tools }: { messages: SpeakerModelMessage[]; tools: unknown[] },
): Promise<SpeakerModelResponse> {
  const endpoint = `${config.baseURL.replace(/\/+$/, '')}/chat/completions`;
  const doFetch = config.fetchImpl ?? fetch;
  const response = await doFetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      tools,
      tool_choice: 'auto',
      temperature: 0,
    }),
    signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Speaker identification model returned ${response.status}: ${detail}`);
  }
  return (await response.json()) as SpeakerModelResponse;
}

interface RawAssignment {
  speakerId?: string;
  name?: string;
  evidenceLineIndex?: number | string;
  evidenceQuote?: string;
  confidence?: number | string;
}

function toAssignment(raw: RawAssignment): SpeakerAssignment | null {
  const evidenceLineIndex = Number(raw.evidenceLineIndex);
  const confidence = Number(raw.confidence);
  if (
    typeof raw.speakerId !== 'string' ||
    typeof raw.name !== 'string' ||
    raw.speakerId.length === 0 ||
    raw.name.length === 0 ||
    !Number.isFinite(evidenceLineIndex)
  ) {
    return null;
  }
  return {
    speakerId: raw.speakerId,
    name: raw.name,
    evidenceLineIndex,
    evidenceQuote: typeof raw.evidenceQuote === 'string' ? raw.evidenceQuote : '',
    confidence: Number.isFinite(confidence) ? confidence : 0,
  };
}

/**
 * Pulls assignments out of a completion. A response carrying no tool call is
 * the model abstaining, which is normal and yields an empty list rather than
 * an error - as does a malformed one, since a background job should degrade
 * to "identified nobody" instead of failing a transcription.
 */
export function parseAssignments(response: SpeakerModelResponse): SpeakerAssignment[] {
  const assignments: SpeakerAssignment[] = [];
  for (const raw of parseToolCalls<RawAssignment>(response, TOOL_NAME)) {
    const assignment = toAssignment(raw);
    if (assignment != null) {
      assignments.push(assignment);
    }
  }
  return assignments;
}

interface RawPresentPerson {
  name?: string;
  evidenceLineIndex?: number | string;
  evidenceQuote?: string;
}

/** The attendees the model recorded as present, for `resolveByElimination`. */
export function parsePresentPeople(response: SpeakerModelResponse): PresentPerson[] {
  const present: PresentPerson[] = [];
  for (const raw of parseToolCalls<RawPresentPerson>(response, PRESENT_TOOL_NAME)) {
    const evidenceLineIndex = Number(raw.evidenceLineIndex);
    if (
      typeof raw.name !== 'string' ||
      raw.name.length === 0 ||
      !Number.isFinite(evidenceLineIndex)
    ) {
      continue;
    }
    present.push({
      name: raw.name,
      evidenceLineIndex,
      evidenceQuote: typeof raw.evidenceQuote === 'string' ? raw.evidenceQuote : '',
    });
  }
  return present;
}

/** An `askModel` implementation for `identifySpeakersFromContent`. */
export function createSpeakerModel(
  config: SpeakerModelConfig,
): (request: SpeakerIdentificationRequest) => Promise<SpeakerIdentificationResult> {
  return async (request) => {
    const body = await postChatCompletion(config, {
      messages: buildIdentificationMessages(request),
      tools: [buildAssignSpeakerTool(request.unidentified), buildNotePresentPersonTool()],
    });
    return { assignments: parseAssignments(body), present: parsePresentPeople(body) };
  };
}
