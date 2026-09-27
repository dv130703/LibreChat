import {
  STAGE_ORDER,
  estimateRemainingSeconds,
  formatAudioClock,
  isPostTranscriptStage,
  overallFraction,
  remainingParts,
  stageFraction,
  stageStates,
  stageStep,
} from '../jobProgress';

describe('stageStates', () => {
  it('marks earlier stages done, the current one active, and the rest pending', () => {
    const states = stageStates('matching_voices');

    expect(states.transcribing).toBe('done');
    expect(states.matching_voices).toBe('active');
    expect(states.reviewing_attribution).toBe('pending');
  });

  it('treats the first stage as active with nothing before it done', () => {
    const states = stageStates('extracting');

    expect(states.extracting).toBe('active');
    expect(Object.values(states).filter((state) => state === 'done')).toHaveLength(0);
  });

  /** A record written before stages existed, or a job not started yet. */
  it('leaves every stage pending when none is reported', () => {
    const states = stageStates(null);

    expect(Object.values(states).every((state) => state === 'pending')).toBe(true);
  });

  it('covers every stage in the shared order', () => {
    expect(Object.keys(stageStates('indexing')).sort()).toEqual([...STAGE_ORDER].sort());
  });
});

describe('stageFraction', () => {
  it('reports the fraction of audio transcribed so far', () => {
    expect(stageFraction(30, 120)).toBeCloseTo(0.25);
  });

  /** Null, not zero: only the transcription phase measures a position, and
   *  a zeroed bar elsewhere would read as "stuck at 0%" rather than as a
   *  phase with nothing to measure. */
  it('reports nothing when there is no position to report', () => {
    expect(stageFraction(null, null)).toBeNull();
    expect(stageFraction(30, null)).toBeNull();
    expect(stageFraction(null, 120)).toBeNull();
  });

  it('reports nothing for a zero or negative total', () => {
    expect(stageFraction(10, 0)).toBeNull();
    expect(stageFraction(10, -5)).toBeNull();
  });

  /** The pipeline's last segment can end fractionally past the reported
   *  duration, which must not render as a bar overflowing its track. */
  it('clamps a position past the end', () => {
    expect(stageFraction(130, 120)).toBe(1);
  });

  it('ignores non-finite input', () => {
    expect(stageFraction(Number.NaN, 120)).toBeNull();
    expect(stageFraction(10, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('formatAudioClock', () => {
  it('formats as m:ss', () => {
    expect(formatAudioClock(0)).toBe('0:00');
    expect(formatAudioClock(62)).toBe('1:02');
    expect(formatAudioClock(3599)).toBe('59:59');

    /** Past an hour it grows a third field rather than counting minutes up
     *  into the hundreds - `151:50` is arithmetic, `2:31:50` is a glance. */
    expect(formatAudioClock(3600)).toBe('1:00:00');
    expect(formatAudioClock(9110)).toBe('2:31:50');
  });

  it('guards against nonsense rather than rendering NaN:aN', () => {
    expect(formatAudioClock(Number.NaN)).toBe('0:00');
    expect(formatAudioClock(-5)).toBe('0:00');
  });
});

describe('stageStep', () => {
  it('numbers stages from one', () => {
    expect(stageStep('extracting')).toBe(1);
    expect(stageStep('reviewing_attribution')).toBe(STAGE_ORDER.length);
    expect(stageStep(null)).toBeNull();
  });
});

describe('overallFraction', () => {
  it('advances a step per completed stage', () => {
    expect(overallFraction('extracting', null, null)).toBe(0);
    expect(overallFraction('indexing', null, null)).toBeCloseTo(4 / 8);
  });

  /** The measured stage has to move the bar within itself, not only when it
   *  hands off - otherwise a 2.5-hour transcription shows nothing for an
   *  hour. */
  it('folds the measured position into the stage it belongs to', () => {
    expect(overallFraction('transcribing', 60, 120)).toBeCloseTo(1.5 / 8);
  });

  it('reports nothing for a job that has not named a stage', () => {
    expect(overallFraction(null, 60, 120)).toBe(0);
  });
});

describe('estimateRemainingSeconds', () => {
  const sample = { processedSeconds: 100, at: 0 };

  /** 200s of audio in 100s of wall clock is 2x realtime, so the remaining
   *  400s of audio is another 200s of waiting. */
  it('extrapolates from the pace this run has actually held', () => {
    expect(estimateRemainingSeconds(sample, 300, 700, 100_000)).toBeCloseTo(200);
  });

  it('says nothing until the sample window is wide enough to trust', () => {
    expect(estimateRemainingSeconds(sample, 300, 700, 5_000)).toBeNull();
  });

  it('says nothing when the position has not moved', () => {
    expect(estimateRemainingSeconds(sample, 100, 700, 100_000)).toBeNull();
  });

  it('says nothing once the position has reached the end', () => {
    expect(estimateRemainingSeconds(sample, 700, 700, 100_000)).toBeNull();
  });
});

describe('remainingParts', () => {
  it('splits into whole hours and minutes', () => {
    expect(remainingParts(4500)).toEqual({ hours: 1, minutes: 15 });
    expect(remainingParts(150)).toEqual({ hours: 0, minutes: 3 });
  });

  /** Zero of both is the caller's cue to say "less than a minute" rather
   *  than count the last seconds down. */
  it('reports zero of both under half a minute', () => {
    expect(remainingParts(20)).toEqual({ hours: 0, minutes: 0 });
  });
});

describe('isPostTranscriptStage', () => {
  /** The panel swaps to the transcript as soon as one exists, which is three
   *  stages before the job finishes - and those three write speaker
   *  corrections into the lines already on screen. */
  it('marks the stages that run after the transcript is already readable', () => {
    expect(isPostTranscriptStage('matching_voices')).toBe(true);
    expect(isPostTranscriptStage('identifying_speakers')).toBe(true);
    expect(isPostTranscriptStage('reviewing_attribution')).toBe(true);
    expect(isPostTranscriptStage('indexing')).toBe(true);
  });

  /** Reaching these with a transcript on screen means a re-transcribe is
   *  running over an existing one, which is a different thing to say. */
  it('leaves the stages that produce the transcript out', () => {
    expect(isPostTranscriptStage('extracting')).toBe(false);
    expect(isPostTranscriptStage('transcribing')).toBe(false);
    expect(isPostTranscriptStage('diarizing')).toBe(false);
    expect(isPostTranscriptStage(null)).toBe(false);
  });
});
