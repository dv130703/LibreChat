from app.services.speaker_bounds import (
    MAX_ALLOWED_SPEAKERS,
    MIN_ALLOWED_SPEAKERS,
    resolve_speaker_bounds,
)


class TestResolveSpeakerBounds:
    def test_a_sensible_pair_passes_through_untouched(self):
        bounds = resolve_speaker_bounds(2, 4)
        assert (bounds.min_speakers, bounds.max_speakers) == (2, 4)
        assert bounds.adjustments == []

    def test_absent_bounds_stay_absent(self):
        bounds = resolve_speaker_bounds(None, None)
        assert not bounds.is_set
        assert bounds.describe() == "auto"

    def test_one_sided_hints_are_kept(self):
        assert resolve_speaker_bounds(3, None).describe() == "at least 3"
        assert resolve_speaker_bounds(None, 3).describe() == "at most 3"

    def test_inverted_pair_is_swapped_not_rejected(self):
        # "4 to 2" is unambiguous about which numbers were meant; throwing the
        # request away would lose a hint the user did give.
        bounds = resolve_speaker_bounds(4, 2)
        assert (bounds.min_speakers, bounds.max_speakers) == (2, 4)
        assert any("swapped" in note for note in bounds.adjustments)

    def test_zero_and_negative_are_raised_into_range(self):
        bounds = resolve_speaker_bounds(0, 4)
        assert bounds.min_speakers == MIN_ALLOWED_SPEAKERS
        assert bounds.adjustments

    def test_absurdly_high_bounds_are_capped(self):
        bounds = resolve_speaker_bounds(None, 500)
        assert bounds.max_speakers == MAX_ALLOWED_SPEAKERS
        assert bounds.adjustments

    def test_every_adjustment_is_reported(self):
        # Nothing is changed behind the caller's back.
        bounds = resolve_speaker_bounds(99, 0)
        assert len(bounds.adjustments) == 3  # min capped, max raised, then swapped

    def test_an_exact_count_is_allowed(self):
        bounds = resolve_speaker_bounds(3, 3)
        assert bounds.describe() == "exactly 3"


class TestContains:
    def test_inside_a_range(self):
        assert resolve_speaker_bounds(2, 4).contains(3)

    def test_outside_a_range(self):
        assert not resolve_speaker_bounds(2, 4).contains(5)
        assert not resolve_speaker_bounds(2, 4).contains(1)

    def test_boundaries_are_inclusive(self):
        bounds = resolve_speaker_bounds(2, 4)
        assert bounds.contains(2)
        assert bounds.contains(4)

    def test_one_sided_hints(self):
        assert resolve_speaker_bounds(3, None).contains(9)
        assert not resolve_speaker_bounds(3, None).contains(2)
        assert resolve_speaker_bounds(None, 3).contains(1)
        assert not resolve_speaker_bounds(None, 3).contains(4)

    def test_no_hint_contains_everything(self):
        assert resolve_speaker_bounds(None, None).contains(7)
