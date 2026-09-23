import { buildNameKeywords, findNameMentions } from './speakerNames';
import type { ParsedTranscriptLine } from 'librechat-data-provider';
import type { SpeakerRenameCorrectionInput } from './autoLabelSpeakers';
import type { NameCandidate, NameKeyword } from './speakerNames';

/**
 * Content-based speaker identification: works out who an unnamed diarized
 * speaker is from what the transcript actually says, and fills the label in.
 *
 * Runs after voice-embedding auto-labeling, and only ever on what that pass
 * left behind - a speaker with a real name is never touched. The two things
 * a transcript can reveal are a self-introduction ("my name is...") and an
 * attribution by someone else that the speaker then answers ("Rowan, can you
 * confirm?" / "Yes, I can"), so retrieval targets both.
 *
 * Every accepted result is written as the same `speaker_rename` correction
 * the roster UI writes. That is the whole reason this stage cannot affect
 * anything but speaker labels: it has no other write available to it, and
 * the result stays editable and undoable through the existing UI with no
 * changes there.
 *
 * Abstention is a correct outcome, not a failure. Most unidentified speakers
 * in a real interview are genuinely never named, and a guessed name on an
 * investigation transcript is far worse than a blank one.
 */

/** One speaker the model believes it has identified, with the evidence it
 *  claims supports that - the citation is what makes the claim checkable. */
export interface SpeakerAssignment {
  speakerId: string;
  name: string;
  evidenceLineIndex: number;
  evidenceQuote: string;
  confidence: number;
}

/** Someone the transcript states is in the room, whether or not they can be
 *  tied to a voice. The raw material for closing a roster by elimination. */
export interface PresentPerson {
  name: string;
  evidenceLineIndex: number;
  evidenceQuote: string;
}

export type RejectionReason =
  | 'invalid_name'
  | 'speaker_not_unidentified'
  | 'low_confidence'
  | 'evidence_not_found'
  | 'duplicate_name'
  | 'conflicting_speaker';

export interface RejectedAssignment {
  assignment: SpeakerAssignment;
  reason: RejectionReason;
}

export interface EvidenceLine {
  lineIndex: number;
  speaker?: string;
  text: string;
}

/** Everything the model needs to decide, and nothing else - notably not the
 *  whole transcript, which on a long interview is tens of thousands of
 *  tokens of mostly irrelevant testimony. */
export interface SpeakerIdentificationRequest {
  evidence: EvidenceLine[];
  unidentified: string[];
  candidates: NameCandidate[];
}

export interface EvidenceOptions {
  /** Opening lines always included: an interview puts names on the record
   *  at the start, and does it in whatever mangled form ASR produced. */
  leading?: number;
  /** Turns kept after a hit, to carry the answer that confirms it. */
  after?: number;
  maxLines?: number;
}

/** What the model reports back: who it could place, and who the transcript
 *  says is in the room but it could not tie to a voice. */
export interface SpeakerIdentificationResult {
  assignments: SpeakerAssignment[];
  present?: PresentPerson[];
}

export interface IdentifySpeakersParams {
  lines: ParsedTranscriptLine[];
  candidates: NameCandidate[];
  transcriptFileId: string;
  conversationId: string;
  userId: string;
  tenantId?: string;
  askModel: (request: SpeakerIdentificationRequest) => Promise<SpeakerIdentificationResult>;
  createCorrection: (correction: SpeakerRenameCorrectionInput) => Promise<unknown>;
  minConfidence?: number;
  evidence?: EvidenceOptions;
  onError?: (error: unknown) => void;
  onRejected?: (rejected: RejectedAssignment[]) => void;
}

/** The labels the pipeline emits for a speaker it has not named. Mirrors the
 *  shape `TRANSCRIPT_LINE_PATTERN` parses - anything else is a real name. */
const PIPELINE_LABEL = /^(?:Speaker \d+|Unknown)$/;

/** Phrases that introduce or request a name, independent of whether the name
 *  itself survived transcription well enough to match the roster - the whole
 *  point is to catch names no keyword can. */
const INTRODUCTION_CUES = [
  /\bmy name(?:'s| is)\b/i,
  /\bnames?\s+is\b/i,
  /\bfull name\b/i,
  /\bstate your\b/i,
  /\bfor the record\b/i,
  /\bintroduce (?:yourself|himself|herself|themselves)\b/i,
  /\bcall me\b/i,
  /\bthis is\b/i,
  /\bspeaking\b/i,
  /\b(?:mr|mrs|ms|miss|dr|doctor|detective|inspector|professor)\.?\s+[A-Z]/,
  /\bi(?:'m| am)\s+[A-Z]/,
];

const DEFAULT_EVIDENCE: Required<EvidenceOptions> = { leading: 12, after: 2, maxLines: 400 };
const DEFAULT_MIN_CONFIDENCE = 0.6;

/** Speakers still carrying a pipeline label, in first-appearance order. */
export function findUnidentifiedSpeakers(lines: ParsedTranscriptLine[]): string[] {
  const unidentified = new Set<string>();
  for (const line of lines) {
    if (line.speaker != null && PIPELINE_LABEL.test(line.speaker)) {
      unidentified.add(line.speaker);
    }
  }
  return Array.from(unidentified);
}

function isEvidenceHit(text: string, keywords: NameKeyword[]): boolean {
  if (findNameMentions(text, keywords).length > 0) {
    return true;
  }
  return INTRODUCTION_CUES.some((cue) => cue.test(text));
}

/**
 * The lines worth showing the model: any line that names a roster person or
 * reads like an introduction, plus the turns immediately after it, plus the
 * opening of the recording.
 */
export function selectEvidenceLines(
  lines: ParsedTranscriptLine[],
  keywords: NameKeyword[],
  options: EvidenceOptions = {},
): EvidenceLine[] {
  const { leading, after, maxLines } = { ...DEFAULT_EVIDENCE, ...options };
  const selected = new Set<number>();

  for (let index = 0; index < Math.min(leading, lines.length); index++) {
    selected.add(index);
  }

  for (let index = 0; index < lines.length; index++) {
    if (!isEvidenceHit(lines[index].text, keywords)) {
      continue;
    }
    const last = Math.min(index + after, lines.length - 1);
    for (let windowIndex = index; windowIndex <= last; windowIndex++) {
      selected.add(windowIndex);
    }
  }

  // ponytail: takes the earliest `maxLines` hits, which suits an interview
  // (identities are established early) but would drop later evidence in a
  // recording that names people only near the end. Rank hits by strength
  // before slicing if that case ever shows up.
  return Array.from(selected)
    .sort((a, b) => a - b)
    .slice(0, maxLines)
    .map((index) => ({
      lineIndex: lines[index].lineIndex,
      speaker: lines[index].speaker,
      text: lines[index].text,
    }));
}

function normalizeQuote(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function isRealName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 1 && !PIPELINE_LABEL.test(trimmed);
}

function rejectionFor(
  assignment: SpeakerAssignment,
  linesByIndex: Map<number, ParsedTranscriptLine>,
  unidentified: Set<string>,
  minConfidence: number,
): RejectionReason | null {
  if (!isRealName(assignment.name)) {
    return 'invalid_name';
  }
  if (!unidentified.has(assignment.speakerId)) {
    return 'speaker_not_unidentified';
  }
  if (!(assignment.confidence >= minConfidence)) {
    return 'low_confidence';
  }
  const quote = normalizeQuote(assignment.evidenceQuote ?? '');
  const cited = linesByIndex.get(assignment.evidenceLineIndex);
  if (quote.length === 0 || cited == null || !normalizeQuote(cited.text).includes(quote)) {
    return 'evidence_not_found';
  }
  return null;
}

/**
 * Filters the model's proposals down to the ones that survive checking.
 *
 * The quote check is the cheap hallucination guard: a model that invented
 * its reasoning cannot cite a line that actually says what it claims. The
 * two collision checks catch the other failure mode, where the model has
 * guessed rather than read - one person cannot be two voices in the same
 * recording, and one voice cannot be two people.
 */
export function acceptAssignments(
  assignments: SpeakerAssignment[],
  {
    lines,
    unidentified,
    minConfidence = DEFAULT_MIN_CONFIDENCE,
  }: {
    lines: ParsedTranscriptLine[];
    unidentified: string[];
    minConfidence?: number;
  },
): { accepted: SpeakerAssignment[]; rejected: RejectedAssignment[] } {
  const linesByIndex = new Map(lines.map((line) => [line.lineIndex, line]));
  const unidentifiedSet = new Set(unidentified);

  const rejected: RejectedAssignment[] = [];
  const survivors: SpeakerAssignment[] = [];
  for (const assignment of assignments) {
    const reason = rejectionFor(assignment, linesByIndex, unidentifiedSet, minConfidence);
    if (reason == null) {
      survivors.push(assignment);
      continue;
    }
    rejected.push({ assignment, reason });
  }

  const nameCounts = new Map<string, number>();
  const speakerNames = new Map<string, Set<string>>();
  for (const assignment of survivors) {
    const name = assignment.name.trim().toLowerCase();
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    const names = speakerNames.get(assignment.speakerId) ?? new Set<string>();
    names.add(name);
    speakerNames.set(assignment.speakerId, names);
  }

  const accepted: SpeakerAssignment[] = [];
  for (const assignment of survivors) {
    const name = assignment.name.trim().toLowerCase();
    if ((speakerNames.get(assignment.speakerId)?.size ?? 0) > 1) {
      rejected.push({ assignment, reason: 'conflicting_speaker' });
      continue;
    }
    if ((nameCounts.get(name) ?? 0) > 1) {
      rejected.push({ assignment, reason: 'duplicate_name' });
      continue;
    }
    accepted.push(assignment);
  }

  return { accepted, rejected };
}

/** Confidence recorded for an elimination result. Below a direct, quoted
 *  identification, because it rests on the stated roster being complete. */
const ELIMINATION_CONFIDENCE = 0.75;

/**
 * Closes out the last speaker when the transcript has stated who is present.
 *
 * A formal interview opens by naming everyone in the room. Once every other
 * attendee has been tied to a voice, a single remaining speaker and a single
 * remaining name are the same person - set arithmetic over a roster the
 * transcript itself supplies, not an inference from role or manner.
 *
 * The strictness is the point: exactly one unplaced speaker AND exactly one
 * unplaced attendee. Two of either leaves a choice nothing in the transcript
 * settles, and the failure this guards against is real - an attendee who
 * never speaks, or a voice belonging to someone never named at all.
 */
export function resolveByElimination({
  lines,
  unidentified,
  accepted,
  present,
}: {
  lines: ParsedTranscriptLine[];
  unidentified: string[];
  accepted: SpeakerAssignment[];
  present: PresentPerson[];
}): SpeakerAssignment[] {
  const placedSpeakers = new Set(accepted.map((assignment) => assignment.speakerId));
  const remainingSpeakers = unidentified.filter((speaker) => !placedSpeakers.has(speaker));
  if (remainingSpeakers.length !== 1) {
    return [];
  }

  const linesByIndex = new Map(lines.map((line) => [line.lineIndex, line]));
  const placedNames = new Set(accepted.map((assignment) => normalizeName(assignment.name)));
  const remaining = new Map<string, PresentPerson>();
  for (const person of present) {
    const name = normalizeName(person.name);
    if (!isRealName(person.name) || placedNames.has(name) || remaining.has(name)) {
      continue;
    }
    const quote = normalizeQuote(person.evidenceQuote ?? '');
    const cited = linesByIndex.get(person.evidenceLineIndex);
    if (quote.length === 0 || cited == null || !normalizeQuote(cited.text).includes(quote)) {
      continue;
    }
    remaining.set(name, person);
  }
  if (remaining.size !== 1) {
    return [];
  }

  const person = Array.from(remaining.values())[0];
  return [
    {
      speakerId: remainingSpeakers[0],
      name: person.name.trim(),
      evidenceLineIndex: person.evidenceLineIndex,
      evidenceQuote: person.evidenceQuote,
      confidence: ELIMINATION_CONFIDENCE,
    },
  ];
}

/**
 * Best-effort, like `autoLabelSpeakers`: a transcription job must never fail
 * because identification did. Errors are reported through `onError`, never
 * thrown.
 */
export async function identifySpeakersFromContent(
  params: IdentifySpeakersParams,
): Promise<SpeakerAssignment[]> {
  const unidentified = findUnidentifiedSpeakers(params.lines);
  if (unidentified.length === 0) {
    return [];
  }

  try {
    const keywords = buildNameKeywords(params.candidates);
    const evidence = selectEvidenceLines(params.lines, keywords, params.evidence);
    if (evidence.length === 0) {
      return [];
    }

    const result = await params.askModel({
      evidence,
      unidentified,
      candidates: params.candidates,
    });

    const { accepted, rejected } = acceptAssignments(result?.assignments ?? [], {
      lines: params.lines,
      unidentified,
      minConfidence: params.minConfidence,
    });
    if (rejected.length > 0) {
      params.onRejected?.(rejected);
    }

    const eliminated = resolveByElimination({
      lines: params.lines,
      unidentified,
      accepted,
      present: result?.present ?? [],
    });
    accepted.push(...eliminated);

    for (const assignment of accepted) {
      await params.createCorrection({
        transcriptFileId: params.transcriptFileId,
        conversationId: params.conversationId,
        user: params.userId,
        type: 'speaker_rename',
        speakerId: assignment.speakerId,
        fromName: assignment.speakerId,
        toName: assignment.name.trim(),
        tenantId: params.tenantId,
      });
    }
    return accepted;
  } catch (error) {
    params.onError?.(error);
    return [];
  }
}
