const os = require('os');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createMethods } = require('@librechat/data-schemas');

// `transcribeStream.js` is deliberately mounted with no `requireJwtAuth` -
// this app instance mirrors that exactly (no auth middleware at all), so
// these tests exercise the route's own token verification as the only
// thing standing between a request and a stream of someone's audio.
// `getStrategyFunctions`/local storage is real, not mocked: the whole point
// of this route is the real bytes it streams and the real `Range` handling
// `getLocalFileStream` now supports, which is exactly what a mock would
// paper over.
jest.mock('~/server/middleware/config/app', () => (req, res, next) => next());

describe('transcribeStream.js (direct audio streaming, transcription/ARCHITECTURE.md §12 #13)', () => {
  let app;
  let mongoServer;
  let userId;
  let modelsToCleanup = [];
  let File;
  let fixturePath;
  const fixtureBytes = Buffer.from('0123456789'.repeat(10)); // 100 bytes

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());

    const { createModels } = require('@librechat/data-schemas');
    const models = createModels(mongoose);
    modelsToCleanup = Object.keys(models);
    Object.assign(mongoose.models, models);
    File = mongoose.models.File;

    const methods = createMethods(mongoose);
    await methods.seedDefaultRoles();

    userId = new mongoose.Types.ObjectId().toString();

    fixturePath = path.join(os.tmpdir(), `transcribe-stream-fixture-${Date.now()}.bin`);
    await fs.promises.writeFile(fixturePath, fixtureBytes);

    app = express();
    app.use((req, res, next) => {
      req.config = {
        paths: { uploads: os.tmpdir(), imageOutput: path.join(os.tmpdir(), 'images') },
      };
      next();
    });
    const router = require('../transcribeStream');
    app.use('/api/transcribe', router);
  });

  afterAll(async () => {
    await fs.promises.unlink(fixturePath).catch(() => {});
    for (const modelName of modelsToCleanup) {
      if (mongoose.models[modelName]) {
        delete mongoose.models[modelName];
      }
    }
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  const seedSourceFile = async (overrides = {}) =>
    File.create({
      user: userId,
      file_id: `source-${Date.now()}-${Math.random()}`,
      filename: 'recording.m4a',
      filepath: fixturePath,
      type: 'audio/mp4',
      bytes: fixtureBytes.length,
      source: 'local',
      context: 'transcript_rag',
      ...overrides,
    });

  const mintToken = (id = userId) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '6h' });

  it('streams the full file with a valid token', async () => {
    const sourceFile = await seedSourceFile();

    const response = await request(app)
      .get(`/api/transcribe/${sourceFile.file_id}/audio`)
      .query({ token: mintToken() });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('audio/mp4');
    expect(response.headers['accept-ranges']).toBe('bytes');
    expect(response.headers['content-length']).toBe(String(fixtureBytes.length));
    expect(Buffer.compare(response.body, fixtureBytes)).toBe(0);
  });

  it('returns 401 with no token', async () => {
    const sourceFile = await seedSourceFile();
    const response = await request(app).get(`/api/transcribe/${sourceFile.file_id}/audio`);
    expect(response.status).toBe(401);
  });

  it('returns 401 for a garbage/forged token', async () => {
    const sourceFile = await seedSourceFile();
    const response = await request(app)
      .get(`/api/transcribe/${sourceFile.file_id}/audio`)
      .query({ token: 'not-a-real-token' });
    expect(response.status).toBe(401);
  });

  it("returns 404 when the token's userId doesn't own the file", async () => {
    const sourceFile = await seedSourceFile();
    const otherUserId = new mongoose.Types.ObjectId().toString();

    const response = await request(app)
      .get(`/api/transcribe/${sourceFile.file_id}/audio`)
      .query({ token: mintToken(otherUserId) });

    expect(response.status).toBe(404);
  });

  it('returns 404 for a sourceFileId that does not exist', async () => {
    const response = await request(app)
      .get('/api/transcribe/does-not-exist/audio')
      .query({ token: mintToken() });
    expect(response.status).toBe(404);
  });

  it('serves a satisfiable byte range as 206 with exactly those bytes - what makes seeking not re-download from 0', async () => {
    const sourceFile = await seedSourceFile();

    const response = await request(app)
      .get(`/api/transcribe/${sourceFile.file_id}/audio`)
      .set('Range', 'bytes=10-19')
      .query({ token: mintToken() });

    expect(response.status).toBe(206);
    expect(response.headers['content-range']).toBe(`bytes 10-19/${fixtureBytes.length}`);
    expect(response.headers['content-length']).toBe('10');
    expect(Buffer.compare(response.body, fixtureBytes.subarray(10, 20))).toBe(0);
  });

  it('falls back to a full 200 response for an unsatisfiable range instead of erroring', async () => {
    const sourceFile = await seedSourceFile();

    const response = await request(app)
      .get(`/api/transcribe/${sourceFile.file_id}/audio`)
      .set('Range', `bytes=${fixtureBytes.length}-${fixtureBytes.length + 50}`)
      .query({ token: mintToken() });

    expect(response.status).toBe(200);
    expect(Buffer.compare(response.body, fixtureBytes)).toBe(0);
  });
});
