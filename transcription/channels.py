"""Detects and isolates individual audio channels for channel-based speaker
separation - the alternative to pyannote diarization for recordings where
each speaker was captured on their own channel (e.g. a two-line call
recording). That case needs neither clustering nor a diarization model to
know who's who: the channel already says it.
"""

from __future__ import annotations

import subprocess

import numpy as np


def probe_channel_count(audio_path: str) -> int:
    """How many channels the file's first audio stream has. Falls back to 1
    on any ffprobe failure - an unreadable channel count should fall through
    to the normal single-stream/pyannote path, not raise here."""
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "a:0",
                "-show_entries",
                "stream=channels",
                "-of",
                "csv=p=0",
                audio_path,
            ],
            capture_output=True,
            check=True,
            text=True,
        )
        return int(result.stdout.strip() or "1")
    except (subprocess.CalledProcessError, ValueError, FileNotFoundError):
        return 1


def load_audio_channel(audio_path: str, channel_index: int, sr: int = 16000) -> np.ndarray:
    """One channel, decoded to float32 samples at `sr` Hz - the same target
    format `whisperx.load_audio` decodes the whole file to, just restricted
    to `channel_index` via ffmpeg's own channel selector instead of
    downmixing every channel together."""
    cmd = [
        "ffmpeg",
        "-nostdin",
        "-threads",
        "0",
        "-i",
        audio_path,
        "-map_channel",
        f"0.0.{channel_index}",
        "-f",
        "s16le",
        "-acodec",
        "pcm_s16le",
        "-ar",
        str(sr),
        "-",
    ]
    try:
        out = subprocess.run(cmd, capture_output=True, check=True).stdout
    except subprocess.CalledProcessError as error:
        raise RuntimeError(
            f"Failed to load channel {channel_index} from {audio_path}: "
            f"{error.stderr.decode(errors='replace')}"
        ) from error
    return np.frombuffer(out, np.int16).flatten().astype(np.float32) / 32768.0
