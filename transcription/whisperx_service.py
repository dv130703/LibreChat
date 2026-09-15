import copy
import logging
import re
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

# Lightning's "automatically upgraded your loaded checkpoint from v1.5.4 to
# v2.6.5" notice, repeated on every VAD/diarization model load. It is not a
# warnings.warn - it is logged - so filterwarnings cannot reach it, hence the
# logger-level suppression here.
#
# Nothing is wrong: it reports that a checkpoint shipped inside whisperx was
# migrated in memory on load. The permanent fix it suggests
# (`upgrade_checkpoint` on the bundled pytorch_model.bin) rewrites a file
# inside site-packages, which any reinstall would undo - so the notice is
# silenced rather than acted on.
logging.getLogger("lightning.pytorch.utilities.migration.utils").setLevel(logging.WARNING)
logging.getLogger("pytorch_lightning.utilities.migration.utils").setLevel(logging.WARNING)

import numpy as np
import pandas as pd
import torch
import whisperx
from whisperx.diarize import DiarizationPipeline, Segment as SegmentX
from whisperx.vads import Vad

from .channels import load_audio_channel, probe_channel_count
from .config import Settings, get_settings
from .offline import ensure_offline_mode
from .recording_profile import UNKNOWN_SPEAKER_LABEL, compute_recording_profile
from .speaker_count import (
    MAX_ALLOWED_SPEAKERS,
    MIN_ALLOWED_SPEAKERS,
    SpeakerCountHint,
    resolve_speaker_count,
)
from .transcription_prompt import (
    PromptBuild,
    build_initial_prompt,
    estimate_tokens,
    normalize_hotwords,
    pack_hotwords,
    parse_terms,
    prompt_budget,
)
from .vad import PyannoteVad
from .vad_tiers import SAMPLE_RATE, Interval, VadTiers, compute_tiers, tag_segments, total_duration

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

# Boundaries used to break one speaker's continuous speech into readable
# lines - see `WhisperXService._split_into_runs`. Grouping by speaker alone
# produced 250-second single-paragraph lines on real interview audio, because
# holding the floor for minutes is normal and says nothing about where a line
# should end.
#
# The pause threshold is the one value here with direct empirical support:
# against a 3-hour interview's own word timings, inter-word gaps sat at ~0.04s
# median and ~0.94s p95, so a gap at or past this is a real beat rather than
# ordinary spacing. The length caps are readability choices (roughly a
# paragraph), not measured quantities.
SEGMENT_SPLIT_PAUSE_S = 1.5
MAX_SEGMENT_DURATION_S = 45.0
MAX_SEGMENT_WORDS = 120

# How far past the soft limits a run may grow while waiting for a sentence to
# end, before it is broken mid-sentence regardless. Without this, speech with
# no detected sentence punctuation would ignore the caps entirely.
SEGMENT_HARD_CAP_FACTOR = 2.0

SENTENCE_END_PATTERN = re.compile(r"[.?!…][\"'”’)\]]*$")

# Diarization is clustered GLOBALLY over whatever audio it is handed, and that
# is what makes a long recording fail: over 3.7 hours of a four-person forensic
# interview, a participant who speaks for only ~2 minutes (a lawyer introducing
# himself) is absorbed into whichever large cluster he most resembles, so his
# lines are attributed to the interviewer and the transcript reads as one
# person asking and answering their own questions.
#
# Measured on that recording, holding everything else fixed and varying only
# how much audio was clustered at once (interviewer / interviewee's name /
# lawyer, all three of which must land on different speakers):
#
#     2 min  + num_speakers -> separated
#     5 min  + num_speakers -> separated
#     10 min + num_speakers -> merged
#     20 min + num_speakers -> merged
#     30 min + num_speakers -> merged
#     full file             -> merged
#
# So the audio is diarized in windows this long and the per-window speakers are
# stitched back together by comparing the embedding pyannote returns for each
# one. 0 disables windowing and restores the single global pass.
DIARIZATION_WINDOW_S = 300.0

# Windows overlap so a turn spanning a boundary is seen whole by at least one
# window, and so consecutive windows share speech to anchor their speakers to
# each other.
DIARIZATION_WINDOW_OVERLAP_S = 30.0

# Cosine similarity at which a window-local speaker is considered the same
# person as an already-seen global speaker. Illustrative, not calibrated:
# measured embeddings of two clusters that were genuinely the same voice sat at
# 0.957, and clearly different voices at 0.10-0.30, so the gap either side of
# this is wide.
SPEAKER_MATCH_MIN_SIMILARITY = 0.55

# How much of the context-term prompt a segment must reproduce, contiguously
# and in order, before it is treated as Whisper reciting its prompt rather
# than transcribing speech - see `_is_prompt_echo`. Six is deliberately
# conservative: a single listed term appearing in real speech is the entire
# reason for listing it, and must never be dropped.
MIN_PROMPT_ECHO_WORDS = 6

# Whisper usually cuts the recital off mid-term; a few words past where the
# prompt match ends are tolerated so a truncated echo is still caught.
PROMPT_ECHO_TRAILING_SLACK_WORDS = 3

# Speech the VAD found but the ASR pass returned nothing for is re-transcribed
# in isolation - see `WhisperXService._recover_missed_speech`.
#
# The batched decoder concatenates VAD regions into ~30s chunks. A short, quiet
# utterance sitting alone between long silences ends up buried in such a chunk
# and Whisper skips it. Measured on a real interview: a 65-second stretch that
# the VAD scored as speech (peak 0.929, well past the 0.5 onset) contributed a
# single 0.4s line to the transcript, while the same audio decoded on its own
# yielded "Oh, there's that. Please please go back to showering. Sorry.
# Impressive. What's it doing?" - four utterances that were simply never
# decoded. For an interview record, silently losing speech the VAD already
# identified is the worst failure this pipeline can have.
MIN_RECOVERY_INTERVAL_S = 0.3

# Unclaimed regions closer together than this are recovered in one slice, so a
# fumbled exchange is decoded with its own context rather than word by word.
RECOVERY_GROUP_GAP_S = 20.0

# Bounds on the extra work: no single slice longer than this, and recovery
# gives up past this share of the recording (a run needing more than that is
# not "a few missed asides" - it is a broken pass, and quietly re-decoding half
# the file would hide that).
MAX_RECOVERY_SLICE_S = 120.0
MAX_RECOVERY_FRACTION = 0.15

# The `clustering_threshold` parameter plumbed through this module (and
# exposed in the UI) is INERT on pyannote community-1 / speaker-diarization-3.1
# and is kept only so existing callers and stored options keep working.
#
# Measured directly against the installed pipeline: diarizing the same audio
# at thresholds 0.05, 0.30, 0.40, 0.48, 0.60 and 0.95 returns byte-identical
# turns and speaker distributions every time. `Pipeline.instantiate()` accepts
# the value without error, which is what made this look like a working knob;
# community-1's clustering is VBx-based, and `threshold` is not what governs
# merging there. The automatic retry therefore varies `num_speakers` instead,
# which does change the result substantially - see the retry block in
# `transcribe`.
CLUSTERING_THRESHOLD_IS_INERT = True

# Only retry once, ever, per transcription - an unbounded "keep retrying
# until it looks good" loop would turn one slow GPU pass into an unbounded
# number of them for exactly the recordings that already took the longest to
# get through diarization once.
#
# "monologue" is in here because it is the signature of the worst failure this
# pipeline has, not because one-speaker recordings need special handling:
# `_classify` returns it whenever diarization resolved to a single speaker, and
# on difficult audio that is what a total clustering collapse looks like.
# Measured on an 80-second window of a three-person phone interview, auto mode
# returned ONE speaker for the entire excerpt; the same audio with an explicit
# `num_speakers` separated the turns correctly. Before this, that outcome was
# classified "monologue" and so was the one case never retried.
#
# A genuinely single-speaker recording still costs one extra diarization pass,
# but cannot be damaged by it: the retry is kept only if it measurably lowers
# the suspicious-segment ratio, so a real monologue's forced 2-speaker split
# is discarded.
_RETRY_TRIGGER_CLASSIFICATIONS = frozenset({"difficult", "monologue"})


def find_unclaimed_speech(
    speech: list[Interval],
    segments: list[dict],
    min_interval_s: float = MIN_RECOVERY_INTERVAL_S,
) -> list[Interval]:
    """Speech regions the ASR pass returned nothing for.

    A region counts as claimed as soon as any transcript segment overlaps it at
    all - the question is only whether the decoder looked there, not whether it
    produced a proportionate amount of text.
    """
    if not speech:
        return []
    spans = sorted((float(s.start), float(s.end)) for s in map(_as_span, segments))
    unclaimed: list[Interval] = []
    for start, end in speech:
        if end - start < min_interval_s:
            continue
        if not any(span_end > start and span_start < end for span_start, span_end in spans):
            unclaimed.append((start, end))
    return unclaimed


class _Span:
    __slots__ = ("start", "end")

    def __init__(self, start: float, end: float):
        self.start = start
        self.end = end


def _as_span(segment: dict) -> _Span:
    return _Span(float(segment.get("start") or 0.0), float(segment.get("end") or 0.0))


def group_recovery_slices(
    unclaimed: list[Interval],
    gap_s: float = RECOVERY_GROUP_GAP_S,
    max_slice_s: float = MAX_RECOVERY_SLICE_S,
) -> list[Interval]:
    """Bundles nearby unclaimed regions into slices worth decoding as a unit."""
    slices: list[Interval] = []
    for start, end in sorted(unclaimed):
        if slices and start - slices[-1][1] <= gap_s and end - slices[-1][0] <= max_slice_s:
            slices[-1] = (slices[-1][0], end)
            continue
        slices.append((start, end))
    return slices


def _cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    denom = float(np.linalg.norm(a) * np.linalg.norm(b))
    if denom <= 0:
        return -1.0
    return float(np.dot(a, b) / denom)


class _SpeakerRegistry:
    """Keeps one identity per real person across independently-diarized
    windows.

    Each window is clustered on its own, so its `SPEAKER_00` has nothing to do
    with the previous window's `SPEAKER_00` - only the embedding does. A
    window-local speaker is matched to the closest global speaker seen so far
    and, if nothing is close enough, becomes a new one. Matched speakers have
    their centroid updated as a running mean so an identity built from a
    two-second greeting is refined by every later window that hears more of
    that voice.
    """

    def __init__(self, min_similarity: float = SPEAKER_MATCH_MIN_SIMILARITY):
        self._min_similarity = min_similarity
        self._centroids: list[np.ndarray] = []
        self._weights: list[float] = []

    def resolve_window(self, candidates: list[tuple[np.ndarray | None, float]]) -> list[str]:
        """Global labels for all speakers found in ONE window, at once.

        Resolved together rather than one at a time because a window's
        speakers are, by construction, different people: the diarizer already
        decided they were distinct within this window. Matching them
        independently lets two of them claim the same global identity - which
        is what happened on a real interview, where the lawyer and the
        interviewer, cleanly separated inside the window, were both matched
        back to the interviewer and re-merged during stitching.

        So each global speaker may be claimed at most once per window, taking
        the most similar pair first; whoever is left over starts a new
        identity.
        """
        pairs: list[tuple[float, int, int]] = []
        for local_index, (embedding, _duration) in enumerate(candidates):
            if embedding is None or not np.all(np.isfinite(embedding)):
                continue
            for global_index, centroid in enumerate(self._centroids):
                if self._weights[global_index] <= 0:
                    continue
                similarity = _cosine_similarity(embedding, centroid)
                if similarity >= self._min_similarity:
                    pairs.append((similarity, local_index, global_index))

        pairs.sort(reverse=True)
        assigned: dict[int, int] = {}
        claimed_global: set[int] = set()
        for _similarity, local_index, global_index in pairs:
            if local_index in assigned or global_index in claimed_global:
                continue
            assigned[local_index] = global_index
            claimed_global.add(global_index)

        labels: list[str] = []
        for local_index, (embedding, duration) in enumerate(candidates):
            global_index = assigned.get(local_index)
            if global_index is None:
                labels.append(self._append(embedding, duration))
                continue
            weight = self._weights[global_index]
            total = weight + duration
            if total > 0 and embedding is not None:
                self._centroids[global_index] = (
                    self._centroids[global_index] * weight + embedding * duration
                ) / total
                self._weights[global_index] = total
            labels.append(f"SPEAKER_{global_index:02d}")
        return labels

    def _append(self, embedding: np.ndarray | None, duration: float) -> str:
        index = len(self._centroids)
        self._centroids.append(
            np.zeros(1) if embedding is None else np.array(embedding, dtype=np.float64)
        )
        self._weights.append(0.0 if embedding is None else max(duration, 0.0))
        return f"SPEAKER_{index:02d}"


def _merge_adjacent_turns(turns: list[dict], max_gap_s: float = 0.0) -> list[dict]:
    """Rejoins turns that windowing split at a boundary - same speaker, and
    touching (or within `max_gap_s`)."""
    merged: list[dict] = []
    for turn in sorted(turns, key=lambda t: (t["start"], t["end"])):
        if (
            merged
            and merged[-1]["speaker"] == turn["speaker"]
            and turn["start"] - merged[-1]["end"] <= max_gap_s
        ):
            merged[-1]["end"] = max(merged[-1]["end"], turn["end"])
            continue
        merged.append(dict(turn))
    return merged


def _normalize_for_echo(text: str) -> list[str]:
    """Words only, lowercased - so a prompt echo is recognised regardless of
    how Whisper punctuated or cased it."""
    return re.sub(r"[^a-z0-9 ]+", " ", (text or "").lower()).split()


def _is_prompt_echo(text: str, prompt_words: list[str]) -> bool:
    """Whether `text` is Whisper reciting its own prompt back.

    Deliberately strict - it must be a CONTIGUOUS run of the prompt's own
    words, in the prompt's own order, and at least
    `MIN_PROMPT_ECHO_WORDS` long. A glossary is a comma-separated list of
    unrelated terms ("Serious Fraud Office, SFO, Counter Fraud Centre, Quay
    Street, ..."), so a speaker reproducing six or more of them contiguously
    and in that exact order is not something that happens by accident,
    whereas any one term appearing in real speech (which is the whole point
    of listing it) is left completely untouched.
    """
    if not prompt_words:
        return False
    words = _normalize_for_echo(text)
    if len(words) < MIN_PROMPT_ECHO_WORDS:
        return False
    span = len(words)
    for start in range(len(prompt_words) - span + 1):
        if prompt_words[start : start + span] == words:
            return True
    # Whisper often truncates the recital mid-term, so also accept a run that
    # matches the prompt from some point onward for as far as it goes.
    for start in range(len(prompt_words)):
        overlap = min(span, len(prompt_words) - start)
        if overlap >= MIN_PROMPT_ECHO_WORDS and prompt_words[start : start + overlap] == words[:overlap]:
            return len(words) - overlap <= PROMPT_ECHO_TRAILING_SLACK_WORDS
    return False


def _drop_prompt_echoes(segments: list[dict], initial_prompt: str | None) -> int:
    """Removes hallucinated prompt recitals in place; returns how many went."""
    prompt_words = _normalize_for_echo(initial_prompt or "")
    if not prompt_words:
        return 0
    kept = [segment for segment in segments if not _is_prompt_echo(segment.get("text", ""), prompt_words)]
    dropped = len(segments) - len(kept)
    if dropped:
        segments[:] = kept
    return dropped


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


def _split_oversized(segments: list[SegmentX], chunk_size: float) -> list[SegmentX]:
    """Break any region longer than chunk_size into consecutive pieces.

    whisperx's own merge_chunks only closes a chunk before adding a segment
    that would overflow it, and skips that check for the first segment of a
    new chunk - so a single region already longer than chunk_size (which the
    two-tier union in vad_tiers.merge_intervals can produce, unlike a plain
    VAD pass) sails through untouched. That oversized chunk then hits
    asr.py's preprocess(), whose padding is `N_SAMPLES - audio.shape[0]` -
    negative past 30s, so nothing pads or trims it and its mel-spectrogram
    ends up a different frame count than the rest of the batch, which
    torch.stack rejects.
    """
    split_segments = []
    for seg in segments:
        start = seg.start
        while seg.end - start > chunk_size:
            split_segments.append(SegmentX(start, start + chunk_size, seg.speaker))
            start += chunk_size
        split_segments.append(SegmentX(start, seg.end, seg.speaker))
    return split_segments


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
        return Vad.merge_chunks(_split_oversized(segments_list, chunk_size), chunk_size, onset, offset)


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
        # Likewise distinct: _get_model() asks for the VAD while holding _lock,
        # so the VAD cannot be guarded by that same non-reentrant lock.
        self._vad_lock = Lock()
        self._vad: PyannoteVad | None = None
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
                    # Only a fallback: transcribe() swaps in a PrecomputedVad
                    # carrying the two-tier mask before every decode, so this
                    # configuration never actually gates the ASR pass.
                    vad_options = {
                        "chunk_size": 30,
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
                        vad_model=self._get_vad().model,
                        vad_options=vad_options,
                        asr_options=asr_options,
                    )
                    self._loaded_model_name = resolved_name
                    logger.info("Whisper model %s loaded", resolved_name)
        return self._model

    def _get_vad(self) -> PyannoteVad:
        """The segmentation model, loaded once and shared.

        The same instance serves both tiers and the pipeline's own VAD slot -
        thresholds are applied to its scores, never baked into it, so there is
        never a reason to hold more than one, and it survives a whisper model
        hot-swap (_loaded_model_name changing) unchanged.
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

    def build_prompt(self, context_terms: str | None, model_name: str | None = None) -> PromptBuild:
        """Budget and assemble the per-recording prompt.

        Lives here rather than in the router because the budget depends on two
        things only the service knows: the loaded model's tokenizer, and how
        much of the window the deployment-wide glossary has already claimed.

        `model_name` must match whatever `transcribe()` is about to request for
        the same call - passing a different (or no) name would tokenize the
        budget against the wrong model, and worse, load it just to immediately
        evict it in favor of the real one (see `_get_model`).
        """
        if not (context_terms or "").strip():
            return PromptBuild(prompt=None)

        model = self._get_model(model_name)
        count_tokens = self._token_counter(model)

        hotwords = normalize_hotwords(self.settings.hotwords)
        hotwords_tokens = count_tokens(f" {hotwords}") if hotwords else 0

        return build_initial_prompt(
            context_terms,
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

    def _recover_missed_speech(
        self,
        model,
        audio,
        result: dict,
        speech: list[Interval],
        language: str | None,
        initial_prompt: str | None,
        hotwords: str | None,
        suppress_numerals: bool,
    ) -> tuple[int, float]:
        """Re-decodes VAD speech the main pass produced nothing for.

        Returns `(recovered_segment_count, recovered_audio_seconds)`. Mutates
        `result["segments"]` in place, keeping it in time order.

        See MIN_RECOVERY_INTERVAL_S for why this is needed at all: the batched
        decoder buries short, quiet utterances that sit alone between silences,
        and those same regions decode correctly when given their own pass.
        """
        unclaimed = find_unclaimed_speech(speech, result.get("segments", []))
        if not unclaimed:
            return 0, 0.0

        slices = group_recovery_slices(unclaimed)
        audio_duration = len(audio) / SAMPLE_RATE
        budget = audio_duration * MAX_RECOVERY_FRACTION
        planned = sum(end - start for start, end in slices)
        if planned > budget:
            logger.warning(
                "Skipping speech recovery: %.0fs of unclaimed speech exceeds the %.0fs budget "
                "(%.0f%% of the recording). This suggests the ASR pass failed broadly rather "
                "than missing a few asides.",
                planned,
                budget,
                MAX_RECOVERY_FRACTION * 100,
            )
            return 0, 0.0

        recovered: list[dict] = []
        recovered_seconds = 0.0
        for start, end in slices:
            first = max(0, int(start * SAMPLE_RATE))
            last = min(len(audio), int(end * SAMPLE_RATE))
            chunk = audio[first:last]
            if len(chunk) < int(MIN_RECOVERY_INTERVAL_S * SAMPLE_RATE):
                continue
            try:
                partial = self._transcribe_batched(
                    model,
                    chunk,
                    language,
                    initial_prompt,
                    hotwords,
                    suppress_numerals,
                    [(0.0, len(chunk) / SAMPLE_RATE)],
                )
            except Exception:
                logger.exception(
                    "Speech recovery failed for %.1fs-%.1fs; leaving it untranscribed", start, end
                )
                continue

            offset = first / SAMPLE_RATE
            for segment in partial.get("segments", []):
                if not (segment.get("text") or "").strip():
                    continue
                segment["start"] = float(segment.get("start") or 0.0) + offset
                segment["end"] = float(segment.get("end") or 0.0) + offset
                for word in segment.get("words", []) or []:
                    if word.get("start") is not None:
                        word["start"] = float(word["start"]) + offset
                    if word.get("end") is not None:
                        word["end"] = float(word["end"]) + offset
                recovered.append(segment)
            recovered_seconds += end - start

        if not recovered:
            return 0, 0.0

        _drop_prompt_echoes(recovered, initial_prompt)
        result["segments"] = sorted(
            [*result.get("segments", []), *recovered],
            key=lambda segment: float(segment.get("start") or 0.0),
        )
        return len(recovered), recovered_seconds

    def _transcribe_batched(
        self,
        model,
        audio,
        language: str | None,
        initial_prompt: str | None,
        hotwords: str | None,
        suppress_numerals: bool,
        speech: list[Interval],
    ) -> dict:
        """Run the ASR pass over `speech`, optionally under a per-request
        initial_prompt and/or hotwords.

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
            previous_vad = model.vad_model
            overrides = {}
            if initial_prompt:
                overrides["initial_prompt"] = initial_prompt
            if hotwords:
                overrides["hotwords"] = hotwords
            if overrides:
                model.options = replace(previous_options, **overrides)
            model.suppress_numerals = suppress_numerals
            model.vad_model = PrecomputedVad(speech)
            try:
                return model.transcribe(audio, batch_size=effective_batch_size, language=resolved_language)
            finally:
                # Restored even on failure - a leaked prompt would silently
                # condition every later recording on this one's terminology, a
                # leaked numeral setting would silently spell out digits in a
                # recording that asked for them, and a leaked mask would gate
                # the next recording on this one's speech regions.
                model.options = previous_options
                model.suppress_numerals = previous_suppress
                model.vad_model = previous_vad

    def _asr_and_align(
        self,
        whisper_model,
        audio,
        language: str | None,
        initial_prompt: str | None,
        request_hotwords: str | None,
        suppress_numerals: bool,
    ) -> tuple[list[dict], str, int, float, bool, VadTiers, int, int]:
        """ASR + forced alignment for one mono audio stream - the same two
        steps `transcribe` runs once for the whole recording, factored out so
        channel-split mode can run them once per channel instead.

        Computes the two VAD tiers for `audio` itself, rather than taking them
        as a parameter: channel-split mode calls this once per channel, and
        each channel's tiers have to come from that channel's own audio, not
        the full (downmixed) recording - so there is no single tiers value a
        caller could correctly compute once and pass in for every call.
        """
        tiers = compute_tiers(audio, self.settings, self._get_vad())

        result = self._transcribe_batched(
            whisper_model, audio, language, initial_prompt, request_hotwords, suppress_numerals, tiers.union
        )
        language_code = result["language"]

        # Whisper regurgitates its own `initial_prompt` as if it were speech -
        # a well-known failure mode, and the reason `build_initial_prompt`
        # warns that "framing is what leaks into the transcript". On a real
        # 3-hour interview the full 14-term glossary was emitted verbatim as
        # dialogue eight separate times, attributed to a speaker, at
        # timestamps where nobody said it. That is fabricated content in a
        # forensic record, which is far worse than a formatting problem, so
        # these are dropped rather than merely flagged.
        prompt_echo_count = _drop_prompt_echoes(result["segments"], initial_prompt)
        if prompt_echo_count:
            logger.warning(
                "Dropped %d transcript segment(s) that echoed the context-term prompt "
                "rather than transcribing speech",
                prompt_echo_count,
            )

        # Nothing the VAD called speech is allowed to go undecoded - see
        # MIN_RECOVERY_INTERVAL_S.
        recovered_count, recovered_seconds = self._recover_missed_speech(
            whisper_model,
            audio,
            result,
            tiers.union,
            language,
            initial_prompt,
            request_hotwords,
            suppress_numerals,
        )
        if recovered_count:
            logger.info(
                "Speech recovery: re-decoded %.1fs of VAD-detected speech the main pass "
                "returned nothing for, recovering %d segment(s)",
                recovered_seconds,
                recovered_count,
            )

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

        # Tagging runs even when alignment failed: tag_segments falls back to
        # a segment's own span (see vad_tiers.py) when it has no words to
        # classify, so unaligned output is still marked, just at segment
        # granularity instead of per word.
        borderline_word_count, borderline_segment_count = tag_segments(result["segments"], tiers)

        return (
            result["segments"],
            language_code,
            alignment_gap_count,
            alignment_gap_total_s,
            alignment_failed,
            tiers,
            borderline_word_count,
            borderline_segment_count,
        )

    def _run_diarization(
        self,
        audio,
        asr_segments: list[dict],
        hint: SpeakerCountHint,
        clustering_threshold: float | None,
        forced_speaker_count: int | None = None,
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
            # An exact count forces pyannote's clustering to cut into
            # precisely that many groups, rather than estimating the count
            # itself. `forced_speaker_count` is the retry's own override (see
            # `transcribe`); the caller's hint wins when both are set, because
            # a count the user actually typed is evidence, not a guess.
            effective_count = hint.count if hint.count is not None else forced_speaker_count
            window_samples = int(DIARIZATION_WINDOW_S * SAMPLE_RATE)
            # Only worth it with a speaker count to pin each window to.
            # Measured on a 30-minute interview window: windowing with an
            # exact `num_speakers` separates speakers a single global pass
            # merges, but windowing WITHOUT one reproduces the same merge the
            # global pass makes, for extra GPU time and nothing gained.
            use_windows = (
                DIARIZATION_WINDOW_S > 0
                and effective_count is not None
                and hasattr(diarize_model, "model")
                and len(audio) > window_samples
            )
            if use_windows:
                # Long recordings are clustered per window and stitched, because
                # a single global pass loses anyone who speaks only briefly -
                # see DIARIZATION_WINDOW_S.
                diarize_segments, speaker_embeddings = self._diarize_in_windows(
                    diarize_model.model, audio, effective_count
                )
            elif effective_count is not None:
                diarize_segments, speaker_embeddings = diarize_model(
                    audio, num_speakers=effective_count, return_embeddings=True
                )
            else:
                diarize_segments, speaker_embeddings = diarize_model(
                    audio, return_embeddings=True
                )

        if len(diarize_segments) == 0:
            raise NoSpeakerSegments(
                "No speech could be detected in this recording, so there are no speakers "
                "to label. This usually means the audio is silent, too quiet, or too short. "
                "Check that the file actually contains audible speech - if it does, try "
                "setting an exact speaker count explicitly."
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
        speaker_count: int | None = None,
        clustering_threshold: float | None = None,
        context_terms: str | None = None,
        model: str | None = None,
        suppress_numerals: bool | None = None,
        channel_split: bool = False,
    ) -> tuple[list[dict], str, dict, list[dict], dict[str, list[float]] | None, dict]:
        prompt_build = self.build_prompt(context_terms, model_name=model)
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

        # Put the hint in range before any diarizer sees it. pyannote takes it
        # at face value, so an out-of-range value silently produces a worse
        # result than passing nothing.
        hint = resolve_speaker_count(speaker_count)
        for adjustment in hint.adjustments:
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
            # Accumulated across channels rather than computed from one tiers
            # value: each channel is its own mono stream with its own VAD
            # pass (see _asr_and_align), so there is no single confident-tier
            # duration or audio length that covers all of them at once.
            confident_duration_s = 0.0
            borderline_duration_s = 0.0
            audio_duration_s = 0.0
            borderline_word_count = 0
            borderline_segment_count = 0

            for channel_index in range(channel_count):
                channel_audio = load_audio_channel(audio_path, channel_index)
                (
                    segs,
                    channel_language,
                    gap_count,
                    gap_total,
                    failed,
                    channel_tiers,
                    channel_borderline_words,
                    channel_borderline_segments,
                ) = self._asr_and_align(
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
                confident_duration_s += total_duration(channel_tiers.confident)
                borderline_duration_s += total_duration(channel_tiers.borderline)
                audio_duration_s += len(channel_audio) / SAMPLE_RATE
                borderline_word_count += channel_borderline_words
                borderline_segment_count += channel_borderline_segments
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
                "speaker_count": None,
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
                tiers,
                borderline_word_count,
                borderline_segment_count,
            ) = self._asr_and_align(
                whisper_model, audio, language, initial_prompt, request_hotwords, resolved_suppress_numerals
            )
            confident_duration_s = total_duration(tiers.confident)
            borderline_duration_s = total_duration(tiers.borderline)
            audio_duration_s = len(audio) / SAMPLE_RATE
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
                "speaker_count": None,
                "original_suspicious_ratio": None,
                "retry_suspicious_ratio": None,
            }

            if diarize:
                diarize_result = self._run_diarization(audio, asr_segments, hint, clustering_threshold)
                speaker_hint_applied = hint.is_set

                # Selective retry: a "difficult" first pass most often means
                # clustering merged two real speakers into one. One automatic
                # retry either measurably reduces the suspicious-segment
                # ratio (kept) or it doesn't (discarded, original stands) -
                # never more than one retry, and never for a recording that
                # wasn't flagged difficult in the first place.
                #
                # The retry re-runs with an explicit speaker count one above
                # what the first pass settled on, because that is the lever
                # that actually moves this pipeline. The clustering threshold
                # it used to retry at does nothing at all: measured against
                # pyannote community-1, diarizing the same audio at every
                # threshold from 0.05 to 0.95 returns byte-identical turns
                # (its clustering is VBx-based, and `threshold` is not the
                # knob that governs merging there). Passing `num_speakers`,
                # by contrast, changed a 30-minute interview window from 3
                # speakers with one of them holding 74% of the audio to a
                # balanced 4 with nearly double the speaker switches.
                initial_profile = compute_recording_profile(
                    _preview_label(diarize_result["segments"]), diarize_result["diarization_turns"]
                )
                detected_count = diarize_result.get("diarization_speaker_count") or 0
                retry_speaker_count = detected_count + 1
                # An explicit caller hint is not second-guessed, and there is
                # no point forcing a count the pipeline already chose on its
                # own - forcing the detected count reproduces the first pass
                # exactly (measured), so only a different count is worth a
                # second GPU pass.
                if (
                    initial_profile.classification in _RETRY_TRIGGER_CLASSIFICATIONS
                    and not hint.is_set
                    and MIN_ALLOWED_SPEAKERS <= retry_speaker_count <= MAX_ALLOWED_SPEAKERS
                ):
                    diarization_retry_diagnostics["attempted"] = True
                    diarization_retry_diagnostics["speaker_count"] = retry_speaker_count
                    diarization_retry_diagnostics["original_suspicious_ratio"] = (
                        initial_profile.suspicious_segment_ratio
                    )
                    try:
                        retry_result = self._run_diarization(
                            audio,
                            asr_segments,
                            hint,
                            clustering_threshold,
                            forced_speaker_count=retry_speaker_count,
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
                                "Diarization retry (num_speakers=%d) improved suspicious_segment_ratio "
                                "%.4f -> %.4f; keeping retry.",
                                retry_speaker_count,
                                initial_profile.suspicious_segment_ratio,
                                retry_profile.suspicious_segment_ratio,
                            )
                        else:
                            diarization_retry_diagnostics["kept"] = "original"
                            logger.info(
                                "Diarization retry (num_speakers=%d) did not improve suspicious_segment_ratio "
                                "(retry=%.4f vs original=%.4f); keeping original.",
                                retry_speaker_count,
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
                if hint.is_set and diarization_speaker_count and not hint.matches(diarization_speaker_count):
                    logger.warning(
                        "Diarization found %d speakers, outside the requested %s.",
                        diarization_speaker_count,
                        hint.describe(),
                    )

        speaker_numbers: dict[str, int] = {}
        segments = self._build_speaker_segments(result["segments"], speaker_numbers)

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
            "speaker_count_requested": hint.count,
            "speaker_hint_applied": speaker_hint_applied,
            "speaker_hint_adjustments": hint.adjustments,
            "speaker_count_within_hint": (
                hint.matches(diarization_speaker_count)
                if hint.is_set and diarize and diarization_speaker_count
                else None
            ),
            "speaker_label_map": speaker_label_map,
            # Whether an automatic diarization retry (an explicit
            # `num_speakers`, one above what the first pass detected) ran
            # because the first pass looked "difficult", and whether it was
            # actually kept - see the retry block in `transcribe`.
            "diarization_retry_attempted": diarization_retry_diagnostics["attempted"],
            "diarization_retry_kept": diarization_retry_diagnostics["kept"],
            "diarization_retry_speaker_count": diarization_retry_diagnostics["speaker_count"],
            "diarization_original_suspicious_ratio": diarization_retry_diagnostics["original_suspicious_ratio"],
            "diarization_retry_suspicious_ratio": diarization_retry_diagnostics["retry_suspicious_ratio"],
            # What each VAD tier accounted for. The borderline figures are the
            # ones to watch: that audio would have been dropped without trace
            # under a single threshold, so its size is the measure of what the
            # old behaviour was costing.
            "vad_speech_ratio": (
                round(confident_duration_s / audio_duration_s, 4) if audio_duration_s else 0.0
            ),
            "vad_borderline_duration_s": round(borderline_duration_s, 2),
            "vad_borderline_word_count": borderline_word_count,
            "vad_borderline_segment_count": borderline_segment_count,
            "vad_onset": self.settings.vad_onset,
            "vad_offset": self.settings.vad_offset,
            "vad_borderline_onset": self.settings.vad_borderline_onset,
            "vad_borderline_offset": self.settings.vad_borderline_offset,
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

    # Confidence ranking for `_build_speaker_segments`' least-confident-wins
    # aggregation, best to worst. `channel_split` sits with `overlap`: a
    # channel-split word's speaker is certain by construction (one channel is
    # one speaker), not a clustering estimate, so it is not a lesser form of
    # evidence than a genuine diarization-turn overlap.
    _ASSIGNMENT_METHOD_SEVERITY = {"overlap": 0, "channel_split": 0, "nearest": 1, "unknown": 2, "none": 3}

    def _diarize_in_windows(self, pipeline, audio, effective_count: int | None) -> tuple:
        """Diarizes long audio in overlapping windows and stitches the result.

        Returns the same `(DataFrame, embeddings)` shape a single global pass
        produces, so everything downstream (`assign_word_speakers`, the turn
        record, the recording profile) is unchanged.

        Clustering each window separately is the entire point: see
        `DIARIZATION_WINDOW_S` for the measurements showing that the same
        audio separates correctly at five minutes and merges at ten or more.
        """
        total_samples = len(audio)
        window_samples = int(DIARIZATION_WINDOW_S * SAMPLE_RATE)
        step_samples = max(1, window_samples - int(DIARIZATION_WINDOW_OVERLAP_S * SAMPLE_RATE))

        registry = _SpeakerRegistry()
        turns: list[dict] = []
        window_count = 0

        for start_sample in range(0, total_samples, step_samples):
            chunk = audio[start_sample : start_sample + window_samples]
            # A trailing sliver shorter than the overlap carries no speech the
            # previous window has not already seen.
            if len(chunk) < int(DIARIZATION_WINDOW_OVERLAP_S * SAMPLE_RATE):
                break
            window_count += 1
            offset = start_sample / SAMPLE_RATE

            waveform = torch.from_numpy(np.ascontiguousarray(chunk)).float().unsqueeze(0)
            # No `return_embeddings` here: that is whisperx's own wrapper
            # kwarg, not one pyannote's `apply()` accepts. This calls the raw
            # pipeline, which already returns `speaker_embeddings` on its
            # `DiarizeOutput` - passing it only produced an "Ignoring
            # unexpected keyword arguments" warning per window (verified: the
            # embeddings are identical either way).
            kwargs = {}
            if effective_count is not None:
                kwargs["num_speakers"] = effective_count
            try:
                output = pipeline({"waveform": waveform, "sample_rate": SAMPLE_RATE}, **kwargs)
            except Exception:
                logger.exception(
                    "Diarization failed for window starting at %.1fs; skipping it", offset
                )
                continue

            annotation = getattr(output, "speaker_diarization", output)
            embeddings = getattr(output, "speaker_embeddings", None)

            local_turns: dict[str, list[tuple[float, float]]] = {}
            for segment, _track, label in annotation.itertracks(yield_label=True):
                local_turns.setdefault(label, []).append((segment.start, segment.end))
            if not local_turns:
                continue

            # `speaker_embeddings` rows line up with the labels in sorted
            # order - the same contract the single-pass call relies on.
            ordered_labels = sorted(local_turns)
            embedding_array = None if embeddings is None else np.asarray(embeddings, dtype=np.float64)

            candidates: list[tuple[np.ndarray | None, float]] = []
            for index, label in enumerate(ordered_labels):
                speech = sum(end - start for start, end in local_turns[label])
                embedding = None
                if embedding_array is not None and index < len(embedding_array):
                    embedding = embedding_array[index]
                candidates.append((embedding, speech))
            label_map = dict(zip(ordered_labels, registry.resolve_window(candidates)))

            for label, spans in local_turns.items():
                for start, end in spans:
                    turns.append(
                        {
                            "start": offset + start,
                            "end": offset + end,
                            "speaker": label_map[label],
                        }
                    )

        merged = _merge_adjacent_turns(turns, max_gap_s=0.0)
        logger.info(
            "Windowed diarization: %d window(s) of %.0fs -> %d turn(s), %d speaker(s)",
            window_count,
            DIARIZATION_WINDOW_S,
            len(merged),
            len({turn["speaker"] for turn in merged}),
        )
        frame = pd.DataFrame(merged, columns=["start", "end", "speaker"])
        return frame, None

    @staticmethod
    def _split_into_runs(flat_words: list[dict]) -> list[list[dict]]:
        """Groups words into the runs that become displayed lines.

        A run always ends when the speaker changes - that part is the
        diarization talking, and is never overridden here. On top of that, a
        run is also ended at a natural boundary WITHIN one speaker's speech,
        because "same speaker" and "one readable line" are not the same
        thing: an interviewer reading a formal notice can legitimately hold
        the floor for minutes, and grouping purely by speaker turned that
        into a single 250-second, 563-word paragraph with 23 pauses over a
        second and 34 sentence endings inside it - every one of them a
        boundary a human transcriber would have broken at.

        Two kinds of boundary end a run early:

        - A pause of `SEGMENT_SPLIT_PAUSE_S` or more. Measured against this
          recording's own distribution, inter-word gaps sit at ~0.04s median
          and ~0.94s p95, so a gap this long is a real beat in the speech
          rather than ordinary word spacing.
        - Length: past `MAX_SEGMENT_DURATION_S` or `MAX_SEGMENT_WORDS` the
          line has outgrown a paragraph, so it breaks at the next sentence
          end. If the speech runs on with no sentence end at all, a hard cap
          at `SEGMENT_HARD_CAP_FACTOR` times those limits breaks it anyway,
          so a run can never grow without bound.

        Splitting only ever subdivides one speaker's own words; it can never
        merge across speakers or move a word to a different speaker.
        """
        runs: list[list[dict]] = []
        for word in flat_words:
            current = runs[-1] if runs else None
            if current is None or word["speaker"] != current[0]["speaker"]:
                runs.append([word])
                continue

            previous = current[-1]
            gap = WhisperXService._gap_between(previous, word)
            if gap is not None and gap >= SEGMENT_SPLIT_PAUSE_S:
                runs.append([word])
                continue

            span = WhisperXService._run_duration(current)
            over_soft_limit = (
                len(current) >= MAX_SEGMENT_WORDS or span >= MAX_SEGMENT_DURATION_S
            )
            over_hard_limit = (
                len(current) >= MAX_SEGMENT_WORDS * SEGMENT_HARD_CAP_FACTOR
                or span >= MAX_SEGMENT_DURATION_S * SEGMENT_HARD_CAP_FACTOR
            )
            ends_sentence = bool(SENTENCE_END_PATTERN.search(previous["raw_word"].strip()))
            if over_hard_limit or (over_soft_limit and ends_sentence):
                runs.append([word])
                continue

            current.append(word)
        return runs

    @staticmethod
    def _gap_between(previous: dict, word: dict) -> float | None:
        """Silence between two consecutive words, or None when either lacks
        the timestamps to say (alignment can drop them for a word)."""
        if previous.get("end") is None or word.get("start") is None:
            return None
        return float(word["start"]) - float(previous["end"])

    @staticmethod
    def _run_duration(run: list[dict]) -> float:
        starts = [w["start"] for w in run if w.get("start") is not None]
        ends = [w["end"] for w in run if w.get("end") is not None]
        if not starts or not ends:
            return 0.0
        return float(max(ends)) - float(min(starts))

    #: Characters that attach to the preceding word with no space before them,
    #: so a bare (space-less) token starting with one of these is punctuation
    #: rather than a new word - see `_join_words`.
    _ATTACHES_TO_PREVIOUS_WORD = frozenset(",.!?;:)]}%’'\"”…")

    @staticmethod
    def _join_words(raw_words: list[str]) -> str:
        """Reconstructs a line of text from per-word tokens, handling BOTH
        tokenizer conventions rather than assuming either.

        Whisper's own tokens carry their leading space (`" Hello"`, `" there"`),
        so they can be concatenated directly. WhisperX's forced aligner,
        however, splits on whitespace and hands back bare words (`"Hello"`,
        `"there"`) - concatenating THOSE directly is what produced
        `"Thankyouverymuch"` in real transcripts, because every separator in
        the line was silently dropped.

        Deciding per token (does it bring its own leading space?) rather than
        joining on a fixed separator is what keeps both correct at once, and
        keeps punctuation (`","`, `"."`) attached to the word before it
        instead of being spaced off as its own word.
        """
        out: list[str] = []
        for raw_word in raw_words:
            if not raw_word:
                continue
            if raw_word[:1].isspace():
                out.append(raw_word)
                continue
            needs_space = (
                bool(out) and raw_word[:1] not in WhisperXService._ATTACHES_TO_PREVIOUS_WORD
            )
            out.append(f" {raw_word}" if needs_space else raw_word)
        return "".join(out).strip()

    @staticmethod
    def _build_speaker_segments(asr_segments: list[dict], speaker_numbers: dict[str, int]) -> list[dict]:
        """Re-derives output segments from contiguous same-speaker word runs,
        instead of Whisper's own ASR decode-chunk boundaries.

        `asr_segments` is WhisperX's own segment shape (each with a `"words"`
        list) after `assign_word_speakers` and per-word
        `_resolve_speaker_assignment` have already run - every word already
        carries a resolved `_assignment_method`/`speaker`; this only decides
        how those words are grouped into displayed lines.

        A single Whisper segment can span several real speaker turns - VAD
        merges continuous speech with only brief pauses into one decode
        window, which is exactly what fast interview back-and-forth looks
        like - so treating that whole span as one speaker line silently
        blends turns together. Grouping by the words' own resolved speaker
        instead puts a segment boundary exactly where the speaker actually
        changes, and can also merge two adjacent Whisper segments when the
        same speaker continues across them - both are correct, because the
        output unit here is a speaker turn, not a Whisper decode chunk.
        """
        flat_words: list[dict] = []
        for segment in asr_segments:
            vad_borderline = bool(segment.get("_vad_borderline"))
            for word in segment.get("words", []):
                raw_word_speaker = word.get("speaker")
                if word.get("_assignment_method") == "unknown":
                    word_speaker_label = UNKNOWN_SPEAKER_LABEL
                elif raw_word_speaker is not None:
                    word_speaker_label = WhisperXService._speaker_label(raw_word_speaker, speaker_numbers)
                else:
                    word_speaker_label = None
                flat_words.append(
                    {
                        "raw_word": word.get("word") or "",
                        "start": word.get("start"),
                        "end": word.get("end"),
                        "speaker": word_speaker_label,
                        "assignment_method": word.get("_assignment_method", "none"),
                        "assignment_distance_s": word.get("_assignment_distance_s"),
                        "vad_confidence": word.get("_vad_confidence"),
                        "vad_borderline": vad_borderline,
                    }
                )

        runs: list[list[dict]] = WhisperXService._split_into_runs(flat_words)

        severity = WhisperXService._ASSIGNMENT_METHOD_SEVERITY
        segments: list[dict] = []
        for index, run in enumerate(runs):
            starts = [w["start"] for w in run if w["start"] is not None]
            ends = [w["end"] for w in run if w["end"] is not None]
            distances = [w["assignment_distance_s"] for w in run if w["assignment_distance_s"] is not None]
            # A run is only as trustworthy as its least-trustworthy word - its
            # reported method/distance must never overstate what's actually
            # known about who's speaking.
            worst_method = max(run, key=lambda w: severity.get(w["assignment_method"], 3))[
                "assignment_method"
            ]

            segments.append(
                {
                    "id": f"segment-{index}",
                    "start": round(float(min(starts)), 2) if starts else 0.0,
                    "end": round(float(max(ends)), 2) if ends else 0.0,
                    "speaker": run[0]["speaker"] if run[0]["speaker"] is not None else UNKNOWN_SPEAKER_LABEL,
                    "text": WhisperXService._join_words([w["raw_word"] for w in run]),
                    "assignment_method": worst_method,
                    "assignment_distance_s": max(distances) if distances else None,
                    "words": [
                        {
                            "word": w["raw_word"].strip(),
                            "start": w["start"],
                            "end": w["end"],
                            "speaker": w["speaker"],
                            "assignment_method": w["assignment_method"],
                            "assignment_distance_s": w["assignment_distance_s"],
                            "vad_confidence": w["vad_confidence"],
                        }
                        for w in run
                    ],
                    "vad_borderline": any(w["vad_borderline"] for w in run),
                }
            )

        return segments

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
