import logging
from dataclasses import replace
from functools import lru_cache
from threading import Lock

import torch
import whisperx
from whisperx.diarize import DiarizationPipeline

from .config import Settings, get_settings
from .offline import ensure_offline_mode
from .speaker_bounds import resolve_speaker_bounds
from .transcription_prompt import (
    PromptBuild,
    build_initial_prompt,
    estimate_tokens,
    normalize_hotwords,
    prompt_budget,
)

logger = logging.getLogger(__name__)


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
        self._model = None
        self._align_models: dict[str, tuple] = {}
        self._diarize_model = None

    @property
    def is_model_loaded(self) -> bool:
        return self._model is not None

    def _calculate_batch_size(self) -> int:
        """Reduce batch_size as beam_size grows, to stay within memory limits.

        Only beam_size, not best_of - despite both being "beam search"
        settings, best_of never reaches ctranslate2 under whisperx's batched
        decoder (see the asr_options comment in `_get_model`), so scaling
        this by it would shrink the batch for a setting that costs nothing.
        """
        beam_multiplier = max(1, self.settings.beam_size // 5)  # baseline is beam_size=5
        return max(1, self.settings.batch_size // beam_multiplier)

    def _get_model(self):
        if self._model is None:
            with self._lock:
                if self._model is None:
                    # VAD options from settings (Tier 3a: VAD as shared stage)
                    vad_options = {
                        "chunk_size": 30,  # standard VAD chunk size for silero
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
                    # Resolved per load, not once at startup: with no
                    # network reachable this keeps every loader below on the
                    # local cache instead of letting it time out its way there.
                    offline = ensure_offline_mode(self.settings)
                    logger.info(
                        "Loading whisper model %s on %s/%s (cold start - this can take a "
                        "while the first time a model is downloaded)%s",
                        self.settings.whisper_model,
                        self.device,
                        self.compute_type,
                        " [offline: local cache only]" if offline else "",
                    )
                    self._model = whisperx.load_model(
                        self.settings.whisper_model,
                        self.device,
                        compute_type=self.compute_type,
                        language=self.settings.default_language,
                        local_files_only=offline,
                        download_root=self.settings.model_cache_dir,
                        vad_method=self.settings.vad_method,
                        vad_options=vad_options,
                        asr_options=asr_options,
                    )
                    logger.info("Whisper model %s loaded", self.settings.whisper_model)
        return self._model

    def _get_align_model(self, language_code: str):
        if language_code not in self._align_models:
            with self._lock:
                if language_code not in self._align_models:
                    offline = ensure_offline_mode(self.settings)
                    logger.info("Loading alignment model for language=%s", language_code)
                    # The wav2vec2 defaults for en/fr/de/es/it come from
                    # torchaudio, which reads its cache before the network
                    # unprompted; every other language is a transformers
                    # checkpoint, and model_cache_only is what keeps that one
                    # off the hub.
                    self._align_models[language_code] = whisperx.load_align_model(
                        language_code=language_code,
                        device=self.device,
                        model_dir=self.settings.model_cache_dir,
                        model_cache_only=offline,
                    )
                    logger.info("Alignment model for language=%s loaded", language_code)
        return self._align_models[language_code]

    def _require_diarization_token(self) -> None:
        """Diarization's one hard prerequisite, checkable without any compute.

        Kept separate from `_get_diarize_model` so `transcribe` can check it
        before loading audio: the diarizer is only reached after ASR and
        alignment, so a missing token would otherwise surface a minute of GPU
        work too late, and the caller discards the whole result on the raise.
        """
        if not self.settings.hf_token:
            raise RuntimeError(
                "Diarization requires a Hugging Face token. Set WHISPERX_HF_TOKEN in "
                "rag_server/.env after accepting the pyannote/speaker-diarization-community-1 "
                "model terms on huggingface.co."
            )

    def _get_diarize_model(self):
        if self._diarize_model is None:
            self._require_diarization_token()
            with self._lock:
                if self._diarize_model is None:
                    # pyannote's Pipeline.from_pretrained takes no
                    # local_files_only of its own, so the process-wide flag that
                    # ensure_offline_mode sets is the only thing keeping its
                    # config, segmentation and embedding fetches off the network.
                    ensure_offline_mode(self.settings)
                    logger.info("Loading diarization model %s", self.settings.diarization_model)
                    self._diarize_model = DiarizationPipeline(
                        model_name=self.settings.diarization_model,
                        token=self.settings.hf_token,
                        device=self.device,
                        cache_dir=self.settings.model_cache_dir,
                    )
                    logger.info("Diarization model loaded")
        return self._diarize_model

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

    def _transcribe_batched(self, model, audio, language: str | None, initial_prompt: str | None) -> dict:
        """Run the ASR pass, optionally under a per-request initial_prompt.

        WhisperX bakes ASR options into the pipeline at load time and its
        transcribe() takes no prompt argument, so a per-recording prompt has to
        be swapped onto the shared pipeline around the call. That is exactly
        what WhisperX does to itself for suppress_numerals (whisperx/asr.py:262),
        and it is safe only while one request owns the pipeline - hence the lock,
        which serialises ASR. That costs nothing today: this is a single model on
        a single device, and the call already blocks the caller.

        The prompt reaches every chunk, not just the first: the batched decoder
        prepends it inside generate_segment_batched (whisperx/asr.py:47-50).
        """
        effective_batch_size = self._calculate_batch_size()
        resolved_language = language or self.settings.default_language

        if not initial_prompt:
            return model.transcribe(audio, batch_size=effective_batch_size, language=resolved_language)

        with self._options_lock:
            previous_options = model.options
            model.options = replace(previous_options, initial_prompt=initial_prompt)
            try:
                return model.transcribe(audio, batch_size=effective_batch_size, language=resolved_language)
            finally:
                # Restored even on failure - a leaked prompt would silently
                # condition every later recording on this one's terminology.
                model.options = previous_options

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

        if diarize:
            self._require_diarization_token()

        model = self._get_model()
        # Load and resample audio to 16kHz (WhisperX standard)
        # whisperx.load_audio() automatically resamples to 16kHz using librosa
        audio = whisperx.load_audio(audio_path)

        result = self._transcribe_batched(model, audio, language, initial_prompt)
        language_code = result["language"]

        alignment_gap_count = 0
        alignment_gap_total_s = 0.0
        alignment_failed = False

        try:
            model_a, metadata = self._get_align_model(language_code)
            result = whisperx.align(
                result["segments"], model_a, metadata, audio, self.device, return_char_alignments=False
            )
            # Count alignment gaps (words with missing start/end times), and
            # total up the duration only of words that DO have both, so
            # elapsed time never gets attributed to a gap that has none.
            for segment in result["segments"]:
                for word in segment.get("words", []):
                    start, end = word.get("start"), word.get("end")
                    if start is None or end is None:
                        alignment_gap_count += 1
                    else:
                        alignment_gap_total_s += end - start
        except Exception:
            # Timestamps come from this stage - silently keeping the
            # unaligned segments would mean a bad transcript with no trace of
            # why, so this is worth a real log line even though it's handled.
            alignment_failed = True
            logger.exception(
                "Alignment failed for language=%s; falling back to unaligned segment timestamps",
                language_code,
            )

        diarization_speaker_count = 0
        # Whether the hint actually reached the diarizer - worth reporting
        # rather than letting the caller believe a number they set was
        # honoured when clustering could still land outside it regardless.
        speaker_hint_applied = False

        if diarize:
            diarize_model = self._get_diarize_model()

            if (
                hasattr(diarize_model, "model")
                and self.settings.diarization_clustering_threshold is not None
            ):
                try:
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
                        "Applied clustering threshold %s",
                        self.settings.diarization_clustering_threshold,
                    )
                except Exception:
                    logger.exception(
                        "Could not apply clustering hyperparameters; using pipeline defaults"
                    )

            diarize_segments = diarize_model(
                audio, min_speakers=bounds.min_speakers, max_speakers=bounds.max_speakers
            )
            speaker_hint_applied = bounds.is_set

            if len(diarize_segments) == 0:
                raise RuntimeError(
                    "Diarization produced no speaker segments. This may indicate that the audio "
                    "is too short, too quiet, or lacks sufficient speaker overlap for accurate diarization. "
                    "Try with different min_speakers/max_speakers settings, or check that you have accepted "
                    "the speaker-diarization-community-1 model terms on huggingface.co."
                )

            result = whisperx.assign_word_speakers(diarize_segments, result)
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
                }
            )

        # Build diagnostics dict
        diagnostics = {
            "alignment_gap_count": alignment_gap_count,
            "alignment_gap_total_s": round(alignment_gap_total_s, 2),
            "alignment_failed": alignment_failed,
            "diarization_backend": "pyannote",
            "diarization_speaker_count": diarization_speaker_count,
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
