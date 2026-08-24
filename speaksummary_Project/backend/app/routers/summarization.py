import httpx
from fastapi import APIRouter, Depends, HTTPException

from ..schemas import OllamaModel, OllamaModelsResponse, SummarizeRequest, SummaryResponse
from ..services.ollama_service import OllamaService, get_ollama_service

router = APIRouter(prefix="/api", tags=["summarization"])


@router.get("/ollama/models", response_model=OllamaModelsResponse)
async def list_ollama_models(service: OllamaService = Depends(get_ollama_service)) -> OllamaModelsResponse:
    try:
        names = await service.list_models()
    except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
        raise HTTPException(status_code=502, detail=f"Could not reach Ollama at {service.base_url}: {exc}") from exc
    return OllamaModelsResponse(models=[OllamaModel(name=name) for name in names])


@router.post("/summarize", response_model=SummaryResponse)
async def summarize(
    request: SummarizeRequest,
    service: OllamaService = Depends(get_ollama_service),
) -> SummaryResponse:
    if not request.segments:
        raise HTTPException(status_code=400, detail="No transcript segments to summarize")

    transcript_text = "\n".join(f"{segment.speaker}: {segment.text}" for segment in request.segments)

    try:
        result = await service.summarize(
            transcript_text, request.style, request.length, request.model, context=request.context
        )
    except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
        raise HTTPException(status_code=502, detail=f"Could not reach Ollama at {service.base_url}: {exc}") from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Summarization failed: {exc}") from exc

    return SummaryResponse(
        overview=result.get("overview", ""),
        key_points=result.get("key_points", []),
        action_items=result.get("action_items", []),
    )
