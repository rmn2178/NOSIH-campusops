"""NOSIH API application entrypoint.

Wires every HTTP router, the two realtime channels and the uploads directory.
Campus seed data is generated deterministically on first boot, never at import
time, so tests can control their own database lifecycle.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager, suppress
from pathlib import Path

import jwt
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select

from app.config import settings
from app.database import SessionLocal, init_db
from app.engines.sla_escalator import tick_sla_clocks
from app.models import User
from app.routers import (
    admin_router,
    audit_router,
    auth_router,
    compat_router,
    complaints_router,
    integrations_router,
    locks_router,
    operations_router,
    procurement_router,
    timetable_router,
    twin_router,
    uploads_router,
)
from app.seed.seed_campus import seed_if_empty
from app.ws_manager import ws_hub

UPLOAD_DIRECTORY = Path(settings.upload_dir)
UPLOAD_DIRECTORY.mkdir(parents=True, exist_ok=True)


def _seed_database() -> None:
    init_db()
    with SessionLocal() as db:
        seed_if_empty(db)


async def _sla_tick_loop() -> None:
    while True:
        await asyncio.sleep(60)
        try:
            with SessionLocal() as db:
                tick_sla_clocks(db)
                db.commit()
        except Exception:
            # A failed tick must never take down the API process.
            continue


@asynccontextmanager
async def lifespan(_: FastAPI):
    _seed_database()
    ticker = asyncio.create_task(_sla_tick_loop())
    try:
        yield
    finally:
        ticker.cancel()
        with suppress(asyncio.CancelledError):
            await ticker


app = FastAPI(
    title="NOSIH Campus Operating System",
    description="Digital twin, incident response, procurement and audit API for the NOSIH campus.",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_origin_regex=settings.cors_origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

for module in (
    auth_router,
    uploads_router,
    complaints_router,
    admin_router,
    compat_router,
    operations_router,
    locks_router,
    procurement_router,
    integrations_router,
    timetable_router,
    twin_router,
    audit_router,
):
    app.include_router(module.router)

app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIRECTORY)), name="uploads")


@app.get("/api/health", tags=["system"])
def health() -> dict[str, str]:
    return {"status": "ok", "service": "nosih-api"}


def _authenticate_socket(token: str | None) -> User | None:
    if not token:
        return None
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
        user_id = int(payload["sub"])
    except (jwt.PyJWTError, ValueError, KeyError):
        return None
    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.id == user_id))
        return user if user and user.is_active else None


async def _socket_session(websocket: WebSocket, channel: str) -> None:
    user = _authenticate_socket(websocket.query_params.get("token"))
    if user is None:
        await websocket.close(code=4401)
        return
    await ws_hub.connect(channel, websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        ws_hub.disconnect(channel, websocket)


@app.websocket("/ws/portal")
async def portal_socket(websocket: WebSocket) -> None:
    await _socket_session(websocket, "portal")


@app.websocket("/ws/twin")
async def twin_socket(websocket: WebSocket) -> None:
    await _socket_session(websocket, "twin")
