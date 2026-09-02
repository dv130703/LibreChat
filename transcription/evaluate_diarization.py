#!/usr/bin/env python3
"""CLI for the diarization-pipeline audit's Phase 4 evaluation metrics (see
`evaluation.py`). Scores a hypothesis transcript against a hand-verified
reference and prints a report.

Usage:
    python -m transcription.evaluate_diarization \\
        --reference path/to/ground-truth.json \\
        --hypothesis path/to/system-output.json \\
        [--collar 0.25] [--word-level] [--output report.json]

Both `--reference` and `--hypothesis` accept either:
  - a bare JSON list of segments: [{"start": 0.0, "end": 5.0, "speaker": "Alice"}, ...]
  - a full diarization-detail-shaped object (exactly what this pipeline's own
    `transcript_diarization_detail` file already contains):
    {"segments": [{"start": ..., "end": ..., "speaker": ..., "words": [...]}, ...], ...}

For a hypothesis, that means you can point `--hypothesis` directly at a
diarization-detail JSON export from this system with no reformatting; the
reference is whatever hand-verified ground truth you (or a labeling tool)
produce in the same shape.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .evaluation import compute_der, compute_word_level_speaker_accuracy


def _load_segments(path: Path) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    segments = data["segments"] if isinstance(data, dict) and "segments" in data else data
    if not isinstance(segments, list):
        raise ValueError(f"{path}: expected a list of segments or an object with a 'segments' list")
    return segments


def _flatten_words(segments: list[dict]) -> list[dict]:
    words: list[dict] = []
    for segment in segments:
        for word in segment.get("words", []):
            if word.get("start") is not None and word.get("end") is not None and word.get("speaker"):
                words.append(word)
    return words


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--reference", type=Path, required=True, help="Path to the hand-verified ground truth JSON")
    parser.add_argument("--hypothesis", type=Path, required=True, help="Path to the system output JSON")
    parser.add_argument(
        "--collar",
        type=float,
        default=0.0,
        help="NIST-convention boundary tolerance in seconds (default: 0, strict scoring)",
    )
    parser.add_argument(
        "--word-level",
        action="store_true",
        help="Also compute word-level speaker accuracy (both files must carry per-segment 'words')",
    )
    parser.add_argument("--output", type=Path, help="Optional path to also write the report as JSON")
    args = parser.parse_args(argv)

    reference = _load_segments(args.reference)
    hypothesis = _load_segments(args.hypothesis)

    der_result = compute_der(reference, hypothesis, collar=args.collar)

    report: dict = {
        "reference_file": str(args.reference),
        "hypothesis_file": str(args.hypothesis),
        "der": der_result.der,
        "missed_speech_s": der_result.missed_speech_s,
        "false_alarm_s": der_result.false_alarm_s,
        "speaker_confusion_s": der_result.speaker_confusion_s,
        "correct_speaker_s": der_result.correct_speaker_s,
        "total_reference_speech_s": der_result.total_reference_speech_s,
        "false_speaker_assignment_rate": der_result.false_speaker_assignment_rate,
        "collar_s": der_result.collar_s,
        "speaker_mapping": der_result.speaker_mapping,
    }

    print(f"Reference:  {args.reference}")
    print(f"Hypothesis: {args.hypothesis}")
    print(f"Speaker mapping (hypothesis -> reference): {der_result.speaker_mapping}")
    print()
    print(f"Diarization Error Rate:     {der_result.der:.2%}")
    print(f"  Missed speech:            {der_result.missed_speech_s:.2f}s")
    print(f"  False alarm:              {der_result.false_alarm_s:.2f}s")
    print(f"  Speaker confusion:        {der_result.speaker_confusion_s:.2f}s")
    print(f"  Correctly attributed:     {der_result.correct_speaker_s:.2f}s")
    print(f"  Total reference speech:   {der_result.total_reference_speech_s:.2f}s")
    print(f"False speaker assignment rate (of matched speech): {der_result.false_speaker_assignment_rate:.2%}")

    if args.word_level:
        reference_words = _flatten_words(reference)
        hypothesis_words = _flatten_words(hypothesis)
        if not reference_words or not hypothesis_words:
            print(
                "\nWord-level accuracy: skipped - reference and/or hypothesis has no per-segment "
                "'words' with start/end/speaker set."
            )
        else:
            word_result = compute_word_level_speaker_accuracy(
                reference_words, hypothesis_words, speaker_mapping=der_result.speaker_mapping
            )
            print()
            print(f"Word-level speaker accuracy: {word_result.accuracy:.2%}")
            print(f"  Correct:   {word_result.correct_count}")
            print(f"  Total:     {word_result.total_count}")
            print(f"  Unmatched: {word_result.unmatched_count} (no hypothesis word at that reference word's time)")
            report["word_level_accuracy"] = word_result.accuracy
            report["word_level_correct_count"] = word_result.correct_count
            report["word_level_total_count"] = word_result.total_count
            report["word_level_unmatched_count"] = word_result.unmatched_count

    if args.output:
        args.output.write_text(json.dumps(report, indent=2), encoding="utf-8")
        print(f"\nReport written to {args.output}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
