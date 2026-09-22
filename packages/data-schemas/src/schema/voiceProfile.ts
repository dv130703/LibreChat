import { Schema } from 'mongoose';
import type { IVoiceProfile } from '~/types/voiceProfile';

const voiceProfileSchema: Schema<IVoiceProfile> = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    fullName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 256,
    },
    role: {
      type: String,
      required: true,
      trim: true,
      maxlength: 256,
    },
    audio: {
      filepath: { type: String, required: true },
      source: { type: String, required: true },
      type: { type: String, required: true },
      bytes: { type: Number, required: true },
      filename: { type: String, required: true },
    },
    embedding: {
      type: [Number],
      // Mongoose's `required` is a no-op on arrays (an absent value casts to
      // `[]`, which satisfies it) - the length check is what actually
      // guarantees every stored profile has a real, matchable vector.
      validate: {
        validator: (value: number[]) => Array.isArray(value) && value.length > 0,
        message: 'embedding must be a non-empty array',
      },
    },
    tenantId: {
      type: String,
      index: true,
    },
  },
  { timestamps: true },
);

voiceProfileSchema.index({ user: 1, createdAt: -1 });

export default voiceProfileSchema;
