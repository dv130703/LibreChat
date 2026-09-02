import { stripSegmentDetail, buildDiarizationDetail } from './diarizationDetail';

describe('stripSegmentDetail', () => {
  it('drops words and assignment_method, keeping the plain transcript shape', () => {
    const stripped = stripSegmentDetail([
      {
        id: 'segment-0',
        start: 0,
        end: 1,
        speaker: 'Speaker 1',
        text: 'Hello',
        assignment_method: 'overlap',
        words: [
          { word: 'Hello', start: 0, end: 1, speaker: 'SPEAKER_00', assignment_method: 'overlap' },
        ],
      },
    ]);

    expect(stripped).toEqual([
      { id: 'segment-0', start: 0, end: 1, speaker: 'Speaker 1', text: 'Hello' },
    ]);
  });
});

describe('buildDiarizationDetail', () => {
  it("translates raw pyannote-shaped fields into this app's camelCase record", () => {
    const detail = buildDiarizationDetail({
      segments: [
        {
          id: 'segment-0',
          start: 0,
          end: 1,
          speaker: 'Speaker 1',
          text: 'Hello',
          assignment_method: 'overlap',
          words: [
            {
              word: 'Hello',
              start: 0,
              end: 0.5,
              speaker: 'SPEAKER_00',
              assignment_method: 'overlap',
            },
          ],
        },
      ],
      diarizationTurns: [{ start: 0, end: 1, speaker: 'SPEAKER_00' }],
      speakerEmbeddings: { SPEAKER_00: [0.1, 0.2] },
      diagnostics: { speaker_label_map: { SPEAKER_00: 'Speaker 1' }, model_used: 'large-v3-turbo' },
      recordingProfile: {
        speaker_count: 1,
        turn_count: 1,
        median_turn_duration_s: 1,
        mean_turn_duration_s: 1,
        p95_turn_duration_s: 1,
        longest_turn_s: 1,
        speaker_switches_per_minute: 0,
        speaker_time_distribution_s: { 'Speaker 1': 1 },
        overlap_ratio: 0,
        unassigned_audio_ratio: 0,
        short_turn_ratio: 0,
        diarization_coverage_ratio: 1,
        boundary_conflict_ratio: 0,
        word_segment_disagreement_ratio: 0,
        suspicious_segment_ratio: 0,
        suspicious_segment_ids: [],
        classification: 'monologue',
      },
    });

    expect(detail).toEqual({
      segments: [
        {
          start: 0,
          end: 1,
          speaker: 'Speaker 1',
          text: 'Hello',
          assignmentMethod: 'overlap',
          words: [
            {
              word: 'Hello',
              start: 0,
              end: 0.5,
              speaker: 'SPEAKER_00',
              assignmentMethod: 'overlap',
            },
          ],
        },
      ],
      diarizationTurns: [{ start: 0, end: 1, speaker: 'SPEAKER_00' }],
      speakerEmbeddings: { SPEAKER_00: [0.1, 0.2] },
      speakerLabelMap: { SPEAKER_00: 'Speaker 1' },
      diagnostics: { speaker_label_map: { SPEAKER_00: 'Speaker 1' }, model_used: 'large-v3-turbo' },
      recordingProfile: {
        speakerCount: 1,
        turnCount: 1,
        medianTurnDurationS: 1,
        meanTurnDurationS: 1,
        p95TurnDurationS: 1,
        longestTurnS: 1,
        speakerSwitchesPerMinute: 0,
        speakerTimeDistributionS: { 'Speaker 1': 1 },
        overlapRatio: 0,
        unassignedAudioRatio: 0,
        shortTurnRatio: 0,
        diarizationCoverageRatio: 1,
        boundaryConflictRatio: 0,
        wordSegmentDisagreementRatio: 0,
        suspiciousSegmentRatio: 0,
        suspiciousSegmentIds: [],
        classification: 'monologue',
      },
    });
  });

  it('defaults a missing speaker_label_map to an empty object rather than throwing', () => {
    const detail = buildDiarizationDetail({
      segments: [],
      diarizationTurns: [],
      speakerEmbeddings: null,
      diagnostics: {},
      recordingProfile: null,
    });

    expect(detail.speakerLabelMap).toEqual({});
    expect(detail.speakerEmbeddings).toBeNull();
  });

  it('defaults a word missing timing/speaker to undefined fields and "none"', () => {
    const detail = buildDiarizationDetail({
      segments: [
        {
          id: 'segment-0',
          start: 0,
          end: 1,
          speaker: 'Speaker 1',
          text: 'Hello',
          words: [{ word: 'Hello' }],
        },
      ],
      diarizationTurns: [],
      speakerEmbeddings: null,
      diagnostics: {},
      recordingProfile: null,
    });

    expect(detail.segments[0].words).toEqual([
      {
        word: 'Hello',
        start: undefined,
        end: undefined,
        speaker: undefined,
        assignmentMethod: 'none',
      },
    ]);
    expect(detail.segments[0].assignmentMethod).toBe('none');
  });

  it('maps an "unknown" assignment and its distance through to camelCase', () => {
    const detail = buildDiarizationDetail({
      segments: [
        {
          id: 'segment-0',
          start: 40,
          end: 42,
          speaker: 'Unknown',
          text: 'huh',
          assignment_method: 'unknown',
          assignment_distance_s: 15,
          words: [
            {
              word: 'huh',
              start: 40,
              end: 41,
              speaker: 'Unknown',
              assignment_method: 'unknown',
              assignment_distance_s: 15,
            },
          ],
        },
      ],
      diarizationTurns: [],
      speakerEmbeddings: null,
      diagnostics: {},
      recordingProfile: null,
    });

    expect(detail.segments[0]).toEqual(
      expect.objectContaining({
        speaker: 'Unknown',
        assignmentMethod: 'unknown',
        assignmentDistanceS: 15,
      }),
    );
    expect(detail.segments[0].words?.[0]).toEqual(
      expect.objectContaining({
        speaker: 'Unknown',
        assignmentMethod: 'unknown',
        assignmentDistanceS: 15,
      }),
    );
  });

  it('defaults a null recordingProfile to the "insufficient_data" shape rather than throwing', () => {
    const detail = buildDiarizationDetail({
      segments: [],
      diarizationTurns: [],
      speakerEmbeddings: null,
      diagnostics: {},
      recordingProfile: null,
    });

    expect(detail.recordingProfile).toEqual({
      speakerCount: 0,
      turnCount: 0,
      medianTurnDurationS: 0,
      meanTurnDurationS: 0,
      p95TurnDurationS: 0,
      longestTurnS: 0,
      speakerSwitchesPerMinute: 0,
      speakerTimeDistributionS: {},
      overlapRatio: 0,
      unassignedAudioRatio: 0,
      shortTurnRatio: 0,
      diarizationCoverageRatio: 0,
      boundaryConflictRatio: 0,
      wordSegmentDisagreementRatio: 0,
      suspiciousSegmentRatio: 0,
      suspiciousSegmentIds: [],
      classification: 'insufficient_data',
    });
  });
});
