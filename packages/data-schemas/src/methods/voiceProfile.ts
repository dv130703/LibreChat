import type * as t from '~/types';

export function createVoiceProfileMethods(mongoose: typeof import('mongoose')): {
  createVoiceProfile: (params: t.CreateVoiceProfileParams) => Promise<t.IVoiceProfileLean>;
  getVoiceProfiles: (userId: string) => Promise<t.IVoiceProfileLean[]>;
  getVoiceProfilesWithEmbeddings: (userId: string) => Promise<t.IVoiceProfileWithEmbedding[]>;
} {
  async function createVoiceProfile({
    userId,
    fullName,
    role,
    audio,
    embedding,
    tenantId,
  }: t.CreateVoiceProfileParams): Promise<t.IVoiceProfileLean> {
    const VoiceProfile = mongoose.models.VoiceProfile;
    const created = await VoiceProfile.create({
      user: userId,
      fullName,
      role,
      audio,
      embedding,
      tenantId,
    });
    return created.toObject();
  }

  async function getVoiceProfiles(userId: string): Promise<t.IVoiceProfileLean[]> {
    const VoiceProfile = mongoose.models.VoiceProfile;
    return VoiceProfile.find({ user: userId })
      .select('fullName role audio createdAt')
      .sort({ createdAt: -1 })
      .lean<t.IVoiceProfileLean[]>();
  }

  /** Candidates for a `/recognize` match attempt - the one read path that
   *  needs the stored embedding back out, since the Speaker Recognition
   *  service holds none of its own and expects it resent on every call. */
  async function getVoiceProfilesWithEmbeddings(
    userId: string,
  ): Promise<t.IVoiceProfileWithEmbedding[]> {
    const VoiceProfile = mongoose.models.VoiceProfile;
    return VoiceProfile.find({ user: userId })
      .select('fullName role audio embedding createdAt')
      .lean<t.IVoiceProfileWithEmbedding[]>();
  }

  return {
    createVoiceProfile,
    getVoiceProfiles,
    getVoiceProfilesWithEmbeddings,
  };
}

export type VoiceProfileMethods = ReturnType<typeof createVoiceProfileMethods>;
