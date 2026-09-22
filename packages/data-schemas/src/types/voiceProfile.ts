import type { Types, Document } from 'mongoose';

/** Where and how the enrolled voice sample's audio bytes are stored - the
 *  same shape a storage strategy's `saveBuffer` call already produces for any
 *  other upload (see `FileSources` in `librechat-data-provider`), just kept
 *  directly on this document instead of a separate `File` record: a voice
 *  profile has no need for the generic `File` collection's ACL/retention/RAG
 *  machinery, only "where's the clip and how do I play it back." */
export interface IVoiceProfileAudio {
  filepath: string;
  source: string;
  type: string;
  bytes: number;
  filename: string;
}

export interface IVoiceProfile extends Document {
  user: Types.ObjectId;
  fullName: string;
  role: string;
  audio: IVoiceProfileAudio;
  /** 192-dim ECAPA-TDNN speaker embedding from the Speaker Recognition
   *  service's `/embed` call, made once at enrollment time and stored here -
   *  that service holds no database of its own, so this document is the only
   *  place the vector persists. Powers `/recognize`: sent back as one of this
   *  user's candidates on every match attempt. */
  embedding: number[];
  tenantId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IVoiceProfileLean {
  _id: Types.ObjectId;
  fullName: string;
  role: string;
  audio: IVoiceProfileAudio;
  createdAt?: Date;
}

/** Internal shape used only for recognition matching - carries the embedding
 *  the public lean projection deliberately omits (a biometric vector has no
 *  reason to round-trip to the client on an ordinary list fetch). */
export interface IVoiceProfileWithEmbedding extends IVoiceProfileLean {
  embedding: number[];
}

export interface CreateVoiceProfileParams {
  userId: string | Types.ObjectId;
  fullName: string;
  role: string;
  audio: IVoiceProfileAudio;
  embedding: number[];
  tenantId?: string;
}
