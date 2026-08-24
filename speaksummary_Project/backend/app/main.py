from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .config import get_settings
from .routers import sessions, summarization, transcription
from .schemas import HealthResponse
from .services.whisperx_service import get_whisperx_service

settings = get_settings()

app = FastAPI(title="Transcription API", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    # Vite picks whatever port is free (5173, 5174, ...) if the default is
    # already taken, so pin to specific ports in allow_origins would just keep
    # breaking - allow any localhost/127.0.0.1 port for local dev instead.
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    # Response headers are hidden from browser JS unless named here - /api/preprocess
    # returns repaired audio as the body and its measurements in this header.
    expose_headers=["X-Quality-Metrics"],
)


@app.middleware("http")
async def restrict_client_ip(request: Request, call_next):
    allowed = settings.allowed_client_ip_list
    if allowed and (request.client is None or request.client.host not in allowed):
        return JSONResponse(status_code=403, content={"detail": "Client IP not allowed"})
    return await call_next(request)

app.include_router(sessions.router)
app.include_router(transcription.router)
app.include_router(summarization.router)


@app.get("/api/health", response_model=HealthResponse)
def health() -> HealthResponse:
    service = get_whisperx_service()
    return HealthResponse(
        status="ok",
        device=service.device,
        compute_type=service.compute_type,
        whisper_model=settings.whisper_model,
        model_loaded=service.is_model_loaded,
    )
