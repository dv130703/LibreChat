"""Normalises the caller's speaker-count hint before it reaches a diarizer.

The hint is worth guarding because it is easy to get subtly wrong and the
failure is silent: pyannote takes ``num_speakers`` at face value, so an
out-of-range value either errors deep inside the pipeline or quietly produces
a worse result than passing nothing at all.

Everything here is reported rather than applied behind the caller's back - if
the bound is moved, the adjustment is named, so a run that didn't use the
number you typed says so.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# One speaker is a monologue; pyannote's own accuracy falls off past eight,
# so past that point the hint is doing more harm than good and the
# clustering should be left to decide for itself.
MIN_ALLOWED_SPEAKERS = 1
MAX_ALLOWED_SPEAKERS = 8


@dataclass
class SpeakerCountHint:
    """The hint as it will actually be used, and what changed on the way."""

    count: int | None = None
    adjustments: list[str] = field(default_factory=list)

    @property
    def is_set(self) -> bool:
        return self.count is not None

    def describe(self) -> str:
        if self.count is not None:
            return f"exactly {self.count}"
        return "auto"

    def matches(self, count: int) -> bool:
        return self.count is None or self.count == count


def resolve_speaker_count(speaker_count: int | None) -> SpeakerCountHint:
    """Clamp the hint into the range pyannote is actually reliable over."""
    if speaker_count is None:
        return SpeakerCountHint()

    adjustments: list[str] = []
    resolved = speaker_count
    if resolved < MIN_ALLOWED_SPEAKERS:
        adjustments.append(f"Speaker count raised from {resolved} to {MIN_ALLOWED_SPEAKERS}")
        resolved = MIN_ALLOWED_SPEAKERS
    elif resolved > MAX_ALLOWED_SPEAKERS:
        adjustments.append(f"Speaker count lowered from {resolved} to {MAX_ALLOWED_SPEAKERS}")
        resolved = MAX_ALLOWED_SPEAKERS

    return SpeakerCountHint(count=resolved, adjustments=adjustments)
