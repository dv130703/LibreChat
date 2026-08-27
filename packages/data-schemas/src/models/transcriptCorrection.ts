import { Model } from 'mongoose';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';
import transcriptCorrectionSchema, { ITranscriptCorrection } from '~/schema/transcriptCorrection';

export function createTranscriptCorrectionModel(
  mongoose: typeof import('mongoose'),
): Model<ITranscriptCorrection> {
  applyTenantIsolation(transcriptCorrectionSchema);
  return (
    mongoose.models.TranscriptCorrection ||
    mongoose.model<ITranscriptCorrection>('TranscriptCorrection', transcriptCorrectionSchema)
  );
}
