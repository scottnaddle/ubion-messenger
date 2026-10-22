from __future__ import annotations

import asyncio
import logging
import random
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import config
from .daou import DaouClient
from .xmpp_client import XmppClient

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("daou.app")

ROOT = Path(__file__).resolve().parents[2]
DIST = ROOT / "frontend" / "dist"

client = DaouClient()
xmpp: XmppClient | None = None
ws_clients: set[WebSocket] = set()
loop: asyncio.AbstractEventLoop | None = None
event_queue: asyncio.Queue | None = None


async def broadcaster() -> None:
    assert event_queue
    while True:
        evt = await event_queue.get()
        dead = []
        for ws in list(ws_clients):
            try:
                await ws.send_json(evt)
            except Exception:
                dead.append(ws)
        for ws in dead:
            ws_clients.discard(ws)


def _push(evt: dict[str, Any]) -> None:
    if loop and event_queue:
        loop.call_soon_threadsafe(event_queue.put_nowait, evt)


def _on_xmpp_message(obj: dict) -> None:
    # Normalize for UI; mask nothing here — UI decides. Avoid logging body.
    fr = obj.get("from") or {}
    subtype = obj.get("subtype") or ""
    mtype = obj.get("type") or "message"
    if mtype in ("confirm",) and not obj.get("message"):
        _push({"type": "confirm", "payload": {"messageId": obj.get("messageId")}})
        return
    if mtype == "presence":
        _push({"type": "presence", "payload": obj})
        return
    room_kind = "buddy"
    room_seq = None
    me = client.user_seq() if client.user else None
    if subtype in ("single",):
        from_seq = fr.get("userSeq")
        to_seq = obj.get("toSeq")
        if from_seq == me:
            room_seq = to_seq
        else:
            room_seq = from_seq
        room_kind = "buddy"
    elif subtype in ("group", "roomjoin", "roomleave", "roomkickout") or obj.get("toSeq"):
        room_kind = "room"
        room_seq = obj.get("toSeq")
    elif subtype == "pubsub":
        room_kind = "pubsub"
        room_seq = fr.get("userSeq") or obj.get("toSeq")
    payload = {
        "messageId": obj.get("messageId"),
        "sendUserSeq": fr.get("userSeq"),
        "sendUserName": fr.get("userName") or "",
        "message": obj.get("message") or "",
        "createdAt": obj.get("createdAt") or obj.get("sendDate"),
        "userImage": fr.get("userImg") or "",
        "roomKind": room_kind,
        "roomSeq": room_seq,
        "subtype": subtype,
        "rawType": mtype,
        "usePush": obj.get("usePush", True),
    }
    _push({"type": "message", "payload": payload})
    # Optional macOS notification fallback (snippet only)
    try:
        name = (payload["sendUserName"] or "메시지")[:40]
        snippet = (payload["message"] or "")[:80].replace('"', "'")
        if payload["usePush"] and snippet and mtype == "message":
            import subprocess

            subprocess.Popen(
                [
                    "osascript",
                    "-e",
                    f'display notification "{snippet}" with title "Daou" subtitle "{name}"',
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
    except Exception:
        pass


def _on_xmpp_status(state: str, extra: dict) -> None:
    _push({"type": "xmpp", "payload": {"state": state, **extra}})


def start_xmpp() -> None:
    global xmpp
    assert client.user
    if xmpp:
        xmpp.stop()
    key = config.xmpp_key(client.login_for_xmpp())
    res = client.resource or f"go_pc_{client.user_seq()}_{random.randint(100,999)}_daouapp"
    client.resource = res
    xmpp = XmppClient(
        str(client.user.get("repId")),
        key,
        resource=res,
        on_message=_on_xmpp_message,
        on_status=_on_xmpp_status,
    )
    xmpp.start()


@asynccontextmanager
async def lifespan(app: FastAPI):
    global loop, event_queue
    loop = asyncio.get_running_loop()
    event_queue = asyncio.Queue()
    task = asyncio.create_task(broadcaster())
    try:
        client.ensure_login()
        start_xmpp()
        log.info("ready userSeq=%s port=%s", client.user_seq(), config.PORT)
    except Exception as e:
        log.error("startup login/xmpp failed: %s", type(e).__name__)
    yield
    if xmpp:
        xmpp.stop()
    task.cancel()


app = FastAPI(title="Daou App", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class SendBody(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    confirmSelf: bool = False


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "loggedIn": bool(client.user),
        "xmpp": bool(xmpp and xmpp.connected),
        "userSeq": client.user["id"] if client.user else None,
    }


@app.post("/api/auth/login")
def login():
    try:
        u = client.ensure_login()
        start_xmpp()
        return {
            "ok": True,
            "user": {
                "id": u["id"],
                "name": u.get("name"),
                "loginId": u.get("loginId"),
                "companyId": u.get("companyId"),
                "thumbnail": u.get("thumbnail"),
            },
        }
    except Exception as e:
        raise HTTPException(500, f"login failed: {type(e).__name__}") from e


@app.get("/api/me")
def me():
    if not client.user:
        client.ensure_login()
    u = client.user
    assert u
    return {
        "id": u["id"],
        "name": u.get("name"),
        "loginId": u.get("loginId"),
        "companyId": u.get("companyId"),
        "thumbnail": u.get("thumbnail"),
        "position": u.get("position"),
        "xmppConnected": bool(xmpp and xmpp.connected),
    }


@app.get("/api/rooms")
def rooms():
    if not client.user:
        client.ensure_login()
    raw = client.list_rooms()
    norm = [client.normalize_room(r) for r in raw]
    # sort: pin first, then recent createdAt/messageId
    norm.sort(key=lambda r: (not r["usePin"], -(r.get("messageId") or 0)))
    return {"rooms": norm, "count": len(norm)}


@app.get("/api/rooms/{kind}/{seq}/messages")
def messages(kind: str, seq: int, size: int = 40, before: int | None = None):
    if kind not in ("buddy", "room", "pubsub"):
        raise HTTPException(400, "bad kind")
    if not client.user:
        client.ensure_login()
    msgs = client.fetch_messages(kind, seq, size=size, before=before)
    return {"messages": msgs}


@app.post("/api/rooms/{kind}/{seq}/messages")
def send(kind: str, seq: int, body: SendBody):
    if kind not in ("buddy", "room", "pubsub"):
        raise HTTPException(400, "bad kind")
    if not client.user:
        client.ensure_login()
    # Safety: require confirmSelf when target is not clearly self-memo
    is_self = kind == "buddy" and seq == client.user_seq()
    if not is_self and not body.confirmSelf:
        raise HTTPException(
            403,
            "Send blocked: not a self-chat. Pass confirmSelf=true only for intentional sends.",
        )
    try:
        res = client.send_message(kind, seq, body.text)
        data = res.get("data") or res
        return {"ok": True, "messageId": data.get("messageId"), "self": is_self}
    except Exception as e:
        raise HTTPException(500, f"send failed: {type(e).__name__}") from e


@app.get("/api/search")
def search(q: str = Query("", min_length=0)):
    if not client.user:
        client.ensure_login()
    q = q.strip()
    rooms_hit = []
    people = []
    if q:
        try:
            rooms_hit = client.search_buddies(q)
        except Exception:
            rooms_hit = []
        try:
            all_u = client.list_users()
            ql = q.lower()
            people = [u for u in all_u if ql in u["name"].lower() or ql in (u.get("email") or "").lower()][:40]
        except Exception:
            people = []
    return {"rooms": rooms_hit, "people": people}


@app.get("/api/users")
def users():
    if not client.user:
        client.ensure_login()
    return {"users": client.list_users()}


@app.get("/api/proxy")
def proxy(path: str = Query(..., min_length=1)):
    if ".." in path or path.startswith("http"):
        raise HTTPException(400, "bad path")
    try:
        data, ct = client.proxy_bytes(path)
        return Response(content=data, media_type=ct)
    except Exception as e:
        raise HTTPException(404, type(e).__name__) from e


@app.websocket("/ws/events")
async def ws_events(ws: WebSocket):
    await ws.accept()
    ws_clients.add(ws)
    try:
        await ws.send_json(
            {
                "type": "hello",
                "payload": {
                    "xmpp": bool(xmpp and xmpp.connected),
                    "userSeq": client.user["id"] if client.user else None,
                },
            }
        )
        while True:
            # keep alive; ignore client messages
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        ws_clients.discard(ws)


if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/")
    def index():
        return FileResponse(DIST / "index.html")

    @app.get("/{full_path:path}")
    def spa(full_path: str):
        # SPA fallback; don't steal /api or /ws
        if full_path.startswith(("api/", "ws/")):
            raise HTTPException(404)
        candidate = DIST / full_path
        if candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(DIST / "index.html")


def cli() -> None:
    import uvicorn

    uvicorn.run(
        "backend.app.main:app",
        host=config.HOST,
        port=config.PORT,
        reload=False,
        log_level="info",
    )


if __name__ == "__main__":
    cli()
