from functools import lru_cache
from pathlib import Path

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# Resolved from this file's own location, not the process's current working
# directory - a bare ".env" only ever found rag_server/.env because the one
# npm script that starts this server happens to `cd rag_server` first
# (package.json's "rag" script). Any other way of starting it (a different
# working directory, a container, a systemd unit) would silently start with
# no .env at all, with WHISPERX_HF_TOKEN unset and no indication why.
_ENV_FILE = Path(__file__).resolve().parent.parent / "rag_server" / ".env"


class Settings(BaseSettings):
    # Any faster-whisper size works: tiny, base, small, medium, large-v2, large-v3,
    # large-v3-turbo.
    whisper_model: str = "large-v3-turbo"
    # "cuda" or "cpu"; auto-detected when left unset.
    device: str | None = None
    # "float16"/"int8_float16" on GPU, "int8" on CPU; auto-picked when left unset.
    compute_type: str | None = None
    # Required for diarization: a Hugging Face token that has accepted the
    # gated model terms for whichever diarization_model below is configured.
    # Also read from HF_TOKEN/HUGGING_FACE_HUB_TOKEN - the names huggingface_hub
    # itself uses, and so the ones a machine already set up to pull gated models
    # will have. Without these aliases the WHISPERX_ prefix hides an otherwise
    # perfectly good token and diarization fails as if none were configured.
    hf_token: str | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "WHISPERX_HF_TOKEN",
            "HF_TOKEN",
            "HUGGING_FACE_HUB_TOKEN",
        ),
    )
    # None uses whisperx's default (pyannote/speaker-diarization-community-1).
    # The older, more battle-tested pyannote/speaker-diarization-3.1 is also
    # supported - it needs its own terms acceptance on huggingface.co.
    diarization_model: str | None = None
    # None lets whisperx auto-detect the spoken language.
    default_language: str | None = None
    # Batch size for transcription. Auto-reduced when using beam search to prevent OOM.
    batch_size: int = 16
    # Beam search width. Higher values improve accuracy but increase latency.
    # The one real accuracy/latency knob here - see the asr_options comment in
    # whisperx_service.py for why its former neighbors (best_of, temperature
    # fallback, condition_on_previous_text, compression_ratio_threshold,
    # log_prob_threshold, no_speech_threshold) were removed rather than tuned:
    # whisperx's batched decoder never reads them, on this faster-whisper
    # version, so they configured nothing.
    beam_size: int = 5
    # Penalty applied to already-emitted tokens. 1.0 = off (whisperx's default),
    # which leaves nothing standing between the decoder and a repetition loop
    # ("...in the year of the monarch in the year of the monarch..."). Above ~1.3
    # it starts suppressing legitimately repeated words, so keep it mild.
    repetition_penalty: float = 1.15
    # Blocks any n-gram of this length from being emitted twice in one decode
    # window. 0 = off. 5 catches looping phrases while leaving ordinary speech
    # alone - genuine repeats of an exact 5-gram inside one 30s chunk are rare.
    # Lower it to 4 if loops persist; raise it or set 0 if real speech is being
    # mangled to avoid a repeat.
    no_repeat_ngram_size: int = 5
    # Deployment-wide glossary applied to every recording (comma-separated terms;
    # a JSON list or object is accepted and flattened to its items/keys, since
    # faster-whisper only takes a single string here).
    hotwords: str | None = None
    # Fallback initial_prompt for requests that supply no context of their own.
    # Per-recording names and terminology arrive on the request instead, and
    # override this. Terms only - Whisper echoes framing sentences into output.
    initial_prompt: str | None = None
    # "auto" | "on" | "off". Whether the whisper, alignment and diarization
    # loaders are allowed to reach the Hugging Face hub at all.
    #
    # "auto" probes the hub once a minute and goes cache-only when it does not
    # answer. This is not about whether the models load - they come from the
    # same cache either way - but about how long that takes: left online with no
    # network, every loader pays a DNS/connect timeout per file before falling
    # back to the cache it would have used anyway, which across the whisper,
    # wav2vec2 and pyannote checkpoints is the difference between seconds and
    # minutes. "on" forces cache-only (nothing is ever downloaded, so a model
    # that is not already cached fails instead of being fetched); "off" restores
    # the plain online behaviour.
    offline_mode: str = "auto"
    # Seconds the "auto" probe waits for the hub before giving up on it. Paid at
    # most once a minute, so it can afford to be generous: a name lookup that is
    # merely slow (cold resolver cache, VPN coming up, a loaded machine) must not
    # be mistaken for one that has no network behind it at all.
    hub_probe_timeout_s: float = 3.0
    # Forces offline_mode="on" when true. Kept as its own switch because it is
    # the name the underlying loaders use.
    local_files_only: bool = False
    # Directory to cache WhisperX models. If unset, uses huggingface default.
    model_cache_dir: str | None = None

    # --- Voice Activity Detection (VAD) tuning ---
    # VAD onset threshold (lower = catches quieter speech, raises hallucination risk)
    vad_onset: float = 0.500
    # VAD offset threshold (raise = trims trailing silence, reduces end-of-segment hallucination)
    vad_offset: float = 0.363
    # VAD method: "silero" or "pyannote"
    vad_method: str = "silero"

    # --- Diarization tuning ---
    # Clustering threshold for speaker merging. None uses pipeline default
    # (0.6). Lower merges more aggressively (fewer, larger speaker clusters);
    # higher splits more readily (more, smaller ones). The only clustering
    # hyperparameter pyannote.audio 4.x's VBx-based clustering actually
    # exposes on either supported diarization_model - there is no
    # `min_cluster_size` (or a `method` choice) on this pyannote version, so
    # neither is offered here as a setting someone would reasonably expect to
    # do something.
    diarization_clustering_threshold: float | None = None

    # --- ASR preprocessing and language ---
    # Force numerals to be spelled out (e.g. "2014" → "twenty fourteen")
    suppress_numerals: bool = True

    model_config = SettingsConfigDict(env_file=_ENV_FILE, env_prefix="WHISPERX_", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    return Settings()
