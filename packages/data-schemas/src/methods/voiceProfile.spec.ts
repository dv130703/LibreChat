import mongoose from 'mongoose';
import { logger, createModels } from '..';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createVoiceProfileMethods } from './voiceProfile';

logger.silent = true;

let VoiceProfile: mongoose.Model<unknown>;
let methods: ReturnType<typeof createVoiceProfileMethods>;
let mongoServer: MongoMemoryServer;

const userA = new mongoose.Types.ObjectId().toString();
const userB = new mongoose.Types.ObjectId().toString();

const sampleAudio = {
  filepath: '/images/user-a/sample.webm',
  source: 'local',
  type: 'audio/webm',
  bytes: 1024,
  filename: 'sample.webm',
};

const sampleEmbedding = Array.from({ length: 192 }, (_, i) => i / 192);

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  VoiceProfile = mongoose.models.VoiceProfile;
  await VoiceProfile.syncIndexes();
  methods = createVoiceProfileMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await VoiceProfile.deleteMany({});
});

describe('createVoiceProfile / getVoiceProfiles', () => {
  test('persists a voice profile and returns it in the lean projection', async () => {
    const created = await methods.createVoiceProfile({
      userId: userA,
      fullName: 'Jane Doe',
      role: 'Product Manager',
      audio: sampleAudio,
      embedding: sampleEmbedding,
    });
    expect(created.fullName).toBe('Jane Doe');
    expect(created.role).toBe('Product Manager');
    expect(created.audio).toMatchObject(sampleAudio);

    const profiles = await methods.getVoiceProfiles(userA);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({ fullName: 'Jane Doe', role: 'Product Manager' });
    // The lean list projection deliberately omits the embedding.
    expect((profiles[0] as unknown as { embedding?: unknown }).embedding).toBeUndefined();
  });

  test('newest first', async () => {
    await methods.createVoiceProfile({
      userId: userA,
      fullName: 'First',
      role: 'Role A',
      audio: sampleAudio,
      embedding: sampleEmbedding,
    });
    await methods.createVoiceProfile({
      userId: userA,
      fullName: 'Second',
      role: 'Role B',
      audio: sampleAudio,
      embedding: sampleEmbedding,
    });

    const profiles = await methods.getVoiceProfiles(userA);
    expect(profiles.map((profile) => profile.fullName)).toEqual(['Second', 'First']);
  });

  test('scopes results to the requesting user', async () => {
    await methods.createVoiceProfile({
      userId: userA,
      fullName: 'Owned by A',
      role: 'Role A',
      audio: sampleAudio,
      embedding: sampleEmbedding,
    });
    await methods.createVoiceProfile({
      userId: userB,
      fullName: 'Owned by B',
      role: 'Role B',
      audio: sampleAudio,
      embedding: sampleEmbedding,
    });

    const profilesForA = await methods.getVoiceProfiles(userA);
    expect(profilesForA).toHaveLength(1);
    expect(profilesForA[0].fullName).toBe('Owned by A');
  });

  test('rejects a profile missing required audio fields', async () => {
    await expect(
      methods.createVoiceProfile({
        userId: userA,
        fullName: 'Missing Audio',
        role: 'Role A',
        audio: { ...sampleAudio, filepath: undefined as unknown as string },
        embedding: sampleEmbedding,
      }),
    ).rejects.toThrow();
  });

  test('rejects a profile missing its embedding', async () => {
    await expect(
      methods.createVoiceProfile({
        userId: userA,
        fullName: 'No Embedding',
        role: 'Role A',
        audio: sampleAudio,
        embedding: undefined as unknown as number[],
      }),
    ).rejects.toThrow();
  });
});

describe('getVoiceProfilesWithEmbeddings', () => {
  test('returns candidates carrying their stored embedding, scoped to the user', async () => {
    await methods.createVoiceProfile({
      userId: userA,
      fullName: 'Jane Doe',
      role: 'Product Manager',
      audio: sampleAudio,
      embedding: sampleEmbedding,
    });
    await methods.createVoiceProfile({
      userId: userB,
      fullName: 'Other User',
      role: 'Engineer',
      audio: sampleAudio,
      embedding: sampleEmbedding,
    });

    const candidates = await methods.getVoiceProfilesWithEmbeddings(userA);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].fullName).toBe('Jane Doe');
    expect(candidates[0].embedding).toEqual(sampleEmbedding);
  });
});
