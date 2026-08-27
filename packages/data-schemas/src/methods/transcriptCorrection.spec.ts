import mongoose from 'mongoose';
import { logger, createModels } from '..';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createTranscriptCorrectionMethods } from './transcriptCorrection';

logger.silent = true;

let TranscriptCorrection: mongoose.Model<unknown>;
let methods: ReturnType<typeof createTranscriptCorrectionMethods>;
let mongoServer: MongoMemoryServer;

const userId = new mongoose.Types.ObjectId().toString();
const transcriptFileId = 'file-abc-transcript';
const conversationId = 'convo-1';

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  TranscriptCorrection = mongoose.models.TranscriptCorrection;
  await TranscriptCorrection.syncIndexes();
  methods = createTranscriptCorrectionMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await TranscriptCorrection.deleteMany({});
});

describe('createTranscriptCorrection / getTranscriptCorrections', () => {
  test('renaming a speaker twice - a later correction wins, but both stay in the log', async () => {
    await methods.createTranscriptCorrection({
      transcriptFileId,
      conversationId,
      user: userId as unknown as mongoose.Types.ObjectId,
      type: 'speaker_rename',
      speakerId: 'Speaker 1',
      toName: 'General Smith',
    });
    await methods.createTranscriptCorrection({
      transcriptFileId,
      conversationId,
      user: userId as unknown as mongoose.Types.ObjectId,
      type: 'speaker_rename',
      speakerId: 'Speaker 1',
      fromName: 'General Smith',
      toName: 'Colonel Smith',
    });

    const corrections = await methods.getTranscriptCorrections(transcriptFileId);
    expect(corrections).toHaveLength(2);
    expect(corrections[0].toName).toBe('General Smith');
    expect(corrections[1].toName).toBe('Colonel Smith');
    // Both events are still present - nothing was overwritten or deleted.
    expect(corrections.every((c) => c.speakerId === 'Speaker 1')).toBe(true);
  });

  test('returns events in chronological order for replay-as-last-write-wins', async () => {
    await methods.createTranscriptCorrection({
      transcriptFileId,
      conversationId,
      user: userId as unknown as mongoose.Types.ObjectId,
      type: 'segment_reassign',
      lineIndex: 5,
      fromSpeakerId: 'Speaker 1',
      toSpeakerId: 'Speaker 2',
    });

    const corrections = await methods.getTranscriptCorrections(transcriptFileId);
    expect(corrections).toHaveLength(1);
    expect(corrections[0]).toMatchObject({
      type: 'segment_reassign',
      lineIndex: 5,
      fromSpeakerId: 'Speaker 1',
      toSpeakerId: 'Speaker 2',
    });
  });

  test('records a text edit alongside speaker corrections without disturbing them', async () => {
    await methods.createTranscriptCorrection({
      transcriptFileId,
      conversationId,
      user: userId as unknown as mongoose.Types.ObjectId,
      type: 'text_edit',
      lineIndex: 3,
      fromText: 'The wesult was inconclusive.',
      toText: 'The result was inconclusive.',
    });

    const corrections = await methods.getTranscriptCorrections(transcriptFileId);
    expect(corrections).toHaveLength(1);
    expect(corrections[0]).toMatchObject({
      type: 'text_edit',
      lineIndex: 3,
      fromText: 'The wesult was inconclusive.',
      toText: 'The result was inconclusive.',
    });
  });

  test('scoped by transcriptFileId - a correction on one transcript never appears for another', async () => {
    await methods.createTranscriptCorrection({
      transcriptFileId,
      conversationId,
      user: userId as unknown as mongoose.Types.ObjectId,
      type: 'speaker_rename',
      speakerId: 'Speaker 1',
      toName: 'General Smith',
    });

    const otherTranscript = await methods.getTranscriptCorrections('some-other-file');
    expect(otherTranscript).toHaveLength(0);
  });
});

describe('deleteTranscriptCorrections', () => {
  test('deletes corrections for the given conversations only', async () => {
    await methods.createTranscriptCorrection({
      transcriptFileId,
      conversationId,
      user: userId as unknown as mongoose.Types.ObjectId,
      type: 'speaker_rename',
      speakerId: 'Speaker 1',
      toName: 'General Smith',
    });
    await methods.createTranscriptCorrection({
      transcriptFileId: 'other-file-transcript',
      conversationId: 'other-convo',
      user: userId as unknown as mongoose.Types.ObjectId,
      type: 'speaker_rename',
      speakerId: 'Speaker 1',
      toName: 'Someone Else',
    });

    const result = await methods.deleteTranscriptCorrections([conversationId]);
    expect(result.deletedCount).toBe(1);
    expect(await methods.getTranscriptCorrections(transcriptFileId)).toHaveLength(0);
    expect(await methods.getTranscriptCorrections('other-file-transcript')).toHaveLength(1);
  });

  test('is a no-op given an empty or all-nullish list', async () => {
    await methods.createTranscriptCorrection({
      transcriptFileId,
      conversationId,
      user: userId as unknown as mongoose.Types.ObjectId,
      type: 'speaker_rename',
      speakerId: 'Speaker 1',
      toName: 'General Smith',
    });

    const result = await methods.deleteTranscriptCorrections([null, undefined]);
    expect(result.deletedCount).toBe(0);
    expect(await methods.getTranscriptCorrections(transcriptFileId)).toHaveLength(1);
  });
});
