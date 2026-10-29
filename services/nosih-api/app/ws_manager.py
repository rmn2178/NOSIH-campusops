import json
from collections import defaultdict
from typing import Any

from fastapi import WebSocket


class WebSocketHub:
    def __init__(self) -> None:
        self.channels: dict[str, set[WebSocket]] = defaultdict(set)

    async def connect(self, channel: str, websocket: WebSocket) -> None:
        await websocket.accept()
        self.channels[channel].add(websocket)

    def disconnect(self, channel: str, websocket: WebSocket) -> None:
        self.channels[channel].discard(websocket)

    async def broadcast(self, channel: str, event_type: str, payload: dict[str, Any]) -> None:
        message = json.dumps({"type": event_type, "payload": payload, **payload}, default=str)
        stale: list[WebSocket] = []
        for websocket in tuple(self.channels[channel]):
            try:
                await websocket.send_text(message)
            except RuntimeError:
                stale.append(websocket)
        for websocket in stale:
            self.disconnect(channel, websocket)

    async def broadcast_all(self, event_type: str, payload: dict[str, Any]) -> None:
        for channel in tuple(self.channels):
            await self.broadcast(channel, event_type, payload)


ws_hub = WebSocketHub()
