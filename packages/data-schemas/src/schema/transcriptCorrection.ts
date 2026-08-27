import mongoose, { Schema, Document, Types } from 'mongoose';

/**
 * One append-only correction event against an Audio Transcriber transcript.
 * Never updated or deleted individually - the *current* state of a speaker's
 * name, or of which speaker a line belongs to, is derived by replaying every
 * event for that `transcriptFileId` in `createdAt` order and taking the last
 * write for each key. The original WhisperX/RAG-server output is never
 * touched, so it stays recoverable underneath any correction.
 */
export interface ITranscriptCorrection extends Document {
  transcriptFileId: string;
  conversationId: string;
  user: Types.ObjectId;
  type: 'speaker_rename' | 'segment_reassign' | 'text_edit' | 'line_insert';
  /** speaker_rename: the pipeline/custom speaker id being renamed. */
  speakerId?: string;
  /** speaker_rename: display name before this event, for audit context only -
   *  the canonical current name is still whichever rename event is latest. */
  fromName?: string;
  /** speaker_rename: the new display name. */
  toName?: string;
  /** segment_reassign / text_edit: index into the flat parsed-line array this
   *  event applies to. line_insert: a synthetic index strictly between its
   *  two neighbors at insert time (e.g. 4.5 between lines 4 and 5) - never
   *  reassigned afterward, so it stays a stable identity for later
   *  corrections against this same inserted line, and sorts correctly
   *  alongside the original integer indices without renumbering them. */
  lineIndex?: number;
  /** segment_reassign: speaker id the line was attributed to before this event. */
  fromSpeakerId?: string;
  /** segment_reassign: speaker id the line is reassigned to - may be an
   *  existing pipeline/custom id, or a freshly-created custom id for a
   *  speaker the pipeline missed entirely. */
  toSpeakerId?: string;
  /** text_edit: this line's text before this event, for audit context only. */
  fromText?: string;
  /** text_edit: this line's text after this event. */
  toText?: string;
  /** line_insert: the new line's speaker id (existing or freshly-created) -
   *  absent means unassigned, same as a pipeline segment with no speaker. */
  speaker?: string;
  /** line_insert: the new line's dialogue text. */
  text?: string;
  /** line_insert: the new line's start time, in seconds - computed client-side
   *  from its position within the gap between its two neighbors. */
  seconds?: number;
  /** line_insert: the new line's end time, in seconds. */
  endSeconds?: number;
  tenantId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const transcriptCorrectionSchema: Schema<ITranscriptCorrection> = new Schema(
  {
    transcriptFileId: {
      type: String,
      required: true,
    },
    conversationId: {
      type: String,
      required: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    type: {
      type: String,
      enum: ['speaker_rename', 'segment_reassign', 'text_edit', 'line_insert'],
      required: true,
    },
    speakerId: {
      type: String,
    },
    fromName: {
      type: String,
    },
    toName: {
      type: String,
    },
    lineIndex: {
      type: Number,
    },
    fromSpeakerId: {
      type: String,
    },
    toSpeakerId: {
      type: String,
    },
    fromText: {
      type: String,
    },
    toText: {
      type: String,
    },
    speaker: {
      type: String,
    },
    text: {
      type: String,
    },
    seconds: {
      type: Number,
    },
    endSeconds: {
      type: Number,
    },
    tenantId: {
      type: String,
      index: true,
    },
  },
  { timestamps: true },
);

transcriptCorrectionSchema.index({ transcriptFileId: 1, createdAt: 1 });
transcriptCorrectionSchema.index({ conversationId: 1, user: 1, tenantId: 1 });

export default transcriptCorrectionSchema;
