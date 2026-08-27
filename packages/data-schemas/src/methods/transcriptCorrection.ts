import type { Model } from 'mongoose';
import type { ITranscriptCorrection } from '~/schema/transcriptCorrection';

export type CreateTranscriptCorrectionInput = Pick<
  ITranscriptCorrection,
  | 'transcriptFileId'
  | 'conversationId'
  | 'user'
  | 'type'
  | 'speakerId'
  | 'fromName'
  | 'toName'
  | 'lineIndex'
  | 'fromSpeakerId'
  | 'toSpeakerId'
  | 'fromText'
  | 'toText'
  | 'speaker'
  | 'text'
  | 'seconds'
  | 'endSeconds'
  | 'tenantId'
>;

export function createTranscriptCorrectionMethods(mongoose: typeof import('mongoose')): {
  createTranscriptCorrection: (
    data: CreateTranscriptCorrectionInput,
  ) => Promise<ITranscriptCorrection>;
  getTranscriptCorrections: (transcriptFileId: string) => Promise<ITranscriptCorrection[]>;
  deleteTranscriptCorrections: (
    conversationIds: Array<string | null | undefined>,
  ) => Promise<import('mongodb').DeleteResult>;
} {
  /** Appends one correction event. Never updates or deletes an existing one -
   *  the append-only log is the audit trail itself. */
  async function createTranscriptCorrection(
    data: CreateTranscriptCorrectionInput,
  ): Promise<ITranscriptCorrection> {
    try {
      const TranscriptCorrection = mongoose.models
        .TranscriptCorrection as Model<ITranscriptCorrection>;
      return await TranscriptCorrection.create(data);
    } catch (error) {
      throw new Error(`Error creating transcript correction: ${(error as Error).message}`);
    }
  }

  /** Every correction event for a transcript, chronological (oldest first) so
   *  callers can replay them and take the last write per key as current state. */
  async function getTranscriptCorrections(
    transcriptFileId: string,
  ): Promise<ITranscriptCorrection[]> {
    try {
      const TranscriptCorrection = mongoose.models
        .TranscriptCorrection as Model<ITranscriptCorrection>;
      return await TranscriptCorrection.find({ transcriptFileId })
        .sort({ createdAt: 1 })
        .lean<ITranscriptCorrection[]>();
    } catch (error) {
      throw new Error(`Error fetching transcript corrections: ${(error as Error).message}`);
    }
  }

  /** Best-effort cleanup when one or more conversations (and their transcript
   *  files) are deleted, so corrections don't outlive what they're correcting. */
  async function deleteTranscriptCorrections(
    conversationIds: Array<string | null | undefined>,
  ): Promise<import('mongodb').DeleteResult> {
    const ids = conversationIds.filter((id): id is string => Boolean(id));
    if (ids.length === 0) {
      return { acknowledged: true, deletedCount: 0 };
    }
    try {
      const TranscriptCorrection = mongoose.models
        .TranscriptCorrection as Model<ITranscriptCorrection>;
      return await TranscriptCorrection.deleteMany({ conversationId: { $in: ids } });
    } catch (error) {
      throw new Error(`Error deleting transcript corrections: ${(error as Error).message}`);
    }
  }

  return {
    createTranscriptCorrection,
    getTranscriptCorrections,
    deleteTranscriptCorrections,
  };
}

export type TranscriptCorrectionMethods = ReturnType<typeof createTranscriptCorrectionMethods>;
