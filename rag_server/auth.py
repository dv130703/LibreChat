"""Authentication for requests coming from LibreChat.

LibreChat signs a short-lived (5 minute) HS256 token for every RAG call with the
same JWT_SECRET it uses for its own sessions, carrying the user id as `id`:

    jwt.sign({ id: userId }, process.env.JWT_SECRET, { expiresIn: '5m', algorithm: 'HS256' })

The `id` claim is the only tenant boundary the vector store has, so every read
and write must be scoped by the value returned here.
"""

import jwt
from fastapi import Header, HTTPException

from config import JWT_SECRET


def _decode(token: str) -> dict:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token has expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid authentication token")


def get_user_id(authorization: str = Header(default="")) -> str:
    """FastAPI dependency resolving the caller to a LibreChat user id."""
    scheme, _, token = authorization.partition(" ")

    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status_code=401, detail="Missing bearer token")

    user_id = _decode(token).get("id")
    if not user_id:
        raise HTTPException(status_code=401, detail="Token is missing the user id claim")

    return str(user_id)
