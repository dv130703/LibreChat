"""Normalises the caller's speaker-count hint before it reaches a diarizer.

The hint is worth guarding because it is easy to get subtly wrong and the
failure is silent: pyannote takes ``min_speakers``/``max_speakers`` at face
value, so an inverted or out-of-range pair either errors deep inside the
pipeline or quietly produces a worse result than passing nothing at all.

Everything here is reported rather than applied behind the caller's back - if a
bound is moved, the adjustment is named, so a run that didn't use the numbers
you typed says so.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# One speaker is a monologue; past twenty the hint is doing more harm than good
# and the clustering should be left to decide for itself.
MIN_ALLOWED_SPEAKERS = 1
MAX_ALLOWED_SPEAKERS = 20


@dataclass
class SpeakerBounds:
    """The hint as it will actually be used, and what changed on the way."""

    min_speakers: int | None = None
    max_speakers: int | None = None
    adjustments: list[str] = field(default_factory=list)

    @property
    def is_set(self) -> bool:
        return self.min_speakers is not None or self.max_speakers is not None

    def describe(self) -> str:
        if self.min_speakers is not None and self.max_speakers is not None:
            if self.min_speakers == self.max_speakers:
                return f"exactly {self.min_speakers}"
            return f"{self.min_speakers}-{self.max_speakers}"
        if self.min_speakers is not None:
            return f"at least {self.min_speakers}"
        if self.max_speakers is not None:
            return f"at most {self.max_speakers}"
        return "auto"

    def contains(self, count: int) -> bool:
        if self.min_speakers is not None and count < self.min_speakers:
            return False
        if self.max_speakers is not None and count > self.max_speakers:
            return False
        return True


def _clamp(value: int, label: str, adjustments: list[str]) -> int:
    if value < MIN_ALLOWED_SPEAKERS:
        adjustments.append(f"{label} raised from {value} to {MIN_ALLOWED_SPEAKERS}")
        return MIN_ALLOWED_SPEAKERS
    if value > MAX_ALLOWED_SPEAKERS:
        adjustments.append(f"{label} lowered from {value} to {MAX_ALLOWED_SPEAKERS}")
        return MAX_ALLOWED_SPEAKERS
    return value


def resolve_speaker_bounds(min_speakers: int | None, max_speakers: int | None) -> SpeakerBounds:
    """Clamp the pair into range and put it the right way round.

    An inverted pair is read as a range typed in the wrong order rather than as
    an error: "4 to 2" is unambiguous about which numbers were meant, and
    rejecting the whole request over it would lose a hint the user did give.
    """
    adjustments: list[str] = []

    resolved_min = _clamp(min_speakers, "Minimum", adjustments) if min_speakers is not None else None
    resolved_max = _clamp(max_speakers, "Maximum", adjustments) if max_speakers is not None else None

    if resolved_min is not None and resolved_max is not None and resolved_min > resolved_max:
        adjustments.append(f"Minimum and maximum swapped ({resolved_min} and {resolved_max} were the wrong way round)")
        resolved_min, resolved_max = resolved_max, resolved_min

    return SpeakerBounds(min_speakers=resolved_min, max_speakers=resolved_max, adjustments=adjustments)
