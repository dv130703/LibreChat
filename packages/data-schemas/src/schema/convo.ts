import { Schema } from 'mongoose';
import { conversationPreset } from './defaults';
import { IConversation } from '~/types';

const convoSchema: Schema<IConversation> = new Schema(
  {
    conversationId: {
      type: String,
      required: true,
      index: true,
      meiliIndex: true,
    },
    title: {
      type: String,
      default: 'New Chat',
      meiliIndex: true,
    },
    user: {
      type: String,
      index: true,
      meiliIndex: true,
    },
    messages: [{ type: Schema.Types.ObjectId, ref: 'Message' }],
    isTemporary: {
      type: Boolean,
      default: false,
    },
    ...conversationPreset,
    agent_id: {
      type: String,
    },
    tags: {
      type: [String],
      default: [],
      meiliIndex: true,
    },
    chatProjectId: {
      type: String,
      default: null,
      index: true,
    },
    files: {
      type: [String],
    },
    expiredAt: {
      type: Date,
    },
    tenantId: {
      type: String,
      index: true,
    },
    pinned: {
      type: Boolean,
    },
    /** How this conversation's transcript was produced, for the Audio
     *  Transcriber. `model` is what the ASR server actually loaded (never the
     *  caller's possibly-absent request), and the rest is the option set the
     *  transcript came from - kept so a re-transcribe starts from what was
     *  used rather than from the dialog's defaults. */
    transcription: {
      model: { type: String },
      requestedModel: { type: String },
      language: { type: String },
      diarize: { type: Boolean },
      minSpeakers: { type: Number },
      maxSpeakers: { type: Number },
      clusteringThreshold: { type: Number },
      includeTimestamps: { type: Boolean },
      contextTerms: { type: String },
      context: { type: String },
      suppressNumerals: { type: Boolean },
    },
  },
  { timestamps: true },
);

convoSchema.index({ expiredAt: 1 }, { expireAfterSeconds: 0 });
convoSchema.index({ createdAt: 1, updatedAt: 1 });
convoSchema.index({ conversationId: 1, user: 1, tenantId: 1 }, { unique: true });
convoSchema.index({ user: 1, chatProjectId: 1, updatedAt: -1, _id: -1 });
convoSchema.index({ user: 1, chatProjectId: 1, createdAt: -1, _id: -1 });

convoSchema.index({ user: 1, isTemporary: 1, expiredAt: 1 });
// index for MeiliSearch sync operations
convoSchema.index({ _meiliIndex: 1, isTemporary: 1, expiredAt: 1 });

export default convoSchema;
