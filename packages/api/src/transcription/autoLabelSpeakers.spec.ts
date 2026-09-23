import { autoLabelSpeakers, selectLongestTurnPerSpeaker } from './autoLabelSpeakers';

describe('selectLongestTurnPerSpeaker', () => {
  it('keeps only the longest turn for each speaker label', () => {
    const turns = [
      { speaker: 'SPEAKER_00', start: 0, end: 2 },
      { speaker: 'SPEAKER_01', start: 2, end: 3 },
      { speaker: 'SPEAKER_00', start: 10, end: 15 },
      { speaker: 'SPEAKER_01', start: 20, end: 20.5 },
    ];

    const longest = selectLongestTurnPerSpeaker(turns);

    expect(longest.get('SPEAKER_00')).toEqual({ speaker: 'SPEAKER_00', start: 10, end: 15 });
    expect(longest.get('SPEAKER_01')).toEqual({ speaker: 'SPEAKER_01', start: 2, end: 3 });
    expect(longest.size).toBe(2);
  });

  it('returns an empty map when there are no turns', () => {
    expect(selectLongestTurnPerSpeaker([]).size).toBe(0);
  });
});

describe('autoLabelSpeakers', () => {
  function makeDeps() {
    return {
      extractClip: jest.fn().mockResolvedValue(undefined),
      identifySpeaker: jest.fn().mockResolvedValue({ recognized: false, bestMatch: null }),
      createCorrection: jest.fn().mockResolvedValue(undefined),
      removeClip: jest.fn().mockResolvedValue(undefined),
      makeClipPath: jest.fn((speakerLabel: string) => `/tmp/${speakerLabel}.wav`),
      onError: jest.fn(),
    };
  }

  it('does nothing when there are no diarization turns', async () => {
    const deps = makeDeps();

    await autoLabelSpeakers({
      audioFilePath: '/tmp/source.wav',
      diarizationTurns: [],
      transcriptFileId: 'transcript-1',
      conversationId: 'convo-1',
      userId: 'user-1',
      ...deps,
    });

    expect(deps.extractClip).not.toHaveBeenCalled();
    expect(deps.createCorrection).not.toHaveBeenCalled();
  });

  it('writes a speaker_rename correction for a recognized speaker using their longest turn', async () => {
    const deps = makeDeps();
    deps.identifySpeaker.mockResolvedValue({
      recognized: true,
      bestMatch: { fullName: 'Ada Lovelace' },
    });

    await autoLabelSpeakers({
      audioFilePath: '/tmp/source.wav',
      diarizationTurns: [
        { speaker: 'SPEAKER_00', start: 0, end: 1 },
        { speaker: 'SPEAKER_00', start: 5, end: 9 },
      ],
      transcriptFileId: 'transcript-1',
      conversationId: 'convo-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      ...deps,
    });

    expect(deps.extractClip).toHaveBeenCalledWith('/tmp/source.wav', '/tmp/SPEAKER_00.wav', 5, 9);
    expect(deps.identifySpeaker).toHaveBeenCalledWith('/tmp/SPEAKER_00.wav');
    expect(deps.createCorrection).toHaveBeenCalledWith({
      transcriptFileId: 'transcript-1',
      conversationId: 'convo-1',
      user: 'user-1',
      type: 'speaker_rename',
      speakerId: 'SPEAKER_00',
      fromName: 'SPEAKER_00',
      toName: 'Ada Lovelace',
      tenantId: 'tenant-1',
    });
    expect(deps.removeClip).toHaveBeenCalledWith('/tmp/SPEAKER_00.wav');
  });

  it('does not write a correction when the speaker is not recognized', async () => {
    const deps = makeDeps();

    await autoLabelSpeakers({
      audioFilePath: '/tmp/source.wav',
      diarizationTurns: [{ speaker: 'SPEAKER_00', start: 0, end: 3 }],
      transcriptFileId: 'transcript-1',
      conversationId: 'convo-1',
      userId: 'user-1',
      ...deps,
    });

    expect(deps.createCorrection).not.toHaveBeenCalled();
    expect(deps.removeClip).toHaveBeenCalledWith('/tmp/SPEAKER_00.wav');
  });

  it('reports a per-speaker failure without throwing and without blocking other speakers', async () => {
    const deps = makeDeps();
    deps.extractClip.mockImplementation(async (_input: string, output: string) => {
      if (output === '/tmp/SPEAKER_00.wav') {
        throw new Error('ffmpeg exploded');
      }
    });
    deps.identifySpeaker.mockResolvedValue({
      recognized: true,
      bestMatch: { fullName: 'Grace Hopper' },
    });

    await autoLabelSpeakers({
      audioFilePath: '/tmp/source.wav',
      diarizationTurns: [
        { speaker: 'SPEAKER_00', start: 0, end: 3 },
        { speaker: 'SPEAKER_01', start: 3, end: 6 },
      ],
      transcriptFileId: 'transcript-1',
      conversationId: 'convo-1',
      userId: 'user-1',
      ...deps,
    });

    expect(deps.onError).toHaveBeenCalledWith('SPEAKER_00', expect.any(Error));
    expect(deps.createCorrection).toHaveBeenCalledWith(
      expect.objectContaining({ speakerId: 'SPEAKER_01', toName: 'Grace Hopper' }),
    );
  });
});
