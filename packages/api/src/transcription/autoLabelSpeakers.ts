import type { RawDiarizationTurn } from './diarizationDetail';

export interface SpeakerMatch {
  recognized: boolean;
  bestMatch: { fullName: string } | null;
}

export interface SpeakerRenameCorrectionInput {
  transcriptFileId: string;
  conversationId: string;
  user: string;
  type: 'speaker_rename';
  speakerId: string;
  fromName: string;
  toName: string;
  tenantId?: string;
}

export interface AutoLabelSpeakersParams {
  audioFilePath: string;
  diarizationTurns: RawDiarizationTurn[];
  transcriptFileId: string;
  conversationId: string;
  userId: string;
  tenantId?: string;
  extractClip: (
    inputPath: string,
    outputPath: string,
    startSeconds: number,
    endSeconds: number,
  ) => Promise<void>;
  identifySpeaker: (clipPath: string) => Promise<SpeakerMatch>;
  createCorrection: (correction: SpeakerRenameCorrectionInput) => Promise<unknown>;
  removeClip: (clipPath: string) => Promise<void>;
  makeClipPath: (speakerLabel: string) => string;
  onError?: (speakerLabel: string, error: unknown) => void;
}

/** Picks the single longest turn for each diarized speaker label - the most
 *  audio signal available for that speaker, and the best candidate clip to
 *  send to the Speaker Recognition service for identification. */
export function selectLongestTurnPerSpeaker(
  turns: RawDiarizationTurn[],
): Map<string, RawDiarizationTurn> {
  const longest = new Map<string, RawDiarizationTurn>();
  for (const turn of turns) {
    const current = longest.get(turn.speaker);
    if (!current || turn.end - turn.start > current.end - current.start) {
      longest.set(turn.speaker, turn);
    }
  }
  return longest;
}

/** Best-effort: matches each detected speaker's longest turn against the
 *  user's enrolled voice profiles and renames recognized ones in place, via
 *  the same `speaker_rename` correction the manual roster UI writes. A
 *  failure on one speaker (bad clip, service down, no match) never blocks
 *  the others - reported through `onError`, not thrown. */
export async function autoLabelSpeakers(params: AutoLabelSpeakersParams): Promise<void> {
  const longestTurns = selectLongestTurnPerSpeaker(params.diarizationTurns);

  await Promise.all(
    Array.from(longestTurns.entries()).map(async ([speakerLabel, turn]) => {
      const clipPath = params.makeClipPath(speakerLabel);
      try {
        await params.extractClip(params.audioFilePath, clipPath, turn.start, turn.end);
        const match = await params.identifySpeaker(clipPath);
        if (match.recognized && match.bestMatch) {
          await params.createCorrection({
            transcriptFileId: params.transcriptFileId,
            conversationId: params.conversationId,
            user: params.userId,
            type: 'speaker_rename',
            speakerId: speakerLabel,
            fromName: speakerLabel,
            toName: match.bestMatch.fullName,
            tenantId: params.tenantId,
          });
        }
      } catch (error) {
        params.onError?.(speakerLabel, error);
      } finally {
        await params.removeClip(clipPath).catch(() => {});
      }
    }),
  );
}
