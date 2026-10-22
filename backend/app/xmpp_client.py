from __future__ import annotations

import base64
import json
import logging
import random
import re
import select
import socket
import threading
import time
from collections.abc import Callable
from typing import Any

from . import config

log = logging.getLogger("daou.xmpp")

OnMessage = Callable[[dict[str, Any]], None]
OnStatus = Callable[[str, dict], None]


class XmppClient:
    """Long-lived plain-TCP XMPP client (Openfire, no STARTTLS)."""

    def __init__(
        self,
        jid_local: str,
        password: str,
        *,
        on_message: OnMessage | None = None,
        on_status: OnStatus | None = None,
        resource: str | None = None,
    ) -> None:
        self.jid_local = str(jid_local)
        self.password = password
        self.resource = resource or f"go_pc_{jid_local}_{random.randint(100, 999)}_daouapp"
        self.on_message = on_message
        self.on_status = on_status
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.connected = False
        self.last_error = ""

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="xmpp", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _emit_status(self, state: str, **extra: Any) -> None:
        if self.on_status:
            try:
                self.on_status(state, extra)
            except Exception:
                pass

    def _run(self) -> None:
        backoff = 1.0
        while not self._stop.is_set():
            try:
                self._session()
                backoff = 1.0
            except Exception as e:
                self.connected = False
                self.last_error = type(e).__name__
                log.warning("xmpp session ended: %s", type(e).__name__)
                self._emit_status("disconnected", error=type(e).__name__)
            if self._stop.is_set():
                break
            time.sleep(backoff)
            backoff = min(backoff * 2, 30.0)

    def _recv_until(self, sock: socket.socket, pred, limit=40, timeout=20) -> bytes:
        sock.settimeout(timeout)
        data = b""
        for _ in range(limit):
            chunk = sock.recv(65536)
            if not chunk:
                break
            data += chunk
            if pred(data):
                break
        return data

    def _session(self) -> None:
        sock = socket.create_connection((config.XMPP_HOST, config.XMPP_PORT), timeout=20)
        open_stream = (
            "<?xml version='1.0'?><stream:stream to='%s' xmlns='jabber:client' "
            "xmlns:stream='http://etherx.jabber.org/streams' version='1.0'>"
            % config.XMPP_DOMAIN
        ).encode()
        try:
            sock.sendall(open_stream)
            feat = self._recv_until(sock, lambda d: b"</stream:features>" in d)
            if b"PLAIN" not in feat:
                raise RuntimeError("PLAIN not offered")
            auth = base64.b64encode(
                b"\x00" + self.jid_local.encode() + b"\x00" + self.password.encode()
            ).decode()
            sock.sendall(
                (
                    "<auth xmlns='urn:ietf:params:xml:ns:xmpp-sasl' mechanism='PLAIN'>%s</auth>"
                    % auth
                ).encode()
            )
            resp = self._recv_until(sock, lambda d: b"<success" in d or b"<failure" in d)
            if b"<success" not in resp:
                raise RuntimeError("SASL failed")
            sock.sendall(open_stream)
            self._recv_until(sock, lambda d: b"</stream:features>" in d)
            sock.sendall(
                (
                    "<iq type='set' id='bind1'><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'>"
                    "<resource>%s</resource></bind></iq>" % self.resource
                ).encode()
            )
            bind = self._recv_until(sock, lambda d: b"</iq>" in d)
            if b"<jid>" not in bind:
                raise RuntimeError("bind failed")
            sock.sendall(
                b"<iq type='set' id='sess1'><session xmlns='urn:ietf:params:xml:ns:xmpp-session'/></iq>"
            )
            self._recv_until(sock, lambda d: b'id="sess1"' in d or b"</iq>" in d)
            sock.sendall(b"<presence><status>online:on</status></presence>")
            self.connected = True
            self._emit_status("connected", resource=self.resource)
            log.info("xmpp connected resource=…")
            self._loop(sock)
        finally:
            self.connected = False
            try:
                sock.sendall(
                    b"<presence type='unavailable'><status>terminated PC messenger</status></presence>"
                )
                sock.sendall(b"</stream:stream>")
                sock.close()
            except Exception:
                pass

    def _loop(self, sock: socket.socket) -> None:
        buf = b""
        sock.setblocking(False)
        last_ping = time.time()
        while not self._stop.is_set():
            r, _, _ = select.select([sock], [], [], 1.0)
            if time.time() - last_ping > 55:
                try:
                    sock.sendall(
                        (
                            "<iq type='get' id='ping-%d' to='%s'>"
                            "<ping xmlns='urn:xmpp:ping'/></iq>"
                            % (int(time.time()), config.XMPP_DOMAIN)
                        ).encode()
                    )
                except Exception:
                    raise
                last_ping = time.time()
            if not r:
                continue
            try:
                chunk = sock.recv(65536)
            except BlockingIOError:
                continue
            if not chunk:
                raise RuntimeError("socket closed")
            buf += chunk
            buf = self._consume(sock, buf)

    def _consume(self, sock: socket.socket, buf: bytes) -> bytes:
        while True:
            m = re.search(br"<iq[^>]*type=['\"]get['\"][^>]*>.*?</iq>", buf, re.DOTALL)
            if not m:
                break
            iq = m.group(0)
            buf = buf[: m.start()] + buf[m.end() :]
            idm = re.search(br'id=["\']([^"\']+)["\']', iq)
            frm = re.search(br'from=["\']([^"\']+)["\']', iq)
            if not (idm and frm):
                continue
            rid, fr = idm.group(1).decode(), frm.group(1).decode()
            if b"jabber:iq:version" in iq:
                sock.sendall(
                    (
                        f"<iq type='result' id='{rid}' to='{fr}'>"
                        "<query xmlns='jabber:iq:version'><name>daou-app</name>"
                        "<version>0.1</version></query></iq>"
                    ).encode()
                )
            elif b"urn:xmpp:ping" in iq:
                sock.sendall(f"<iq type='result' id='{rid}' to='{fr}'/>".encode())
        while True:
            m = re.search(br"<message\b[^>]*>.*?</message>", buf, re.DOTALL)
            if not m:
                if len(buf) > 400000:
                    buf = buf[-80000:]
                break
            raw = m.group(0)
            buf = buf[: m.start()] + buf[m.end() :]
            bm = re.search(br"<body[^>]*>(.*?)</body>", raw, re.DOTALL)
            if not bm:
                continue
            body = (
                bm.group(1)
                .decode("utf-8", "replace")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&amp;", "&")
                .replace("&quot;", '"')
            )
            try:
                obj = json.loads(body)
            except Exception:
                obj = {"message": body, "type": "raw"}
            if self.on_message:
                try:
                    self.on_message(obj)
                except Exception:
                    log.exception("on_message")
        return buf
