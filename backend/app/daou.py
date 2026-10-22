from __future__ import annotations

import json
import logging
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from http.cookiejar import MozillaCookieJar
from typing import Any

from . import config

log = logging.getLogger("daou.client")


class DaouClient:
    def __init__(self) -> None:
        config.DATA_DIR.mkdir(parents=True, exist_ok=True)
        self.cj = MozillaCookieJar(str(config.JAR_PATH))
        if config.JAR_PATH.exists():
            try:
                self.cj.load(ignore_discard=True, ignore_expires=True)
            except Exception:
                pass
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cj))
        self.op.addheaders = [
            ("User-Agent", "Mozilla/5.0 (Macintosh) DaouApp/0.1"),
            ("X-Requested-With", "XMLHttpRequest"),
            ("Accept", "application/json, text/javascript, */*; q=0.01"),
        ]
        self.user: dict[str, Any] | None = None
        self.resource = ""

    def save(self) -> None:
        self.cj.save(ignore_discard=True, ignore_expires=True)

    def _password(self) -> str:
        return subprocess.check_output(
            [
                "security",
                "find-generic-password",
                "-a",
                config.KEYCHAIN_ACCOUNT,
                "-s",
                config.KEYCHAIN_SERVICE,
                "-w",
            ]
        ).decode().strip()

    def request(
        self,
        path: str,
        *,
        data: Any = None,
        method: str | None = None,
        headers: dict | None = None,
        form: dict | None = None,
        raw: bytes | None = None,
        content_type: str | None = None,
    ) -> tuple[int, bytes, Any]:
        hdrs = dict(headers or {})
        body: bytes | None = None
        if form is not None:
            body = urllib.parse.urlencode(form, doseq=True).encode()
            hdrs.setdefault("Content-Type", "application/x-www-form-urlencoded")
            method = method or "POST"
        elif raw is not None:
            body = raw
            if content_type:
                hdrs["Content-Type"] = content_type
            method = method or "POST"
        elif data is not None:
            body = data if isinstance(data, (bytes, bytearray)) else json.dumps(data).encode()
            hdrs.setdefault("Content-Type", "application/json")
            method = method or "POST"
        req = urllib.request.Request(config.BASE_URL + path, data=body, headers=hdrs, method=method)
        try:
            r = self.op.open(req, timeout=60)
            return r.status, r.read(), r.headers
        except urllib.error.HTTPError as e:
            return e.code, e.read(), e.headers

    def ensure_login(self) -> dict[str, Any]:
        s, b, _ = self.request("/api/user/session")
        if s == 200:
            self.user = json.loads(b)["data"]
            return self.user
        log.info("session expired; logging in via Keychain (password not logged)")
        pw = self._password()
        s, b, _ = self.request(
            "/api/login",
            data={
                "username": config.LOGIN_ID,
                "password": pw,
                "captcha": "",
                "returnUrl": "",
            },
        )
        self.save()
        if s != 200:
            raise RuntimeError(f"login failed HTTP {s}")
        s, b, _ = self.request("/api/user/session")
        if s != 200:
            raise RuntimeError(f"session after login HTTP {s}")
        self.user = json.loads(b)["data"]
        self.save()
        return self.user

    def get_json(self, path: str) -> Any:
        s, b, _ = self.request(path)
        if s == 401:
            self.ensure_login()
            s, b, _ = self.request(path)
        if s != 200:
            raise RuntimeError(f"{path} -> {s}")
        return json.loads(b)

    def user_seq(self) -> int:
        assert self.user
        return int(self.user["id"])

    def login_for_xmpp(self) -> str:
        assert self.user
        rid = self.user.get("repId")
        for c in self.user.get("companies") or []:
            if c.get("userId") == rid:
                return c.get("userLoginId") or self.user["loginId"]
        return self.user["loginId"]

    def list_rooms(self) -> list[dict]:
        uid = self.user_seq()
        out: list[dict] = []
        page = 0
        while page < 20:
            d = self.get_json(f"/api/chat/new/buddies?offset=40&page={page}&userSeq={uid}")
            chunk = d.get("data") or []
            out.extend(chunk)
            if not d.get("hasNext") or not chunk:
                break
            page += 1
        return out

    def normalize_room(self, r: dict) -> dict:
        uid = self.user_seq()
        if r.get("buddySeq") is not None:
            kind, seq = "buddy", int(r["buddySeq"])
        elif r.get("roomSeq") is not None:
            kind, seq = "room", int(r["roomSeq"])
        elif r.get("pubsubSeq") is not None:
            kind, seq = "pubsub", int(r["pubsubSeq"])
        else:
            kind, seq = "unknown", 0
        name = r.get("chatRoomName") or r.get("buddyName") or r.get("memberName") or "?"
        is_self = kind == "buddy" and seq == uid
        return {
            "key": f"{kind}:{seq}:{r.get('userSeq', uid)}",
            "kind": kind,
            "seq": seq,
            "name": name,
            "preview": (r.get("message") or "")[:200],
            "messageId": r.get("messageId"),
            "unread": int(r.get("unreadMessageCount") or 0),
            "createdAt": r.get("createdAt"),
            "usePin": bool(r.get("usePin")),
            "usePush": r.get("usePush", True),
            "avatar": r.get("userImage") or "",
            "memberCount": r.get("memberCount"),
            "isSelf": is_self,
            "raw": {k: r[k] for k in r if k not in ("message",)},
        }

    def fetch_messages(self, kind: str, seq: int, size: int = 40, before: int | None = None) -> list[dict]:
        uid = self.user_seq()
        path_kind = {"buddy": "buddies", "room": "rooms", "pubsub": "pubsubs"}.get(kind)
        if not path_kind:
            return []
        path = f"/api/chat/{path_kind}/{seq}?size={size}&userSeq={uid}"
        if before:
            path += f"&criteriaMessageId={before}"
        d = self.get_json(path)
        return [self.normalize_message(m) for m in (d.get("data") or [])]

    def normalize_message(self, m: dict) -> dict:
        attach = m.get("chatMessageAttachFileModel") or m.get("attach")
        mid = m.get("messageId")
        try:
            mid = int(mid) if mid is not None and mid != "" else None
        except (TypeError, ValueError):
            mid = None
        return {
            "messageId": mid,
            "sendUserSeq": m.get("sendUserSeq"),
            "sendUserName": m.get("sendUserName") or "",
            "targetUserSeq": m.get("targetUserSeq"),
            "message": m.get("message") or "",
            "createdAt": m.get("createdAt"),
            "userImage": m.get("userImage") or "",
            "companyId": m.get("companyId"),
            "confirmCount": m.get("confirmCount"),
            "needConfirmCount": m.get("needConfirmCount"),
            "attach": attach,
            "messageType": m.get("messageType") or m.get("subtype") or "text",
        }

    def send_message(self, kind: str, seq: int, text: str) -> dict:
        """POST send. Caller must gate self-only testing."""
        uid = self.user_seq()
        path_kind = {"buddy": "buddies", "room": "rooms", "pubsub": "pubsubs"}[kind]
        import random
        import time

        if not self.resource:
            self.resource = f"go_pc_{uid}_{random.randint(100, 999)}_daouapp"
        form = {
            "message": text,
            "resource": self.resource,
            "userSeq": str(uid),
            "tempMessageId": str(time.time()),
        }
        s, b, _ = self.request(f"/api/chat/{path_kind}/{seq}", form=form)
        if s == 401:
            self.ensure_login()
            s, b, _ = self.request(f"/api/chat/{path_kind}/{seq}", form=form)
        if s != 200:
            raise RuntimeError(f"send failed HTTP {s}")
        return json.loads(b)

    def search_buddies(self, keyword: str) -> list[dict]:
        uid = self.user_seq()
        d = self.get_json(
            f"/api/chat/buddies/search?keyword={urllib.parse.quote(keyword)}&userSeq={uid}"
        )
        return [self.normalize_room(r) for r in (d.get("data") or [])]

    def list_users(self) -> list[dict]:
        assert self.user
        cid = self.user.get("companyId")
        if not cid and self.user.get("companies"):
            cid = self.user["companies"][0].get("id")
        d = self.get_json(f"/api/users/accessible/entire?companyId={cid}")
        users = []
        for u in d.get("data") or []:
            users.append(
                {
                    "userId": u.get("userId") or u.get("repId"),
                    "name": u.get("name") or "",
                    "position": u.get("position") or "",
                    "email": u.get("email") or "",
                    "thumbnail": u.get("thumbnail") or "",
                    "status": u.get("status") or "",
                    "departmentIds": u.get("departmentIds") or [],
                }
            )
        return users

    def proxy_bytes(self, path: str) -> tuple[bytes, str]:
        if not path.startswith("/"):
            path = "/" + path
        s, b, h = self.request(path)
        if s == 401:
            self.ensure_login()
            s, b, h = self.request(path)
        if s != 200:
            raise RuntimeError(f"proxy {path} -> {s}")
        ct = h.get("Content-Type") if h else "application/octet-stream"
        return b, ct or "application/octet-stream"
