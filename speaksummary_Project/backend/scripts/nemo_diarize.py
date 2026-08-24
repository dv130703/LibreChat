"""Standalone diarization script, run with backend/.venv-nemo's interpreter.

Invoked as a subprocess from WhisperXService so NVIDIA NeMo's dependencies
stay isolated from the main whisperx/pyannote environment (NeMo pulls in a
conflicting `lightning` version). Takes an audio file path and an output path,
writes {"segments": [{"start", "end", "speaker"}, ...]} JSON to the output path.
"""

import argparse
import json


# --- NeMo API surface -------------------------------------------------------
# Isolated here so a NeMo version bump that moves/renames this class only
# requires editing this one import line. Current as of NeMo's `nemo_toolkit`
# ASR collection; if this import starts failing after an upgrade, check
# `nemo.collections.asr.models` for the new home of the Sortformer class.
def _load_sortformer_model(model_name: str):
    from nemo.collections.asr.models import SortformerEncLabelModel

    return SortformerEncLabelModel.from_pretrained(model_name)
# -----------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio_path")
    parser.add_argument("output_path")
    parser.add_argument(
        "--model-name",
        default="nvidia/diar_streaming_sortformer_4spk-v2",
        help="HF Hub id of the NeMo Sortformer checkpoint (keep in sync with WHISPERX_NEMO_MODEL_NAME).",
    )
    args = parser.parse_args()

    # The streaming variant processes audio in bounded-memory chunks internally
    # (an "Arrival-Order Speaker Cache" keeps speaker identity consistent across
    # chunks), so it doesn't blow up VRAM on long files the way the non-streaming
    # nvidia/diar_sortformer_4spk-v1 does (O(length^2) attention, single forward
    # pass - OOMs past roughly 10-15 minutes on a 12GB GPU).
    model = _load_sortformer_model(args.model_name)
    model.eval()

    # Returns one list of "start end speaker_N" strings per input audio file,
    # grouped by speaker rather than chronological order.
    raw_lines = model.diarize(audio=args.audio_path, batch_size=1, verbose=False)[0]

    segments = []
    for line in raw_lines:
        start_str, end_str, speaker = line.split()
        segments.append({"start": float(start_str), "end": float(end_str), "speaker": speaker})
    segments.sort(key=lambda segment: segment["start"])

    with open(args.output_path, "w") as f:
        json.dump({"segments": segments}, f)


if __name__ == "__main__":
    main()
