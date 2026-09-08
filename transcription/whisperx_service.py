import copy
import logging
import warnings
from dataclasses import asdict, replace
from functools import lru_cache
from threading import Lock

from pyannote.audio.utils.reproducibility import ReproducibilityWarning

# Both fire on effectively every diarization run and don't indicate a real
# problem (see the RAG server logs): pyannote's own notice that it disabled
# TF32 for reproducibility, and a PyTorch std() warning from pooling over a
# single-sample edge window. Silenced before `import whisperx` below, since
# that's what pulls in pyannote and triggers the first one at import time.
warnings.filterwarnings("ignore", category=ReproducibilityWarning)
warnings.filterwarnings(
    "ignore", message=r".*degrees of freedom is <= 0.*", category=UserWarning
)

import torch
import whisperx
from whisperx.diarize import DiarizationPipeline

from .channels import load_audio_channel, probe_channel_count
from .config import Settings, get_settings
from .offline import ensure_offline_mode
from .recording_profile import UNKNOWN_SPEAKER_LABEL, compute_recording_profile
from .speaker_bounds import SpeakerBounds, resolve_speaker_bounds
from .transcription_prompt import (
    PromptBuild,
    build_initial_prompt,
    estimate_tokens,
    normalize_hotwords,
    pack_hotwords,
    parse_terms,
    prompt_budget,
)

logger = logging.getLogger(__name__)


class NoSpeakerSegments(Exception):
    """Diarization found nothing to label - the recording carries no speech
    it can separate (silent, near-silent, or far too short). A property of
    the file the caller sent, not a fault in this service, so it is mapped
    to a 4xx by the route rather than surfacing as an opaque 500 that reads
    like a server crash."""


# Past this many seconds from the nearest diarization turn, "nearest" is no
# longer meaningful evidence about who's speaking - see
# `WhisperXService._resolve_speaker_assignment`. Illustrative, not calibrated
# against labelled data (same caveat as the recording-profile thresholds).
MAX_NEAREST_FALLBACK_DISTANCE_S = 5.0

# Clustering threshold tried on an automatic diarization retry - see
# `WhisperXService.transcribe`'s retry block. A recording flagged "difficult"
# (see recording_profile.py) most often means clustering merged two real
# speakers together or fragmented one speaker's voice into false splits;
# splitting further is the more common fix of the two, so this leans that
# way rather than trying both directions. Illustrative, not calibrated.
DIFFICULT_RETRY_CLUSTERING_THRESHOLD = 0.48

# Only retry once, ever, per transcription - an unbounded "keep retrying
# until it looks good" loop would turn one slow GPU pass into an unbounded
# number of them for exactly the recordings that already took the longest to
# get through diarization once.
_RETRY_TRIGGER_CLASSIFICATION = "difficult"


def _preview_label(segments: list[dict]) -> list[dict]:
    """Cheap stand-in for the real sequential "Speaker N" renumbering
    (`WhisperXService._speaker_label`), used only to evaluate a diarization
    candidate's recording profile before deciding whether to keep it.
    Substitutes the literal "Unknown" placeholder for unassigned items - so
    `compute_recording_profile`'s speaker_count exclusion sees it correctly -
    without running the real renumbering, which the eventual winning
    candidate still gets from the normal assembly loop in `transcribe`."""
    preview = []
    for segment in segments:
        speaker = (
            UNKNOWN_SPEAKER_LABEL
            if segment.get("_assignment_method") == "unknown"
            else segment.get("speaker")
        )
        words = [
            {
                **word,
                "speaker": (
                    UNKNOWN_SPEAKER_LABEL
                    if word.get("_assignment_method") == "unknown"
                    else word.get("speaker")
                ),
            }
            for word in segment.get("words", [])
        ]
        preview.append({**segment, "speaker": speaker, "words": words})
    return preview


class WhisperXService:
    """Loads whisperx models lazily and caches them across requests."""

    def __init__(self, settings: Settings):
        self.settings = settings
        # Pinned to CUDA - no silent CPU fallback. A GPU-less host used to
        # quietly get a correct-but-far-slower CPU run; failing loudly here
        # instead surfaces a misconfigured/GPU-less deployment immediately,
        # rather than as an unexplained multi-minute transcription later.
        self.device = settings.device or "cuda"
        if self.device == "cuda" and not torch.cuda.is_available():
            raise RuntimeError(
                'WhisperXService is pinned to device="cuda" but torch.cuda.is_available() '
                "is False on this machine - no CUDA GPU was found. Run this service on a "
                "GPU-equipped host, or set WHISPERX_DEVICE=cpu to explicitly opt back into "
                "the (much slower) CPU path."
            )
        # Always float16 - maximum accuracy, and the natural choice now that
        # device is pinned to CUDA (float16 is what the GPU path accelerates;
        # the int8 default this used to fall back to existed only for CPU).
        self.compute_type = settings.compute_type or "float16"

        self._lock = Lock()
        # Distinct from _lock on purpose. _lock is non-reentrant and is held by
        # _get_model(), so a transcribe() that took it and then asked for the
        # model would deadlock. This one guards the per-request mutation of the
        # shared pipeline's options (see transcribe), and nothing else.
        self._options_lock = Lock()
        # Separate from _options_lock: guards the shared diarization pipeline's
        # own runtime mutation (instantiate()) and inference call (see
        # transcribe) - a different shared resource than the ASR model, so a
        # request only waits on another request actually touching diarization,
        # not on an unrelated ASR prompt swap.
        self._diarize_lock = Lock()
        self._model = None
        # Which size string `_model` currently is - None until first load.
        # Exactly one ASR model is ever resident (see _get_model): the whole
        # request path is already serialised through _lock for a single
        # shared pipeline, and holding several loaded large-v3-class models
        # in GPU memory at once is not something this service is sized for.
        self._loaded_model_name: str | None = None
        self._align_models: dict[str, tuple] = {}
        self._diarize_model = None

    def _calculate_batch_size(self) -> int:
        """Reduce batch_size as beam_size grows, to stay within memory limits."""
        beam_multiplier = max(1, self.settings.beam_size // 5)  # baseline is beam_size=5
        return max(1, self.settings.batch_size // beam_multiplier)

    def _get_model(self, model_name: str | None = None):
        resolved_name = model_name or self.settings.whisper_model
        if self._model is None or self._loaded_model_name != resolved_name:
            with self._lock:
                if self._model is None or self._loaded_model_name != resolved_name:
                    if self._model is not None:
                        # Switching sizes: this service holds exactly one ASR
                        # model at a time (see _loaded_model_name), so the
                        # previous one is dropped - not kept alongside - before
                        # loading the new one, freeing its GPU/CPU memory first
                        # rather than risking both resident simultaneously.
                        logger.info(
                            "Releasing whisper model %s to load %s instead",
                            self._loaded_model_name,
                            resolved_name,
                        )
                        self._model = None
                        if self.device == "cuda":
                            torch.cuda.empty_cache()
                    # VAD options from settings (Tier 3a: VAD as shared stage)
                    vad_options = {
                        "chunk_size": 30,  # standard VAD chunk size for silero
                        "vad_onset": self.settings.vad_onset,
                        "vad_offset": self.settings.vad_offset,
                    }
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
                    # Only what whisperx's batched pipeline actually reads:
                    # WhisperModel.generate_segment_batched forwards beam_size,
                    # patience, length_penalty, suppress_blank, suppress_tokens,
                    # no_repeat_ngram_size and repetition_penalty to ctranslate2
                    # (plus initial_prompt/hotwords via the prompt, and
                    # suppress_numerals, which load_model folds into
                    # suppress_tokens). It never runs faster-whisper's own
                    # transcribe() fallback loop, so best_of, temperatures,
                    # condition_on_previous_text, compression_ratio_threshold,
                    # log_prob_threshold and no_speech_threshold configured nothing
                    # on this path and were removed rather than left as dead
                    # settings someone would reasonably expect to do something.
                    # If the pipeline is ever swapped for the unbatched one,
                    # they're worth reintroducing with faster-whisper's own
                    # defaults. word_timestamps is likewise moot here: timings
                    # come from the separate alignment stage, not this decode.
                    asr_options = {
                        "suppress_numerals": self.settings.suppress_numerals,
                        "beam_size": self.settings.beam_size,
                        "repetition_penalty": self.settings.repetition_penalty,
                        "no_repeat_ngram_size": self.settings.no_repeat_ngram_size,
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
                        resolved_name,
                        self.device,
                        self.compute_type,
                        " [offline: local cache only]" if offline else "",
                    )
                    self._model = whisperx.load_model(
                        resolved_name,
                        self.device,
                        compute_type=self.compute_type,
                        language=self.settings.default_language,
                        local_files_only=offline,
                        download_root=self.settings.model_cache_dir,
                        vad_method=self.settings.vad_method,
                        vad_options=vad_options,
                        asr_options=asr_options,
                    )
                    self._loaded_model_name = resolved_name
                    logger.info("Whisper model %s loaded", resolved_name)
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

    def build_prompt(
        self, context_terms: str | None, context: str | None = None, model_name: str | None = None
    ) -> PromptBuild:
        """Budget and assemble the per-recording prompt.

        Lives here rather than in the router because the budget depends on two
        things only the service knows: the loaded model's tokenizer, and how
        much of the window the deployment-wide glossary has already claimed.

        `model_name` must match whatever `transcribe()` is about to request for
        the same call - passing a different (or no) name would tokenize the
        budget against the wrong model, and worse, load it just to immediately
        evict it in favor of the real one (see `_get_model`).
        """
        if not (context_terms or "").strip() and not (context or "").strip():
            return PromptBuild(prompt=None)

        model = self._get_model(model_name)
        count_tokens = self._token_counter(model)

        hotwords = normalize_hotwords(self.settings.hotwords)
        hotwords_tokens = count_tokens(f" {hotwords}") if hotwords else 0

        return build_initial_prompt(
            context_terms,
            context=context,
            count_tokens=count_tokens,
            budget=prompt_budget(hotwords_tokens=hotwords_tokens),
        )

    def _build_request_hotwords(self, model, used_terms: list[str]) -> str | None:
        """Give this request's confirmed terms the same decode-time boost the
        deployment-wide glossary gets, not just `initial_prompt`'s softer
        conditioning.

        Experimental (see `transcribe`'s docstring note): faster-whisper
        documents `hotwords` as a more direct decode-time bias than
        `initial_prompt`. This deliberately duplicates whatever
        `build_prompt` already packed into `initial_prompt` (`used_terms`)
        into this channel too, layered on top of the deployment glossary -
        to test whether a model that under-weights `initial_prompt` still
        honours the same terms when boosted this way instead. The deployment
        glossary is kept first (it is curated once and applies to every
        recording); confirmed terms fill whatever room is left under
        faster-whisper's own per-part cap.

        This deliberately breaks the "same words never cost the window
        twice" invariant `_get_model`'s comment describes for the deployment
        glossary: a term can now occupy both `hotwords` and `initial_prompt`
        at once. Accepted for this experiment since confirmed lists are
        typically a handful of names, not the full 223-token cap either
        channel allows.
        """
        deployment_terms = parse_terms(normalize_hotwords(self.settings.hotwords))
        if not used_terms:
            return ", ".join(deployment_terms) if deployment_terms else None

        seen = {term.casefold() for term in deployment_terms}
        combined = [*deployment_terms, *(term for term in used_terms if term.casefold() not in seen)]
        return pack_hotwords(combined, self._token_counter(model))

    def _transcribe_batched(
        self,
        model,
        audio,
        language: str | None,
        initial_prompt: str | None,
        hotwords: str | None,
        suppress_numerals: bool,
    ) -> dict:
        """Run the ASR pass, optionally under a per-request initial_prompt
        and/or hotwords.

        WhisperX bakes ASR options into the pipeline at load time and its
        transcribe() takes no prompt argument, so a per-recording prompt has to
        be swapped onto the shared pipeline around the call. That is exactly
        what WhisperX does to itself for suppress_numerals (whisperx/asr.py:262),
        and it is safe only while one request owns the pipeline - hence the lock,
        which serialises ASR. That costs nothing today: this is a single model on
        a single device, and the call already blocks the caller.

        The lock is held for every call here, not only ones that set their own
        prompt: a request with no prompt of its own used to skip it entirely and
        read model.options straight off the shared model - which, mid-mutation
        by a concurrent request that DOES have a prompt, could hand this request
        someone else's prompt (names, jargon, whatever that other recording's
        context carried) contaminating a transcript that asked for none of it.
        Skipping straight to model.transcribe() is only actually safe when
        nothing else can be touching model.options at the same moment, which the
        previous fast path didn't establish. `hotwords` carries the same risk
        (a leaked, request-specific hotwords list boosting the wrong recording's
        terms), so it is restored in the same `finally` block as `initial_prompt`.

        The prompt reaches every chunk, not just the first: the batched decoder
        prepends it inside generate_segment_batched (whisperx/asr.py:47-50).
        """
        effective_batch_size = self._calculate_batch_size()
        resolved_language = language or self.settings.default_language

        with self._options_lock:
            previous_options = model.options
            # A plain pipeline attribute (whisperx/asr.py:131), read by both the
            # apply and revert branches inside transcribe() - so it is only safe
            # to move around the whole call, never during it.
            previous_suppress = model.suppress_numerals
            overrides = {}
            if initial_prompt:
                overrides["initial_prompt"] = initial_prompt
            if hotwords:
                overrides["hotwords"] = hotwords
            if overrides:
                model.options = replace(previous_options, **overrides)
            model.suppress_numerals = suppress_numerals
            try:
                return model.transcribe(audio, batch_size=effective_batch_size, language=resolved_language)
            finally:
                # Restored even on failure - a leaked prompt would silently
                # condition every later recording on this one's terminology,
                # and a leaked numeral setting would silently spell out digits
                # in a recording that asked for them.
                model.options = previous_options
                model.suppress_numerals = previous_suppress

    def _asr_and_align(
        self,
        whisper_model,
        audio,
        language: str | None,
        initial_prompt: str | None,
        request_hotwords: str | None,
        suppress_numerals: bool,
    ) -> tuple[list[dict], str, int, float, bool]:
        """ASR + forced alignment for one mono audio stream - the same two
        steps `transcribe` runs once for the whole recording, factored out so
        channel-split mode can run them once per channel instead."""
        result = self._transcribe_batched(
            whisper_model, audio, language, initial_prompt, request_hotwords, suppress_numerals
        )
        language_code = result["language"]

        alignment_gap_count = 0
        alignment_gap_total_s = 0.0
        alignment_failed = False
        try:
            model_a, metadata = self._get_align_model(language_code)
            result = whisperx.align(
                result["segments"], model_a, metadata, audio, self.device, return_char_alignments=False
            )
            for segment in result["segments"]:
                for word in segment.get("words", []):
                    start, end = word.get("start"), word.get("end")
                    if start is None or end is None:
                        alignment_gap_count += 1
                    else:
                        alignment_gap_total_s += end - start
        except Exception:
            alignment_failed = True
            logger.exception(
                "Alignment failed for language=%s; falling back to unaligned segment timestamps",
                language_code,
            )

        return result["segments"], language_code, alignment_gap_count, alignment_gap_total_s, alignment_failed

    def _run_diarization(
        self,
        audio,
        asr_segments: list[dict],
        bounds: SpeakerBounds,
        clustering_threshold: float | None,
    ) -> dict:
        """One full diarize-and-assign pass over already-transcribed+aligned
        `asr_segments`, clustering at `clustering_threshold`. Never mutates
        `asr_segments` itself - works on a deep copy, so calling this twice
        with different thresholds (see the retry block in `transcribe`)
        never lets one attempt's speaker assignments leak into the other's.

        Returns a dict with `segments` (assignment-resolved, not yet
        renumbered into "Speaker N" - see `_preview_label`/the real assembly
        loop in `transcribe`), `diarization_turns`, `speaker_embeddings`, and
        `diarization_speaker_count`.
        """
        segments = copy.deepcopy(asr_segments)
        diarize_model = self._get_diarize_model()

        # Serialises every use of the shared diarization pipeline the same
        # way _options_lock serialises the shared ASR model: instantiate()
        # below mutates the pipeline's clustering hyperparameters in place,
        # and the inference call right after reads them - two concurrent
        # /transcribe requests interleaving those two steps on the same
        # cached pipeline object (see _get_diarize_model) would otherwise
        # run one request's diarization under hyperparameters meant for a
        # different request, or race the underlying model's internal state
        # outright. Nothing upstream of this serialises it: FastAPI runs
        # each /transcribe call in its own threadpool thread.
        with self._diarize_lock:
            if hasattr(diarize_model, "model"):
                requested_threshold = (
                    clustering_threshold
                    if clustering_threshold is not None
                    else self.settings.diarization_clustering_threshold
                )
                try:
                    # pyannote.audio 4.x's clustering step is VBx-based, not
                    # the AgglomerativeClustering it was pre-4.0: `method`
                    # and `min_cluster_size` were never valid parameter names
                    # on this version - passing them (as this used to) made
                    # instantiate() raise on every call, silently caught
                    # below, so this tuning knob was a guaranteed no-op
                    # regardless of what was configured. Confirmed against
                    # the installed pipeline's own model.default_parameters().
                    threshold_to_apply = (
                        requested_threshold
                        if requested_threshold is not None
                        else diarize_model.model.default_parameters()["clustering"]["threshold"]
                    )
                    diarize_model.model.instantiate({"clustering": {"threshold": threshold_to_apply}})
                    if requested_threshold is not None:
                        logger.info("Applied clustering threshold %s", requested_threshold)
                except Exception:
                    logger.exception(
                        "Could not apply clustering hyperparameters; using pipeline defaults"
                    )

            # return_embeddings=True costs nothing extra - Community-1 already
            # computes per-cluster embeddings as part of its own clustering
            # step; this just asks the pipeline to hand them back instead of
            # discarding them.
            if bounds.min_speakers is not None and bounds.min_speakers == bounds.max_speakers:
                # An exact count forces pyannote's clustering to cut into
                # precisely that many groups. An equal min/max pair instead
                # still runs its threshold-based count *estimation* and only
                # clamps the result afterward - a different, less direct path
                # even though the number given is identical.
                diarize_segments, speaker_embeddings = diarize_model(
                    audio, num_speakers=bounds.min_speakers, return_embeddings=True
                )
            else:
                diarize_segments, speaker_embeddings = diarize_model(
                    audio,
                    min_speakers=bounds.min_speakers,
                    max_speakers=bounds.max_speakers,
                    return_embeddings=True,
                )

        if len(diarize_segments) == 0:
            raise NoSpeakerSegments(
                "No speech could be detected in this recording, so there are no speakers "
                "to label. This usually means the audio is silent, too quiet, or too short. "
                "Check that the file actually contains audible speech - if it does, try "
                "setting min_speakers/max_speakers explicitly."
            )

        # The raw ground truth everything else here is derived from -
        # captured before assign_word_speakers touches anything, and kept in
        # the diarization-detail record (never the plain transcript) so "why
        # did this word get this speaker" is answerable later instead of
        # only "because the transcript says so."
        diarization_turns = [
            {"start": float(row["start"]), "end": float(row["end"]), "speaker": str(row["speaker"])}
            for row in diarize_segments[["start", "end", "speaker"]].to_dict("records")
        ]

        # fill_nearest=False, deliberately - see _resolve_speaker_assignment
        # for why the library's own unconditional "nearest speaker, no
        # matter how far away" fallback is not used here.
        result = whisperx.assign_word_speakers(diarize_segments, {"segments": segments}, fill_nearest=False)
        diarization_speaker_count = (
            int(diarize_segments["speaker"].nunique()) if "speaker" in diarize_segments else 0
        )

        for segment in result["segments"]:
            self._resolve_speaker_assignment(segment, diarization_turns)
            for word in segment.get("words", []):
                self._resolve_speaker_assignment(word, diarization_turns)

        return {
            "segments": result["segments"],
            "diarization_turns": diarization_turns,
            "speaker_embeddings": speaker_embeddings,
            "diarization_speaker_count": diarization_speaker_count,
        }

    def transcribe(
        self,
        audio_path: str,
        language: str | None = None,
        diarize: bool = True,
        min_speakers: int | None = None,
        max_speakers: int | None = None,
        clustering_threshold: float | None = None,
        context_terms: str | None = None,
        context: str | None = None,
        model: str | None = None,
        suppress_numerals: bool | None = None,
        channel_split: bool = False,
    ) -> tuple[list[dict], str, dict, list[dict], dict[str, list[float]] | None, dict]:
        prompt_build = self.build_prompt(context_terms, context, model_name=model)
        # Experimental: also boost this recording's confirmed terms through
        # hotwords, not just initial_prompt - see _build_request_hotwords.
        request_hotwords = self._build_request_hotwords(
            self._get_model(model), prompt_build.used_terms
        )
        # initial_prompt always carries at least the same terms as
        # `hotwords` when nothing more specific was built for this request:
        # large-v3 and large-v3-turbo have each been observed to silently
        # under-weight one of these two channels, so neither is left empty
        # while the other has content - whichever channel a given model
        # actually honours, the UI-configured terms still reach it.
        initial_prompt = prompt_build.prompt or self.settings.initial_prompt or request_hotwords

        # Put the hint in range and the right way round before any diarizer sees
        # it. pyannote takes these at face value, so an inverted pair silently
        # produces a worse result than passing nothing.
        bounds = resolve_speaker_bounds(min_speakers, max_speakers)
        for adjustment in bounds.adjustments:
            logger.warning("Speaker-count hint adjusted: %s", adjustment)

        # Channel-split mode replaces pyannote outright (see below), so it
        # never needs the token pyannote requires.
        if diarize and not channel_split:
            self._require_diarization_token()

        # Resolved the same way _get_model resolves it, so the diagnostics
        # report the model that actually ran rather than the caller's
        # possibly-absent request.
        resolved_model = model or self.settings.whisper_model
        # Digits are suppressed at the decoder, not merely discouraged
        # (whisperx/asr.py:256-262), so a caller that needs numerals in the
        # transcript has to say so before the decode - nothing downstream can
        # recover a token the decoder was forbidden to emit.
        resolved_suppress_numerals = (
            self.settings.suppress_numerals if suppress_numerals is None else suppress_numerals
        )
        logger.info(
            "Transcribing with whisper model %s (requested: %s), hotwords_terms=%d",
            resolved_model,
            model or "auto",
            len(parse_terms(request_hotwords)) if request_hotwords else 0,
        )
        whisper_model = self._get_model(model)

        diarization_speaker_count = 0
        # Whether the hint actually reached the diarizer - worth reporting
        # rather than letting the caller believe a number they set was
        # honoured when clustering could still land outside it regardless.
        speaker_hint_applied = False
        diarization_backend = "pyannote"

        if channel_split:
            # The recording already tells you who's who - no clustering
            # needed. Each channel is decoded and transcribed on its own
            # (whisperx.load_audio's downmix would otherwise erase exactly
            # the separation this mode exists to use), and the per-channel
            # results are merged back into one timeline afterward.
            channel_count = probe_channel_count(audio_path)
            if channel_count < 2:
                raise RuntimeError(
                    "Channel-based speaker separation requires an audio file with at least 2 "
                    f"channels; this file has {channel_count}."
                )

            language_code: str | None = None
            alignment_gap_count = 0
            alignment_gap_total_s = 0.0
            alignment_failed = False
            channel_segments: list[dict] = []

            for channel_index in range(channel_count):
                channel_audio = load_audio_channel(audio_path, channel_index)
                segs, channel_language, gap_count, gap_total, failed = self._asr_and_align(
                    whisper_model,
                    channel_audio,
                    language,
                    initial_prompt,
                    request_hotwords,
                    resolved_suppress_numerals,
                )
                language_code = language_code or channel_language
                alignment_gap_count += gap_count
                alignment_gap_total_s += gap_total
                alignment_failed = alignment_failed or failed
                for segment in segs:
                    # A channel index, not a pyannote label, but consumed by
                    # the exact same _speaker_label numbering below - the
                    # rest of the pipeline never needs to know which strategy
                    # produced these ids.
                    segment["speaker"] = f"CHANNEL_{channel_index}"
                    segment["_assignment_method"] = "channel_split"
                    segment["_assignment_distance_s"] = None
                    for word in segment.get("words", []):
                        word["speaker"] = segment["speaker"]
                        word["_assignment_method"] = "channel_split"
                        word["_assignment_distance_s"] = None
                channel_segments.extend(segs)

            # Interleaved by who spoke when, not grouped by channel - a
            # transcript is read in time order regardless of how the
            # speakers were separated.
            channel_segments.sort(key=lambda segment: segment["start"])
            result = {"segments": channel_segments}
            diarization_speaker_count = channel_count
            diarization_backend = "channel_split"
            # No pyannote involved in this mode - nothing to report at either.
            diarization_turns: list[dict] = []
            speaker_embeddings: dict[str, list[float]] | None = None
            diarization_retry_diagnostics: dict = {
                "attempted": False,
                "kept": None,
                "threshold": None,
                "original_suspicious_ratio": None,
                "retry_suspicious_ratio": None,
            }
        else:
            # Load and resample audio to 16kHz (WhisperX standard)
            # whisperx.load_audio() automatically resamples to 16kHz using librosa
            audio = whisperx.load_audio(audio_path)

            (
                asr_segments,
                language_code,
                alignment_gap_count,
                alignment_gap_total_s,
                alignment_failed,
            ) = self._asr_and_align(
                whisper_model, audio, language, initial_prompt, request_hotwords, resolved_suppress_numerals
            )
            result = {"segments": asr_segments}
            diarization_turns: list[dict] = []
            speaker_embeddings: dict[str, list[float]] | None = None
            # Default for every segment/word when diarize=False (no turns to
            # classify against at all) - overwritten below when diarize=True.
            for segment in result["segments"]:
                segment["_assignment_method"] = "none"
                segment["_assignment_distance_s"] = None
                for word in segment.get("words", []):
                    word["_assignment_method"] = "none"
                    word["_assignment_distance_s"] = None

            diarization_retry_diagnostics: dict = {
                "attempted": False,
                "kept": None,
                "threshold": None,
                "original_suspicious_ratio": None,
                "retry_suspicious_ratio": None,
            }

            if diarize:
                diarize_result = self._run_diarization(audio, asr_segments, bounds, clustering_threshold)
                speaker_hint_applied = bounds.is_set

                # Selective retry: a "difficult" first pass most often means
                # clustering merged two real speakers together or fragmented
                # one voice into false splits. One automatic retry at a
                # different threshold either measurably reduces the
                # suspicious-segment ratio (kept) or it doesn't (discarded,
                # original result stands) - never more than one retry, and
                # never for a recording that wasn't flagged difficult in the
                # first place. See DIFFICULT_RETRY_CLUSTERING_THRESHOLD.
                initial_profile = compute_recording_profile(
                    _preview_label(diarize_result["segments"]), diarize_result["diarization_turns"]
                )
                already_at_retry_threshold = (
                    clustering_threshold is not None
                    and abs(clustering_threshold - DIFFICULT_RETRY_CLUSTERING_THRESHOLD) < 1e-6
                )
                if (
                    initial_profile.classification == _RETRY_TRIGGER_CLASSIFICATION
                    and not already_at_retry_threshold
                ):
                    diarization_retry_diagnostics["attempted"] = True
                    diarization_retry_diagnostics["threshold"] = DIFFICULT_RETRY_CLUSTERING_THRESHOLD
                    diarization_retry_diagnostics["original_suspicious_ratio"] = (
                        initial_profile.suspicious_segment_ratio
                    )
                    try:
                        retry_result = self._run_diarization(
                            audio, asr_segments, bounds, DIFFICULT_RETRY_CLUSTERING_THRESHOLD
                        )
                        retry_profile = compute_recording_profile(
                            _preview_label(retry_result["segments"]), retry_result["diarization_turns"]
                        )
                        diarization_retry_diagnostics["retry_suspicious_ratio"] = (
                            retry_profile.suspicious_segment_ratio
                        )
                        if retry_profile.suspicious_segment_ratio < initial_profile.suspicious_segment_ratio:
                            diarize_result = retry_result
                            diarization_retry_diagnostics["kept"] = "retry"
                            logger.info(
                                "Diarization retry (threshold=%.2f) improved suspicious_segment_ratio "
                                "%.4f -> %.4f; keeping retry.",
                                DIFFICULT_RETRY_CLUSTERING_THRESHOLD,
                                initial_profile.suspicious_segment_ratio,
                                retry_profile.suspicious_segment_ratio,
                            )
                        else:
                            diarization_retry_diagnostics["kept"] = "original"
                            logger.info(
                                "Diarization retry (threshold=%.2f) did not improve suspicious_segment_ratio "
                                "(retry=%.4f vs original=%.4f); keeping original.",
                                DIFFICULT_RETRY_CLUSTERING_THRESHOLD,
                                retry_profile.suspicious_segment_ratio,
                                initial_profile.suspicious_segment_ratio,
                            )
                    except Exception:
                        logger.exception("Diarization retry failed; keeping original result")
                        diarization_retry_diagnostics["kept"] = "original"
                        diarization_retry_diagnostics["error"] = True

                result = {"segments": diarize_result["segments"]}
                diarization_turns = diarize_result["diarization_turns"]
                speaker_embeddings = diarize_result["speaker_embeddings"]
                diarization_speaker_count = diarize_result["diarization_speaker_count"]

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
            # Segment's own label resolved first, before any of its words -
            # numbering order stays exactly what it was before this change
            # (segment-appearance order) unless a word's raw speaker never
            # appears as any segment's own speaker, which is itself the kind
            # of disagreement this whole record exists to make visible.
            # "unknown" bypasses the numbered sequence entirely - it isn't a
            # distinct speaker, it's "no evidence was close enough to trust",
            # and numbering it would falsely imply otherwise.
            raw_speaker = segment.get("speaker")
            speaker_label = (
                UNKNOWN_SPEAKER_LABEL
                if segment.get("_assignment_method") == "unknown"
                else self._speaker_label(raw_speaker, speaker_numbers)
            )

            words = []
            for word in segment.get("words", []):
                raw_word_speaker = word.get("speaker")
                if word.get("_assignment_method") == "unknown":
                    word_speaker_label = UNKNOWN_SPEAKER_LABEL
                elif raw_word_speaker is not None:
                    word_speaker_label = self._speaker_label(raw_word_speaker, speaker_numbers)
                else:
                    word_speaker_label = None
                words.append(
                    {
                        "word": (word.get("word") or "").strip(),
                        "start": word.get("start"),
                        "end": word.get("end"),
                        "speaker": word_speaker_label,
                        "assignment_method": word.get("_assignment_method", "none"),
                        "assignment_distance_s": word.get("_assignment_distance_s"),
                    }
                )

            segments.append(
                {
                    "id": f"segment-{index}",
                    "start": round(float(segment["start"]), 2),
                    "end": round(float(segment["end"]), 2),
                    "speaker": speaker_label,
                    "text": segment["text"].strip(),
                    "assignment_method": segment.get("_assignment_method", "none"),
                    "assignment_distance_s": segment.get("_assignment_distance_s"),
                    "words": words,
                }
            )

        # Raw pyannote/channel id -> this transcript's renumbered label, so a
        # raw turn or embedding (both keyed by the raw id) can be traced back
        # to what the transcript actually displays for it.
        speaker_label_map = {
            raw_id: f"Speaker {number}" for raw_id, number in speaker_numbers.items()
        }

        # Build diagnostics dict
        diagnostics = {
            "alignment_gap_count": alignment_gap_count,
            "alignment_gap_total_s": round(alignment_gap_total_s, 2),
            "alignment_failed": alignment_failed,
            "diarization_backend": diarization_backend,
            "diarization_speaker_count": diarization_speaker_count,
            "channel_split_applied": channel_split,
            "model_requested": model,
            "model_used": resolved_model,
            "suppress_numerals": resolved_suppress_numerals,
            # What the prompt window actually took. Reported rather than
            # guessed at: a term the user typed and that never reached the
            # model is worth saying out loud.
            "context_terms_used": len(prompt_build.used_terms),
            "context_terms_dropped": prompt_build.dropped_terms,
            "context_terms_harvested": prompt_build.harvested_terms,
            "context_prompt_tokens": prompt_build.used_tokens,
            "context_prompt_budget": prompt_build.budget_tokens,
            # Whether this recording's confirmed terms also reached the
            # decoder via hotwords, not just initial_prompt - see
            # _build_request_hotwords. Total term count in the combined
            # hotwords sent (deployment glossary + this recording's terms),
            # so a term the confirmed list expected there but that got
            # dropped for want of room is visible here too.
            "hotwords_term_count": len(parse_terms(request_hotwords)) if request_hotwords else 0,
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
            "speaker_label_map": speaker_label_map,
            # Whether an automatic diarization retry (a different clustering
            # threshold) ran because the first pass looked "difficult", and
            # whether it was actually kept - see DIFFICULT_RETRY_CLUSTERING_THRESHOLD.
            "diarization_retry_attempted": diarization_retry_diagnostics["attempted"],
            "diarization_retry_kept": diarization_retry_diagnostics["kept"],
            "diarization_retry_threshold": diarization_retry_diagnostics["threshold"],
            "diarization_original_suspicious_ratio": diarization_retry_diagnostics["original_suspicious_ratio"],
            "diarization_retry_suspicious_ratio": diarization_retry_diagnostics["retry_suspicious_ratio"],
        }

        recording_profile = asdict(compute_recording_profile(segments, diarization_turns))

        return segments, language_code, diagnostics, diarization_turns, speaker_embeddings, recording_profile

    @staticmethod
    def _speaker_label(raw_speaker: str | None, speaker_numbers: dict[str, int]) -> str:
        if not raw_speaker:
            return "Speaker 1"
        if raw_speaker not in speaker_numbers:
            speaker_numbers[raw_speaker] = len(speaker_numbers) + 1
        return f"Speaker {speaker_numbers[raw_speaker]}"

    @staticmethod
    def _nearest_turn(
        diarization_turns: list[dict], start: float, end: float
    ) -> tuple[str | None, float]:
        """The closest raw diarization turn to [start, end] by gap (0 if it
        actually overlaps, which shouldn't happen for a caller of this - see
        `_resolve_speaker_assignment`), and that gap in seconds. `(None,
        inf)` when there are no turns at all."""
        best_speaker: str | None = None
        best_distance = float("inf")
        for turn in diarization_turns:
            if turn["end"] <= start:
                distance = start - turn["end"]
            elif turn["start"] >= end:
                distance = turn["start"] - end
            else:
                distance = 0.0
            if distance < best_distance:
                best_distance = distance
                best_speaker = turn["speaker"]
        return best_speaker, best_distance

    @staticmethod
    def _resolve_speaker_assignment(item: dict, diarization_turns: list[dict]) -> None:
        """Mutates `item` (a segment or word dict) in place, adding
        `_assignment_method` and `_assignment_distance_s`. Called after
        `assign_word_speakers(..., fill_nearest=False)`, so `item["speaker"]`
        already reflects a real overlap match when one exists - this only
        resolves what's left unset.

        Deliberately does NOT use `fill_nearest=True`'s unconditional
        nearest-speaker fallback (no matter how far away): past
        `MAX_NEAREST_FALLBACK_DISTANCE_S`, the nearest turn is no longer
        meaningful evidence about who's actually speaking, and confidently
        assigning it anyway is exactly the "silently attributed to the wrong
        person" failure mode a forensic transcript can least afford. Beyond
        that distance, `item["speaker"]` is left unset - the caller renders
        that as "Unknown" - rather than guessing.
        """
        start = item.get("start")
        end = item.get("end", start)
        if item.get("speaker") is not None:
            item["_assignment_method"] = "overlap"
            item["_assignment_distance_s"] = 0.0
            return
        if start is None:
            item["_assignment_method"] = "none"
            item["_assignment_distance_s"] = None
            return
        nearest_speaker, distance = WhisperXService._nearest_turn(
            diarization_turns, start, end if end is not None else start
        )
        if nearest_speaker is not None and distance <= MAX_NEAREST_FALLBACK_DISTANCE_S:
            item["speaker"] = nearest_speaker
            item["_assignment_method"] = "nearest"
            item["_assignment_distance_s"] = round(distance, 2)
        else:
            item["_assignment_method"] = "unknown"
            item["_assignment_distance_s"] = round(distance, 2) if nearest_speaker is not None else None


@lru_cache
def get_whisperx_service() -> WhisperXService:
    return WhisperXService(get_settings())
