"""Covers the per-request VAD swap. Like the existing prompt/hotwords/
suppress_numerals swap in _transcribe_batched, it mutates state shared by every
request, so what matters is that the mask is in force for the decode and gone
again afterwards - a leaked one would gate the next recording on this
recording's speech regions."""

from dataclasses import dataclass

import pytest

from transcription.config import Settings
from transcription.whisperx_service import PrecomputedVad, WhisperXService


@dataclass
class FakeOptions:
    initial_prompt: str | None = None
    hotwords: str | None = None


class FakePipeline:
    """Records which VAD was in force at the moment transcribe() ran."""

    def __init__(self):
        self.options = FakeOptions()
        self.suppress_numerals = False
        self.vad_model = "the pipeline's own VAD"
        self.seen_vads: list = []
        self.raise_on_call = False

    def transcribe(self, audio, batch_size=None, language=None):
        self.seen_vads.append(self.vad_model)
        if self.raise_on_call:
            raise RuntimeError("decode failed")
        return {"segments": [], "language": language or "en"}


@pytest.fixture
def service():
    return WhisperXService(Settings(device="cpu"))


@pytest.fixture
def pipeline():
    return FakePipeline()


def test_the_precomputed_mask_is_in_force_during_the_call(service, pipeline):
    service._transcribe_batched(
        pipeline,
        audio=None,
        language="en",
        initial_prompt=None,
        hotwords=None,
        suppress_numerals=False,
        speech=[(0.0, 4.0)],
    )
    assert isinstance(pipeline.seen_vads[0], PrecomputedVad)


def test_the_pipeline_vad_is_restored_afterwards(service, pipeline):
    service._transcribe_batched(
        pipeline,
        audio=None,
        language="en",
        initial_prompt=None,
        hotwords=None,
        suppress_numerals=False,
        speech=[(0.0, 4.0)],
    )
    assert pipeline.vad_model == "the pipeline's own VAD"


def test_the_pipeline_vad_is_restored_even_when_the_call_raises(service, pipeline):
    pipeline.raise_on_call = True
    with pytest.raises(RuntimeError):
        service._transcribe_batched(
            pipeline,
            audio=None,
            language="en",
            initial_prompt=None,
            hotwords=None,
            suppress_numerals=False,
            speech=[(0.0, 4.0)],
        )
    assert pipeline.vad_model == "the pipeline's own VAD"


def test_the_mask_carries_exactly_the_regions_it_was_given():
    vad = PrecomputedVad([(0.0, 1.5), (9.0, 12.0)])
    segments = vad(audio=None)
    assert [(segment.start, segment.end) for segment in segments] == [(0.0, 1.5), (9.0, 12.0)]


def test_regions_are_grouped_into_decode_windows_without_rethresholding():
    # merge_chunks only batches; the thresholds it takes are whisperx's own
    # signature, not a second chance to drop speech.
    vad = PrecomputedVad([(0.0, 1.0), (2.0, 3.0)])
    chunks = PrecomputedVad.merge_chunks(vad(audio=None), chunk_size=30)
    assert [(chunk["start"], chunk["end"]) for chunk in chunks] == [(0.0, 3.0)]


def test_silence_all_the_way_through_yields_no_chunks():
    assert PrecomputedVad.merge_chunks([], chunk_size=30) == []


def test_a_single_region_past_chunk_size_is_split_before_merging():
    # A continuous stretch longer than chunk_size (e.g. from unioning the
    # confident and borderline tiers across what would otherwise be a gap)
    # must come out in <= chunk_size pieces - whisperx's own merge_chunks
    # never splits a region that is already oversized on its own, and an
    # oversized chunk crashes torch.stack downstream in asr.py's batching.
    vad = PrecomputedVad([(5.0, 41.0)])
    chunks = PrecomputedVad.merge_chunks(vad(audio=None), chunk_size=30)
    assert [(chunk["start"], chunk["end"]) for chunk in chunks] == [(5.0, 35.0), (35.0, 41.0)]
    assert all(end - start <= 30 for start, end in ((c["start"], c["end"]) for c in chunks))
