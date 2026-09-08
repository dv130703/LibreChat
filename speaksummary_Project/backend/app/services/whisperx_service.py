import json
import logging
import os
import subprocess
import tempfile
from dataclasses import replace
from functools import lru_cache
from pathlib import Path
from threading import Lock

import pandas as pd
import torch
import whisperx
from whisperx.diarize import DiarizationPipeline, Segment as SegmentX
from whisperx.vads import Vad

from ..config import Settings, get_settings
from .diarization_merge import merge_fragmented_speakers
from .reconciliation import reconcile_word_speakers
from .speaker_bounds import resolve_speaker_bounds
from .transcription_prompt import (
    PromptBuild,
    build_initial_prompt,
    estimate_tokens,
    normalize_hotwords,
    prompt_budget,
)
from .vad import PyannoteVad
from .vad_tiers import (
    SAMPLE_RATE,
    VAD_CHUNK_SIZE,
    Interval,
    compute_tiers,
    tag_segments,
    total_duration,
)

logger = logging.getLogger(__name__)

_BACKEND_DIR = Path(__file__).resolve().parent.parent.parent
_NEMO_SCRIPT = _BACKEND_DIR / "scripts" / "nemo_diarize.py"
_NEMO_VENV_PYTHON = _BACKEND_DIR / ".venv-nemo" / "bin" / "python"


class PrecomputedVad(Vad):
    """Hands whisperx a speech mask this service has already decided on.

    Left to itself, whisperx would run VAD inside transcribe() and keep only
    what one threshold pair admitted. The mask built here already carries both
    tiers, so the quiet speech the second tier found reaches the recogniser
    instead of being dropped before it.
    """

    def __init__(self, intervals: list[Interval]):
        self._segments = [SegmentX(start, end, "UNKNOWN") for start, end in intervals]

    def __call__(self, audio, **kwargs):
        return self._segments

    @staticmethod
    def preprocess_audio(audio):
        return audio

    @staticmethod
    def merge_chunks(segments_list, chunk_size, onset: float = 0.5, offset: float | None = None):
        # Thresholding is already done; this only groups regions into the
        # windows whisperx decodes as a batch.
        if not segments_list:
            logger.warning("Neither VAD tier found speech in this recording")
            return []
        return Vad.merge_chunks(segments_list, chunk_size, onset, offset)


class WhisperXService:
    """Loads whisperx models lazily and caches them across requests."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.device = settings.device or ("cuda" if torch.cuda.is_available() else "cpu")
        self.compute_type = settings.compute_type or ("float16" if self.device == "cuda" else "int8")

        self._lock = Lock()
        # Distinct from _lock on purpose. _lock is non-reentrant and is held by
        # _get_model(), so a transcribe() that took it and then asked for the
        # model would deadlock. This one guards the per-request mutation of the
        # shared pipeline's options (see transcribe), and nothing else.
        self._options_lock = Lock()
        # Likewise distinct: _get_model() asks for the VAD while holding _lock,
        # so the VAD cannot be guarded by the same non-reentrant lock.
        self._vad_lock = Lock()
        self._model = None
        self._align_models: dict[str, tuple] = {}
        self._diarize_model = None
        self._vad: PyannoteVad | None = None

    @property
    def is_model_loaded(self) -> bool:
        return self._model is not None

    def _calculate_batch_size(self) -> int:
        """Optimize batch_size based on beam search parameters to prevent OOM.

        Beam search with best_of multiplies memory usage, so we reduce batch_size
        proportionally to stay within GPU/CPU memory limits.
        """
        base_batch_size = self.settings.batch_size
        # Each beam * best_of combination roughly multiplies memory by that factor
        beam_multiplier = max(1, self.settings.beam_size // 5)  # baseline is beam_size=5
        best_of_multiplier = max(1, self.settings.best_of // 5)
        reduction_factor = beam_multiplier * best_of_multiplier

        # Reduce batch size to prevent OOM, but keep minimum of 1
        effective_batch_size = max(1, base_batch_size // reduction_factor)
        return effective_batch_size

    def _get_model(self):
        if self._model is None:
            with self._lock:
                if self._model is None:
                    # Only a fallback: transcribe() swaps in a PrecomputedVad
                    # carrying the two-tier mask before every decode, so this
                    # configuration never actually gates the ASR pass.
                    vad_options = {
                        "chunk_size": VAD_CHUNK_SIZE,
                        "vad_onset": self.settings.vad_onset,
                        "vad_offset": self.settings.vad_offset,
                    }
                    # Parse temperature fallback ladder
                    temperature_values = [
                        float(t.strip())
                        for t in self.settings.temperature_fallback.split(",")
                        if t.strip()
                    ] if self.settings.temperature_fallback else [0.0]

                    # The deployment-wide glossary. faster-whisper types this
                    # Optional[str] and calls .strip() on it, so it has to be
                    # flattened to one string - a list or dict raises there.
                    # Per-recording terms travel separately, as initial_prompt,
                    # so the same words never cost the 448-token window twice.
                    hotwords_arg = normalize_hotwords(self.settings.hotwords)

                    # ASR options including suppress_numerals (Tier 3b)
                    # These are consumed by faster-whisper's TranscriptionOptions at
                    # load time, not accepted as kwargs on transcribe() itself.
                    #
                    # Caveat worth knowing before tuning any of these: whisperx's
                    # batched pipeline decodes via WhisperModel.generate_segment_batched,
                    # which forwards only beam_size, patience, length_penalty,
                    # suppress_blank, suppress_tokens, no_repeat_ngram_size and
                    # repetition_penalty to ctranslate2 (plus initial_prompt/hotwords via
                    # the prompt, and suppress_numerals, which load_model folds into
                    # suppress_tokens). It never runs faster-whisper's own
                    # transcribe() fallback loop, so best_of, temperatures,
                    # condition_on_previous_text, compression_ratio_threshold,
                    # log_prob_threshold and no_speech_threshold below have no effect
                    # on this path - they are kept because they are the right values
                    # if the pipeline is ever swapped for the unbatched one. That
                    # leaves repetition_penalty and no_repeat_ngram_size as the only
                    # live guards against a decoder repetition loop, which is why
                    # they are set rather than left at whisperx's off-by-default.
                    # word_timestamps is likewise moot: timings come from the
                    # separate alignment stage, not from this decode.
                    asr_options = {
                        "suppress_numerals": self.settings.suppress_numerals,
                        "beam_size": self.settings.beam_size,
                        "best_of": self.settings.best_of,
                        "repetition_penalty": self.settings.repetition_penalty,
                        "no_repeat_ngram_size": self.settings.no_repeat_ngram_size,
                        "temperatures": temperature_values,
                        "condition_on_previous_text": self.settings.condition_on_previous_text,
                        "compression_ratio_threshold": self.settings.compression_ratio_threshold,
                        "log_prob_threshold": self.settings.log_prob_threshold,
                        "no_speech_threshold": self.settings.no_speech_threshold,
                        "word_timestamps": True,
                        "hotwords": hotwords_arg,
                        # Overridden per request in transcribe(); this is only
                        # the default for calls that supply no context.
                        "initial_prompt": self.settings.initial_prompt,
                    }
                    self._model = whisperx.load_model(
                        self.settings.whisper_model,
                        self.device,
                        compute_type=self.compute_type,
                        language=self.settings.default_language,
                        local_files_only=self.settings.local_files_only,
                        download_root=self.settings.model_cache_dir,
                        vad_model=self._get_vad().model,
                        vad_options=vad_options,
                        asr_options=asr_options,
                    )
        return self._model

    def _get_vad(self) -> PyannoteVad:
        """The segmentation model, loaded once and shared.

        The same instance serves both tiers and the pipeline's own VAD slot -
        thresholds are applied to its scores, never baked into it, so there is
        never a reason to hold more than one.
        """
        if self._vad is None:
            with self._vad_lock:
                if self._vad is None:
                    self._vad = PyannoteVad(device=self.device)
        return self._vad

    def _get_align_model(self, language_code: str):
        if language_code not in self._align_models:
            with self._lock:
                if language_code not in self._align_models:
                    self._align_models[language_code] = whisperx.load_align_model(
                        language_code=language_code,
                        device=self.device,
                        model_dir=self.settings.model_cache_dir,
                    )
        return self._align_models[language_code]

    def _get_diarize_model(self):
        if self._diarize_model is None:
            if not self.settings.hf_token:
                raise RuntimeError(
                    "Diarization requires a Hugging Face token. Set WHISPERX_HF_TOKEN in backend/.env "
                    "after accepting the pyannote/speaker-diarization-community-1 model terms on "
                    "huggingface.co."
                )
            with self._lock:
                if self._diarize_model is None:
                    self._diarize_model = DiarizationPipeline(
                        model_name=self.settings.diarization_model,
                        token=self.settings.hf_token,
                        device=self.device,
                        cache_dir=self.settings.model_cache_dir,
                    )
        return self._diarize_model

    def _diarize_with_nemo(self, audio_path: str) -> pd.DataFrame:
        python_path = self.settings.nemo_python_path or str(_NEMO_VENV_PYTHON)
        if not Path(python_path).exists():
            raise RuntimeError(
                f"NeMo venv python not found at {python_path}. Set up backend/.venv-nemo (see README) "
                "or set WHISPERX_NEMO_PYTHON_PATH."
            )

        with tempfile.NamedTemporaryFile(suffix=".json", delete=False) as out_file:
            out_path = out_file.name

        try:
            proc = subprocess.run(
                [
                    python_path,
                    str(_NEMO_SCRIPT),
                    audio_path,
                    out_path,
                    "--model-name",
                    self.settings.nemo_model_name,
                ],
                capture_output=True,
                text=True,
            )
            if proc.returncode != 0:
                raise RuntimeError(f"NeMo diarization failed: {proc.stderr[-2000:]}")
            with open(out_path) as f:
                data = json.load(f)
        finally:
            os.unlink(out_path)

        return pd.DataFrame(data["segments"])

    def _token_counter(self, model):
        """Exact token counting against the loaded model's own vocabulary.

        The pipeline's own `tokenizer` only exists for the duration of a
        transcribe() call (whisperx/asr.py:236, :292), but the underlying
        WhisperModel carries `hf_tokenizer` from load, so the prompt can be
        budgeted before the call rather than guessed at.
        """
        try:
            hf_tokenizer = model.model.hf_tokenizer
        except AttributeError:
            return estimate_tokens

        def count(text: str) -> int:
            return len(hf_tokenizer.encode(text, add_special_tokens=False).ids)

        return count

    def build_prompt(self, context_terms: str | None, context: str | None = None) -> PromptBuild:
        """Budget and assemble the per-recording prompt.

        Lives here rather than in the router because the budget depends on two
        things only the service knows: the loaded model's tokenizer, and how
        much of the window the deployment-wide glossary has already claimed.
        """
        if not (context_terms or "").strip() and not (context or "").strip():
            return PromptBuild(prompt=None)

        model = self._get_model()
        count_tokens = self._token_counter(model)

        hotwords = normalize_hotwords(self.settings.hotwords)
        hotwords_tokens = count_tokens(f" {hotwords}") if hotwords else 0

        return build_initial_prompt(
            context_terms,
            context=context,
            count_tokens=count_tokens,
            budget=prompt_budget(hotwords_tokens=hotwords_tokens),
        )

    def _transcribe_batched(
        self,
        model,
        audio,
        language: str | None,
        initial_prompt: str | None,
        speech: list[Interval],
    ) -> dict:
        """Run the ASR pass over `speech`, optionally under a per-request prompt.

        WhisperX bakes both the ASR options and the VAD into the pipeline at
        load time, and its transcribe() takes neither a prompt nor a speech mask
        as an argument, so both have to be swapped onto the shared pipeline
        around the call. That is exactly what WhisperX does to itself for
        suppress_numerals (whisperx/asr.py:262), and it is safe only while one
        request owns the pipeline - hence the lock, which serialises ASR. That
        costs nothing today: this is a single model on a single device, and the
        call already blocks the caller.

        The prompt reaches every chunk, not just the first: the batched decoder
        prepends it inside generate_segment_batched (whisperx/asr.py:47-50).
        """
        effective_batch_size = self._calculate_batch_size()
        resolved_language = language or self.settings.default_language

        with self._options_lock:
            previous_options = model.options
            previous_vad = model.vad_model
            if initial_prompt:
                model.options = replace(previous_options, initial_prompt=initial_prompt)
            model.vad_model = PrecomputedVad(speech)
            try:
                return model.transcribe(audio, batch_size=effective_batch_size, language=resolved_language)
            finally:
                # Restored even on failure - a leaked prompt would silently
                # condition every later recording on this one's terminology,
                # and a leaked mask would gate it on this one's speech regions.
                model.options = previous_options
                model.vad_model = previous_vad

    def transcribe(
        self,
        audio_path: str,
        language: str | None = None,
        diarize: bool = True,
        min_speakers: int | None = None,
        max_speakers: int | None = None,
        context_terms: str | None = None,
        context: str | None = None,
    ) -> tuple[list[dict], str, dict]:
        prompt_build = self.build_prompt(context_terms, context)
        initial_prompt = prompt_build.prompt or self.settings.initial_prompt

        # Put the hint in range and the right way round before any diarizer sees
        # it. pyannote takes these at face value, so an inverted pair silently
        # produces a worse result than passing nothing.
        bounds = resolve_speaker_bounds(min_speakers, max_speakers)
        for adjustment in bounds.adjustments:
            logger.warning("Speaker-count hint adjusted: %s", adjustment)

        model = self._get_model()
        # Load and resample audio to 16kHz (WhisperX standard)
        # whisperx.load_audio() automatically resamples to 16kHz using librosa
        audio = whisperx.load_audio(audio_path)
        audio_duration_s = len(audio) / SAMPLE_RATE

        # Both tiers, before the recogniser sees anything. The borderline band
        # is transcribed alongside the confident one precisely so that quiet
        # speech is never silently discarded; what it is worth is decided after
        # the fact, by tagging, not by dropping it here.
        tiers = compute_tiers(audio, self.settings, self._get_vad())

        result = self._transcribe_batched(model, audio, language, initial_prompt, tiers.union)
        language_code = result["language"]

        # Alignment-gap counting (Tier 3b)
        alignment_gap_count = 0
        alignment_gap_total_s = 0.0

        try:
            model_a, metadata = self._get_align_model(language_code)
            result = whisperx.align(
                result["segments"], model_a, metadata, audio, self.device, return_char_alignments=False
            )
            # Count alignment gaps (words with missing start/end times)
            for segment in result["segments"]:
                if "words" in segment:
                    for word in segment["words"]:
                        if word.get("start") is None or word.get("end") is None:
                            alignment_gap_count += 1
                            if word.get("start") is not None and word.get("end") is not None:
                                alignment_gap_total_s += word.get("end") - word.get("start")
        except Exception:
            # No alignment model for this language; fall back to the unaligned segments.
            pass

        borderline_word_count, borderline_segment_count = tag_segments(result["segments"], tiers)

        diarization_speaker_count = 0
        diarization_backend = self.settings.diarization_backend or "pyannote"
        # Whether the hint actually reached a diarizer. False when one was given
        # and the active backend can't take it - which is worth reporting rather
        # than letting the caller believe a number they set was honoured.
        speaker_hint_applied = False

        if diarize:
            if self.settings.diarization_backend == "nemo":
                # This Sortformer wrapper takes no speaker-count argument; it
                # always predicts among up to 4 speakers on its own.
                diarize_segments = self._diarize_with_nemo(audio_path)
                if bounds.is_set:
                    logger.warning(
                        "Speaker-count hint (%s) ignored: the nemo backend does not accept one.",
                        bounds.describe(),
                    )
            else:
                diarize_model = self._get_diarize_model()

                # Tier 3c: Clustering threshold tuning (pyannote only)
                # Apply clustering hyperparameters if available
                if (
                    hasattr(diarize_model, "model")
                    and self.settings.diarization_clustering_threshold is not None
                ):
                    try:
                        # Pyannote pipeline supports instantiate() with hyperparameter tuning
                        hyper_params = {
                            "clustering": {
                                "method": "average",
                                "threshold": self.settings.diarization_clustering_threshold,
                            }
                        }
                        if self.settings.diarization_min_cluster_size is not None:
                            hyper_params["clustering"]["min_cluster_size"] = (
                                self.settings.diarization_min_cluster_size
                            )
                        diarize_model.model.instantiate(hyper_params)
                        logger.info(
                            f"Applied clustering threshold {self.settings.diarization_clustering_threshold}"
                        )
                    except Exception as e:
                        logger.warning(
                            f"Could not apply clustering hyperparameters: {e}. "
                            "Using default settings."
                        )

                diarize_segments = diarize_model(
                    audio, min_speakers=bounds.min_speakers, max_speakers=bounds.max_speakers
                )
                speaker_hint_applied = bounds.is_set

            # Non-empty assertion (Tier 3c)
            if len(diarize_segments) == 0:
                raise RuntimeError(
                    "Diarization produced no speaker segments. This may indicate that the audio "
                    "is too short, too quiet, or lacks sufficient speaker overlap for accurate diarization. "
                    "Try with different min_speakers/max_speakers settings, or check that you have accepted "
                    "the speaker-diarization-community-1 model terms on huggingface.co."
                )

            # Tier 3c: Centroid-merge post-pass to fix fragmented speakers
            diarize_segments, merge_pairs = merge_fragmented_speakers(
                diarize_segments,
                cosine_threshold=self.settings.diarization_clustering_threshold or 0.5,
                min_turn_duration=5.0,
            )
            if merge_pairs:
                logger.info(f"Merged {len(merge_pairs)} fragmented speaker pairs")

            result = whisperx.assign_word_speakers(diarize_segments, result)

            # Duration-weighted reconciliation over the speech mask. Masking on
            # the union rather than the confident tier is deliberate: masking on
            # confident would strip the speaker off exactly the borderline words
            # the two-tier pass set out to keep.
            result["segments"] = reconcile_word_speakers(
                result["segments"],
                diarize_segments.to_dict("records"),
                vad_timeline=tiers.union,
            )

            diarization_speaker_count = int(diarize_segments["speaker"].nunique()) if "speaker" in diarize_segments else 0

            # A hint is a hint, not a constraint - clustering can still land
            # outside it. Saying so is the difference between a transcript the
            # user can trust and one they have to re-check by hand.
            if bounds.is_set and diarization_speaker_count and not bounds.contains(diarization_speaker_count):
                logger.warning(
                    "Diarization found %d speakers, outside the requested %s.",
                    diarization_speaker_count,
                    bounds.describe(),
                )

        speaker_numbers: dict[str, int] = {}
        segments = []
        for index, segment in enumerate(result["segments"]):
            raw_speaker = segment.get("speaker")
            segments.append(
                {
                    "id": f"segment-{index}",
                    "start": round(float(segment["start"]), 2),
                    "end": round(float(segment["end"]), 2),
                    "speaker": self._speaker_label(raw_speaker, speaker_numbers),
                    "text": segment["text"].strip(),
                    "vad_borderline": bool(segment.get("vad_borderline")),
                }
            )

        # Build diagnostics dict
        diagnostics = {
            "alignment_gap_count": alignment_gap_count,
            "alignment_gap_total_s": round(alignment_gap_total_s, 2),
            "low_confidence_word_count": 0,  # TODO: Tier 3b - count words with confidence < threshold
            "diarization_backend": diarization_backend,
            "diarization_speaker_count": diarization_speaker_count,
            # What each VAD tier accounted for. The borderline figures are the
            # ones to watch: that audio would have been dropped without trace
            # under a single threshold, so its size is the measure of what the
            # old behaviour was costing.
            "vad_speech_ratio": (
                round(total_duration(tiers.confident) / audio_duration_s, 4)
                if audio_duration_s
                else 0.0
            ),
            "vad_borderline_duration_s": round(total_duration(tiers.borderline), 2),
            "vad_borderline_word_count": borderline_word_count,
            "vad_borderline_segment_count": borderline_segment_count,
            "vad_onset": self.settings.vad_onset,
            "vad_offset": self.settings.vad_offset,
            "vad_borderline_onset": self.settings.vad_borderline_onset,
            "vad_borderline_offset": self.settings.vad_borderline_offset,
            # What the prompt window actually took. Reported rather than
            # guessed at: a term the user typed and that never reached the
            # model is worth saying out loud.
            "context_terms_used": len(prompt_build.used_terms),
            "context_terms_dropped": prompt_build.dropped_terms,
            "context_terms_harvested": prompt_build.harvested_terms,
            "context_prompt_tokens": prompt_build.used_tokens,
            "context_prompt_budget": prompt_build.budget_tokens,
            # The speaker-count hint, end to end: what was asked for after
            # normalisation, whether the backend could take it, and whether the
            # result actually landed inside it.
            "speaker_min_requested": bounds.min_speakers,
            "speaker_max_requested": bounds.max_speakers,
            "speaker_hint_applied": speaker_hint_applied,
            "speaker_hint_adjustments": bounds.adjustments,
            "speaker_count_within_hint": (
                bounds.contains(diarization_speaker_count)
                if bounds.is_set and diarize and diarization_speaker_count
                else None
            ),
        }

        return segments, language_code, diagnostics

    @staticmethod
    def _speaker_label(raw_speaker: str | None, speaker_numbers: dict[str, int]) -> str:
        if not raw_speaker:
            return "Speaker 1"
        if raw_speaker not in speaker_numbers:
            speaker_numbers[raw_speaker] = len(speaker_numbers) + 1
        return f"Speaker {speaker_numbers[raw_speaker]}"


@lru_cache
def get_whisperx_service() -> WhisperXService:
    return WhisperXService(get_settings())
