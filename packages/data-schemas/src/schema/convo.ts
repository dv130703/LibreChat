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
    /** @deprecated Superseded by `transcription` on the source audio File
     *  doc (`IFileTranscriptionJob.effectiveOptions`) - see
     *  `transcription/ARCHITECTURE.md` D3/D4/§4.3. A conversation may now
     *  hold more than one recording, which this single sub-document can't
     *  represent. Still written and read as a fallback for one release;
     *  removed in Phase 6. */
    transcription: {
      model: { type: String },
      requestedModel: { type: String },
      language: { type: String },
      diarize: { type: Boolean },
      speakerCount: { type: Number },
      clusteringThreshold: { type: Number },
      includeTimestamps: { type: Boolean },
      contextTerms: { type: String },
      voiceRecognition: { type: Boolean },
      suppressNumerals: { type: Boolean },
      channelSplit: { type: Boolean },
      diarizationBackend: { type: String },
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
