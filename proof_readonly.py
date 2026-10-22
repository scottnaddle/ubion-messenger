#!/usr/bin/env python3
"""Read-only proof: DaouOffice (Group Office) messenger on coco.ubion.co.kr.

- Login via GOSSOcookie (password from macOS Keychain)
- List rooms (REST)
- Fetch last few messages of one room (REST, no mark-read)
- Listen ~60s for XMPP message stanzas (TCP 5222)
Never prints password, cookie, or XMPP key.
"""
from __future__ import annotations
import argparse, asyncio, http.cookiejar, json, os, random, re, subprocess, sys, time
import urllib.error, urllib.request
from pathlib import Path

BASE = "https://coco.ubion.co.kr"
XMPP_DOMAIN = "xmppdaou.com"
XMPP_HOST = "coco.ubion.co.kr"
XMPP_PORT = 5222
JAR = Path(__file__).resolve().parent / "jar.txt"
ALPH = "nstopqrdefmabuvwxyzcghijkl"

def mask_text(s: str, n: int = 24) -> str:
    s = s.replace("\n", " ").strip()
    return (s[:n] + "…") if len(s) > n else s

def xmpp_key(login_id: str) -> str:
    """Same transform as UBIONMessenger main.prod.js Co()/jo()."""
    out = []
    for n in range(10):
        r = n // len(login_id)
        i = n - r * len(login_id)
        ch = login_id[i]
        code = ord(ch) + 9 + 3 * r
        out.append(ALPH[int(code * (i + 1) % 26)])
    return "".join(out)

def get_password() -> str:
    return subprocess.check_output(
        ["security", "find-generic-password", "-a", "cwdaddy", "-s", "daou-coco", "-w"]
    ).decode().strip()

class Session:
    def __init__(self):
        self.cj = http.cookiejar.MozillaCookieJar(str(JAR))
        if JAR.exists():
            try:
                self.cj.load(ignore_discard=True, ignore_expires=True)
            except Exception:
                pass
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.cj))
        self.op.addheaders = [
            ("User-Agent", "Mozilla/5.0 (Macintosh) DaouMsgProof/0.1"),
            ("X-Requested-With", "XMLHttpRequest"),
            ("Accept", "application/json, text/javascript, */*; q=0.01"),
        ]

    def save(self):
        self.cj.save(ignore_discard=True, ignore_expires=True)

    def request(self, path: str, data=None, method=None, headers=None):
        hdrs = dict(headers or {})
        body = None
        if data is not None:
            body = data if isinstance(data, (bytes, bytearray)) else json.dumps(data).encode()
            hdrs.setdefault("Content-Type", "application/json")
        req = urllib.request.Request(BASE + path, data=body, headers=hdrs, method=method)
        try:
            r = self.op.open(req, timeout=60)
            return r.status, r.read(), r.headers
        except urllib.error.HTTPError as e:
            return e.code, e.read(), e.headers

    def ensure_login(self):
        s, b, _ = self.request("/api/user/session")
        if s == 200:
            return json.loads(b)["data"]
        pw = get_password()
        s, b, _ = self.request(
            "/api/login",
            data={"username": "cwdaddy", "password": pw, "captcha": "", "returnUrl": ""},
        )
        self.save()
        if s != 200:
            raise SystemExit(f"login failed HTTP {s}")
        s, b, _ = self.request("/api/user/session")
        if s != 200:
            raise SystemExit(f"session after login HTTP {s}")
        return json.loads(b)["data"]

    def get_json(self, path: str):
        s, b, _ = self.request(path)
        if s != 200:
            raise RuntimeError(f"{path} -> {s}")
        return json.loads(b)

def pick_room(rooms: list) -> dict:
    # prefer a 1:1 with recent traffic
    for r in rooms:
        if r.get("buddySeq") is not None:
            return r
    return rooms[0]

def room_messages_path(room: dict, user_seq: int, size: int = 5) -> str:
    if room.get("buddySeq") is not None:
        return f"/api/chat/buddies/{room['buddySeq']}?size={size}&userSeq={user_seq}"
    if room.get("roomSeq") is not None:
        return f"/api/chat/rooms/{room['roomSeq']}?size={size}&userSeq={user_seq}"
    raise ValueError("unknown room shape")

def listen_xmpp(jid_local: str, password: str, resource: str, seconds: int = 60):
    """Plain TCP XMPP (Openfire, no STARTTLS). SASL PLAIN with bare localpart."""
    import base64, select, socket

    def recv_until(sock, pred, limit=40, timeout=15):
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

    sock = socket.create_connection((XMPP_HOST, XMPP_PORT), timeout=15)
    print(f"[xmpp] connecting {XMPP_HOST}:{XMPP_PORT} as {jid_local}@{XMPP_DOMAIN}/{resource} for {seconds}s")
    open_stream = (
        "<?xml version='1.0'?><stream:stream to='%s' xmlns='jabber:client' "
        "xmlns:stream='http://etherx.jabber.org/streams' version='1.0'>" % XMPP_DOMAIN
    ).encode()
    sock.sendall(open_stream)
    feat = recv_until(sock, lambda d: b"</stream:features>" in d)
    if b"PLAIN" not in feat:
        print("[xmpp] PLAIN not offered")
        sock.close()
        return False, 0
    auth = base64.b64encode(b"\x00" + jid_local.encode() + b"\x00" + password.encode()).decode()
    sock.sendall(
        ("<auth xmlns='urn:ietf:params:xml:ns:xmpp-sasl' mechanism='PLAIN'>%s</auth>" % auth).encode()
    )
    resp = recv_until(sock, lambda d: b"<success" in d or b"<failure" in d)
    if b"<success" not in resp:
        print("[xmpp] SASL failed")
        sock.close()
        return False, 0
    sock.sendall(open_stream)
    recv_until(sock, lambda d: b"</stream:features>" in d)
    sock.sendall(
        (
            "<iq type='set' id='bind1'><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'>"
            "<resource>%s</resource></bind></iq>" % resource
        ).encode()
    )
    bind = recv_until(sock, lambda d: b"</iq>" in d)
    if b"<jid>" not in bind:
        print("[xmpp] bind failed")
        sock.close()
        return False, 0
    sock.sendall(b"<iq type='set' id='sess1'><session xmlns='urn:ietf:params:xml:ns:xmpp-session'/></iq>")
    recv_until(sock, lambda d: b'id="sess1"' in d or b"</iq>" in d)
    sock.sendall(b"<presence><status>online:on</status></presence>")
    print("[xmpp] session_start OK; listening…")

    buf = b""
    count = 0
    deadline = time.time() + seconds
    sock.setblocking(False)
    while time.time() < deadline:
        r, _, _ = select.select([sock], [], [], 1.0)
        if not r:
            continue
        try:
            chunk = sock.recv(65536)
        except BlockingIOError:
            continue
        if not chunk:
            break
        buf += chunk
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
                        "<query xmlns='jabber:iq:version'><name>daou-proof</name>"
                        "<version>0.1</version></query></iq>"
                    ).encode()
                )
            elif b"urn:xmpp:ping" in iq:
                sock.sendall(f"<iq type='result' id='{rid}' to='{fr}'/>".encode())
        while True:
            m = re.search(br"<message\b[^>]*>.*?</message>", buf, re.DOTALL)
            if not m:
                if len(buf) > 200000:
                    buf = buf[-50000:]
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
            sender = "?"
            snippet = mask_text(body, 40)
            mtype = "?"
            try:
                obj = json.loads(body)
                fr = obj.get("from") or {}
                sender = fr.get("userName") or sender
                snippet = mask_text(str(obj.get("message") or body), 40)
                mtype = obj.get("type") or mtype
            except Exception:
                pass
            print(f"[xmpp] type={mtype} from={sender} msg={snippet!r}")
            count += 1
    try:
        sock.sendall(b"<presence type='unavailable'><status>terminated PC messenger</status></presence>")
        sock.sendall(b"</stream:stream>")
        sock.close()
    except Exception:
        pass
    print(f"[xmpp] done ok=True received={count}")
    return True, count


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--listen", type=int, default=60)
    ap.add_argument("--no-xmpp", action="store_true")
    args = ap.parse_args()

    sess = Session()
    user = sess.ensure_login()
    sess.save()
    user_seq = user["id"]
    login_id = user["loginId"]
    # company login id used by desktop for xmpp key
    co = next((c for c in user.get("companies") or [] if c.get("userId") == user.get("repId")), {})
    login_for_key = co.get("userLoginId") or login_id
    print(f"[ok] session userSeq={user_seq} loginId={login_id} xmppDomain={XMPP_DOMAIN}")

    rooms = sess.get_json(f"/api/chat/new/buddies?offset=40&page=0&userSeq={user_seq}")
    data = rooms.get("data") or []
    print(f"[ok] rooms listed: {len(data)} (page.total={rooms.get('page',{}).get('total')}, hasNext={rooms.get('hasNext')})")
    for i, r in enumerate(data[:8]):
        name = r.get("chatRoomName") or r.get("buddyName") or "?"
        kind = "buddy" if r.get("buddySeq") is not None else ("group" if r.get("roomSeq") else "?")
        seq = r.get("buddySeq") or r.get("roomSeq")
        unread = r.get("unreadMessageCount", 0)
        print(f"  [{i}] {kind}:{seq} unread={unread} name={mask_text(name,40)!r} last={mask_text(str(r.get('message') or ''),30)!r}")

    if not data:
        print("[warn] no rooms; skip message fetch")
        room = None
    else:
        room = pick_room(data)
        path = room_messages_path(room, user_seq, size=5)
        msgs = sess.get_json(path)
        mdata = msgs.get("data") or []
        print(f"[ok] messages from {path.split('?')[0]}: {len(mdata)}")
        for m in mdata[-5:]:
            print(
                f"  id={m.get('messageId')} at={m.get('createdAt')} "
                f"from={m.get('sendUserName')} text={mask_text(str(m.get('message') or ''),30)!r}"
            )

    if args.no_xmpp:
        return
    key = xmpp_key(login_for_key)
    resource = f"go_pc_{user_seq}_{random.randint(100,999)}_proof"
    ok, n = listen_xmpp(str(user.get('repId')), key, resource, seconds=args.listen)
    if not ok:
        sys.exit(2)
    print("[ok] proof complete")

if __name__ == "__main__":
    main()
