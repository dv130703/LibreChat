from functools import lru_cache
from pathlib import Path

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
    hf_token: str | None = None
    # None uses whisperx's default (pyannote/speaker-diarization-community-1).
    # The older, more battle-tested pyannote/speaker-diarization-3.1 is also
    # supported - it needs its own terms acceptance on huggingface.co.
    diarization_model: str | None = None
    # None lets whisperx auto-detect the spoken language.
    default_language: str | None = None
    # Batch size for transcription. Auto-reduced when using beam search to prevent OOM.
    batch_size: int = 16
    # Beam search width. Higher values improve accuracy but increase latency.
    beam_size: int = 5
    # Number of candidates to generate. Increases robustness at the cost of computation.
    best_of: int = 5
    # Temperature values for fallback ladder (comma-separated). Improves reliability
    # when initial temperature fails. Set to empty string to disable fallback.
    temperature_fallback: str = "0.0,0.2,0.4,0.6,0.8,1.0"
    # When false, prevents condition_on_previous_text from causing repetition loops.
    # NOTE: inert under whisperx's batched pipeline - see the asr_options comment
    # in whisperx_service.py for which of these actually reach the decoder.
    condition_on_previous_text: bool = False
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
    # Compression ratio threshold (lower = stricter). Filters repetitive/garbled sequences.
    compression_ratio_threshold: float = 2.4
    # Log probability threshold. Lower = stricter quality threshold.
    log_prob_threshold: float = -1.0
    # Silence detection threshold (0-1). Higher = less aggressive silence detection.
    no_speech_threshold: float = 0.6
    # Deployment-wide glossary applied to every recording (comma-separated terms;
    # a JSON list or object is accepted and flattened to its items/keys, since
    # faster-whisper only takes a single string here).
    hotwords: str | None = None
    # Fallback initial_prompt for requests that supply no context of their own.
    # Per-recording names and terminology arrive on the request instead, and
    # override this. Terms only - Whisper echoes framing sentences into output.
    initial_prompt: str | None = None
    # When true, only use WhisperX models that are already cached locally.
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
    # Clustering threshold for speaker merging. None uses pipeline default.
    diarization_clustering_threshold: float | None = None
    # Minimum cluster size for speaker detection
    diarization_min_cluster_size: int | None = None

    # --- ASR preprocessing and language ---
    # Force numerals to be spelled out (e.g. "2014" → "twenty fourteen")
    suppress_numerals: bool = True

    model_config = SettingsConfigDict(env_file=_ENV_FILE, env_prefix="WHISPERX_", extra="ignore")


@lru_cache
def get_settings() -> Settings:
    return Settings()
