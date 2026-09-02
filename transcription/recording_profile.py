"""Computes a lightweight statistical fingerprint of a transcribed recording -
turn-taking pace, speaker balance, overlap, and how much of the transcript's
speaker attribution came from direct diarization evidence versus a fallback
guess - so a reviewer (or downstream code) can tell "rapid two-person
dialogue" apart from "one long monologue" apart from "messy, low-confidence
cross-talk" without re-deriving it from raw segments by hand every time.

Read-only: nothing here changes what gets transcribed, embedded, or shown -
see the diarization-pipeline audit's Phase 2 ("adaptive analysis").
"""

from __future__ import annotations

from dataclasses import dataclass, field

# The placeholder speaker label for a segment/word whose nearest diarization
# turn was too far away to trust (see `MAX_NEAREST_FALLBACK_DISTANCE_S` in
# whisperx_service.py, which stamps this exact string). Not a real, distinct
# speaker - excluded from `speaker_count` below - and shared as one constant
# rather than duplicated so the two modules can't silently drift apart.
UNKNOWN_SPEAKER_LABEL = "Unknown"

# Below this, a turn is short enough to plausibly be diarization noise (a
# clipped word, a stray "mm-hmm") rather than a deliberate, separate turn -
# see `short_turn_ratio`.
SHORT_TURN_THRESHOLD_S = 1.5

# Classification thresholds - illustrative starting points chosen to match
# the example profiles in the diarization-pipeline audit (rapid dialogue:
# ~31 switches/min, ~1.8s median turn; difficult: ~27% overlap), not
# calibrated against labelled data. Revisit once a real evaluation set
# exists (that audit's Phase 4) rather than trusting these as ground truth.
RAPID_SWITCHES_PER_MINUTE = 15.0
RAPID_MEDIAN_TURN_S = 3.0
DIFFICULT_OVERLAP_RATIO = 0.15
DIFFICULT_UNASSIGNED_RATIO = 0.25
DIFFICULT_SHORT_TURN_RATIO = 0.4
DIFFICULT_BOUNDARY_CONFLICT_RATIO = 0.1
DIFFICULT_DISAGREEMENT_RATIO = 0.1


@dataclass
class RecordingProfile:
    speaker_count: int = 0
    turn_count: int = 0
    median_turn_duration_s: float = 0.0
    mean_turn_duration_s: float = 0.0
    p95_turn_duration_s: float = 0.0
    longest_turn_s: float = 0.0
    speaker_switches_per_minute: float = 0.0
    speaker_time_distribution_s: dict[str, float] = field(default_factory=dict)
    # Fraction of the diarized timeline where more than one speaker's turn
    # overlaps - 0 whenever `diarization_turns` is empty (no pyannote
    # involved, e.g. channel_split), not necessarily "no overlap occurred."
    overlap_ratio: float = 0.0
    # Fraction of total segment duration whose speaker came from a "nearest"
    # or "none" assignment rather than direct diarization overlap - see
    # `TSpeakerAssignmentMethod`. High values mean a lot of the transcript's
    # speaker labels are low-confidence guesses, not settled attributions.
    unassigned_audio_ratio: float = 0.0
    short_turn_ratio: float = 0.0
    # Fraction of the recording's own time span (first segment start to last
    # segment end) that at least one raw diarization turn actually covers -
    # distinct from `overlap_ratio` (how much turns overlap EACH OTHER):
    # this is how much of the timeline pyannote produced turns for at all. A
    # low value with a high `unassigned_audio_ratio` points at real gaps in
    # diarization coverage, not just a noisy assignment.
    diarization_coverage_ratio: float = 0.0
    # Fraction of segments whose own [start, end] span is covered by MORE
    # THAN ONE distinct raw-diarization speaker - a segment straddling a
    # turn boundary pyannote itself drew, which can mean the ASR segment
    # missed a genuine mid-segment speaker change.
    boundary_conflict_ratio: float = 0.0
    # Fraction of word-bearing segments where the segment's own `speaker`
    # disagrees with the majority speaker among its own words - the two are
    # computed independently (see `assign_word_speakers`), so this is a real
    # diagnostic signal, not noise. Denominator excludes segments with no
    # word-level speaker data at all.
    word_segment_disagreement_ratio: float = 0.0
    # Fraction of segments flagged for ANY of the above reasons (nearest-
    # fallback assignment, a boundary conflict, or a word/segment
    # disagreement) - see `suspicious_segment_ids` for which ones.
    suspicious_segment_ratio: float = 0.0
    # The segment `id`s (e.g. "segment-42") actually flagged - a global
    # ratio alone tells you a recording is worth reviewing; this tells you
    # where to look.
    suspicious_segment_ids: list[str] = field(default_factory=list)
    classification: str = "insufficient_data"


def _merge_into_turns(segments: list[dict]) -> list[dict]:
    """Consecutive same-speaker segments read as one continuous turn - the
    same merge `meetingMinutesDocx.ts` does for display, done here purely to
    count/time turns for statistics. Does not change the segments themselves.
    """
    turns: list[dict] = []
    for segment in segments:
        if turns and turns[-1]["speaker"] == segment["speaker"]:
            turns[-1]["end"] = segment["end"]
        else:
            turns.append(
                {"speaker": segment["speaker"], "start": segment["start"], "end": segment["end"]}
            )
    return turns


def _percentile(sorted_values: list[float], pct: float) -> float:
    """Nearest-rank percentile - no interpolation, no external dependency,
    well-defined for any non-empty input including n=1."""
    if not sorted_values:
        return 0.0
    rank = max(0, min(len(sorted_values) - 1, int(round(pct / 100 * len(sorted_values))) - 1))
    return sorted_values[rank]


def _union_duration(intervals: list[tuple[float, float]]) -> float:
    """Total seconds covered by at least one interval - the standard
    merge-overlapping-intervals sweep. `overlap_ratio` derives both its
    numerator (sum of interval lengths minus this) and its denominator
    (this) from the same sweep, so double-counted overlap and "how much
    speech happened at all" are measured consistently against each other."""
    if not intervals:
        return 0.0
    ordered = sorted(intervals)
    total = 0.0
    current_start, current_end = ordered[0]
    for start, end in ordered[1:]:
        if start > current_end:
            total += current_end - current_start
            current_start, current_end = start, end
        else:
            current_end = max(current_end, end)
    total += current_end - current_start
    return total


def _overlapping_turn_speakers(
    diarization_turns: list[dict], start: float, end: float
) -> set[str]:
    """Every distinct raw-diarization speaker whose turn overlaps [start,
    end] - more than one means this segment straddles a boundary pyannote
    itself drew between two different speakers."""
    return {
        turn["speaker"]
        for turn in diarization_turns
        if turn["start"] < end and turn["end"] > start
    }


def _word_majority_speaker(words: list[dict]) -> str | None:
    """The most common speaker among a segment's own words, or None if none
    of them carry one (e.g. alignment produced no per-word speaker at all)."""
    counts: dict[str, int] = {}
    for word in words:
        speaker = word.get("speaker")
        if speaker is not None:
            counts[speaker] = counts.get(speaker, 0) + 1
    if not counts:
        return None
    return max(counts.items(), key=lambda item: item[1])[0]


def _classify(profile: RecordingProfile) -> str:
    if profile.turn_count == 0:
        return "insufficient_data"
    if profile.speaker_count <= 1:
        return "monologue"
    # Checked before "rapid_dialogue" deliberately: a fast-paced recording
    # that's ALSO ambiguous is more usefully flagged as difficult (an
    # actionable data-quality signal) than as merely rapid.
    if (
        profile.overlap_ratio >= DIFFICULT_OVERLAP_RATIO
        or profile.unassigned_audio_ratio >= DIFFICULT_UNASSIGNED_RATIO
        or profile.short_turn_ratio >= DIFFICULT_SHORT_TURN_RATIO
        or profile.boundary_conflict_ratio >= DIFFICULT_BOUNDARY_CONFLICT_RATIO
        or profile.word_segment_disagreement_ratio >= DIFFICULT_DISAGREEMENT_RATIO
    ):
        return "difficult"
    if (
        profile.speaker_switches_per_minute >= RAPID_SWITCHES_PER_MINUTE
        or profile.median_turn_duration_s < RAPID_MEDIAN_TURN_S
    ):
        return "rapid_dialogue"
    return "conversation"


def compute_recording_profile(
    segments: list[dict],
    diarization_turns: list[dict],
) -> RecordingProfile:
    """`segments`: the final per-segment dicts `WhisperXService.transcribe`
    builds (each with `start`/`end`/`speaker`/`assignment_method`).
    `diarization_turns`: the raw pyannote turns before renumbering - empty
    for channel-split transcriptions, which never call pyannote."""
    if not segments:
        return RecordingProfile()

    turns = _merge_into_turns(segments)
    durations = sorted(turn["end"] - turn["start"] for turn in turns)
    total_turn_duration = sum(durations)
    recording_span = max(segment["end"] for segment in segments) - min(
        segment["start"] for segment in segments
    )

    speaker_time: dict[str, float] = {}
    unassigned_duration = 0.0
    total_segment_duration = 0.0
    for segment in segments:
        length = segment["end"] - segment["start"]
        total_segment_duration += length
        speaker_time[segment["speaker"]] = speaker_time.get(segment["speaker"], 0.0) + length
        if segment.get("assignment_method") not in ("overlap", "channel_split"):
            unassigned_duration += length

    diarization_intervals = [(turn["start"], turn["end"]) for turn in diarization_turns]
    union = _union_duration(diarization_intervals)
    raw_total = sum(end - start for start, end in diarization_intervals)
    overlap_seconds = max(0.0, raw_total - union)

    turn_count = len(turns)
    short_turns = sum(1 for duration in durations if duration < SHORT_TURN_THRESHOLD_S)
    switches_per_minute = (
        (turn_count - 1) / (recording_span / 60) if turn_count > 1 and recording_span > 0 else 0.0
    )

    # Boundary conflicts and word/segment disagreement - both per-segment,
    # both roll up into `suspicious_segment_ids` alongside a bare
    # "nearest"-fallback assignment.
    boundary_conflicts = 0
    disagreements = 0
    segments_with_words = 0
    suspicious_ids: list[str] = []
    for segment in segments:
        # "unknown" (no diarization evidence close enough to trust - see
        # MAX_NEAREST_FALLBACK_DISTANCE_S) is a stronger suspicion signal
        # than "nearest", not merely an equal one, but both roll up into the
        # same flag here.
        is_suspicious = segment.get("assignment_method") in ("nearest", "unknown")

        overlapping_speakers = _overlapping_turn_speakers(
            diarization_turns, segment["start"], segment["end"]
        )
        if len(overlapping_speakers) > 1:
            boundary_conflicts += 1
            is_suspicious = True

        words = segment.get("words") or []
        if words:
            segments_with_words += 1
            majority_speaker = _word_majority_speaker(words)
            if majority_speaker is not None and majority_speaker != segment.get("speaker"):
                disagreements += 1
                is_suspicious = True

        if is_suspicious:
            suspicious_ids.append(segment.get("id", ""))

    segment_count = len(segments)

    real_speaker_count = len(
        {speaker for speaker in speaker_time if speaker != UNKNOWN_SPEAKER_LABEL}
    )

    profile = RecordingProfile(
        speaker_count=real_speaker_count,
        turn_count=turn_count,
        median_turn_duration_s=round(_percentile(durations, 50), 2),
        mean_turn_duration_s=round(total_turn_duration / turn_count, 2) if turn_count else 0.0,
        p95_turn_duration_s=round(_percentile(durations, 95), 2),
        longest_turn_s=round(durations[-1], 2) if durations else 0.0,
        speaker_switches_per_minute=round(switches_per_minute, 2),
        speaker_time_distribution_s={
            speaker: round(seconds, 2) for speaker, seconds in speaker_time.items()
        },
        overlap_ratio=round(overlap_seconds / union, 4) if union > 0 else 0.0,
        unassigned_audio_ratio=(
            round(unassigned_duration / total_segment_duration, 4)
            if total_segment_duration > 0
            else 0.0
        ),
        short_turn_ratio=round(short_turns / turn_count, 4) if turn_count else 0.0,
        diarization_coverage_ratio=(
            round(union / recording_span, 4) if recording_span > 0 else 0.0
        ),
        boundary_conflict_ratio=(
            round(boundary_conflicts / segment_count, 4) if segment_count else 0.0
        ),
        word_segment_disagreement_ratio=(
            round(disagreements / segments_with_words, 4) if segments_with_words else 0.0
        ),
        suspicious_segment_ratio=(
            round(len(suspicious_ids) / segment_count, 4) if segment_count else 0.0
        ),
        suspicious_segment_ids=suspicious_ids,
    )
    profile.classification = _classify(profile)
    return profile
