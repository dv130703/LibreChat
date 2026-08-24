"""Pre-downloads the whisper + alignment models so the first API request isn't slow.

Run from backend/ with the venv active:
    python scripts/download_model.py
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import whisperx  # noqa: E402

from app.config import get_settings  # noqa: E402
from app.services.whisperx_service import get_whisperx_service  # noqa: E402


def main() -> None:
    settings = get_settings()
    service = get_whisperx_service()

    print(f"Loading whisper model '{settings.whisper_model}' on {service.device} ({service.compute_type})...")
    service._get_model()  # noqa: SLF001
    print("Whisper model ready.")

    language = settings.default_language or "en"
    print(f"Loading alignment model for language '{language}'...")
    whisperx.load_align_model(language_code=language, device=service.device)
    print("Alignment model ready.")

    if settings.hf_token:
        print("Loading diarization model...")
        service._get_diarize_model()  # noqa: SLF001
        print("Diarization model ready.")
    else:
        print("WHISPERX_HF_TOKEN not set - skipping diarization model download.")


if __name__ == "__main__":
    main()
