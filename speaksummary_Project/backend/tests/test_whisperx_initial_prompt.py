"""Covers the per-request prompt swap, which is the one piece of this feature
that mutates shared state. A stub stands in for the pipeline: the real one needs
a model on a device, and what matters here is the bookkeeping around the call,
not the transcription."""

from dataclasses import dataclass

import pytest

from app.config import Settings
from app.services.whisperx_service import WhisperXService


@dataclass
class FakeOptions:
    initial_prompt: str | None = None
    hotwords: str | None = None


class FakePipeline:
    """Records what options were in force at the moment transcribe() ran."""

    def __init__(self, options: FakeOptions):
        self.options = options
        self.seen_prompts: list[str | None] = []
        self.raise_on_call = False

    def transcribe(self, audio, batch_size=None, language=None):
        self.seen_prompts.append(self.options.initial_prompt)
        if self.raise_on_call:
            raise RuntimeError("decode failed")
        return {"segments": [], "language": language or "en"}


@pytest.fixture
def service():
    return WhisperXService(Settings())


@pytest.fixture
def pipeline():
    return FakePipeline(FakeOptions(initial_prompt=None, hotwords="deployment glossary"))


def test_prompt_is_in_force_during_the_call(service, pipeline):
    service._transcribe_batched(pipeline, audio=None, language="en", initial_prompt="SFO, POCA.")
    assert pipeline.seen_prompts == ["SFO, POCA."]


def test_options_are_restored_afterwards(service, pipeline):
    before = pipeline.options
    service._transcribe_batched(pipeline, audio=None, language="en", initial_prompt="SFO, POCA.")
    assert pipeline.options is before
    assert pipeline.options.initial_prompt is None


def test_options_are_restored_even_when_the_call_raises(service, pipeline):
    # A leaked prompt would silently condition every later recording on this
    # one's terminology, so the restore has to survive a failure.
    pipeline.raise_on_call = True
    with pytest.raises(RuntimeError):
        service._transcribe_batched(pipeline, audio=None, language="en", initial_prompt="SFO.")
    assert pipeline.options.initial_prompt is None


def test_no_prompt_leaves_options_untouched(service, pipeline):
    before = pipeline.options
    service._transcribe_batched(pipeline, audio=None, language="en", initial_prompt=None)
    assert pipeline.options is before
    assert pipeline.seen_prompts == [None]


def test_empty_prompt_is_treated_as_no_prompt(service, pipeline):
    service._transcribe_batched(pipeline, audio=None, language="en", initial_prompt="")
    assert pipeline.seen_prompts == [None]


def test_deployment_hotwords_survive_the_swap(service, pipeline):
    # The two glossaries are independent: a per-recording prompt must not wipe
    # the deployment-wide hotwords out of the options it replaces.
    service._transcribe_batched(pipeline, audio=None, language="en", initial_prompt="SFO.")
    assert pipeline.options.hotwords == "deployment glossary"
