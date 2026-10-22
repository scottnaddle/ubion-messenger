from __future__ import annotations
import os
from pathlib import Path

BASE_URL = os.environ.get("DAOU_BASE", "https://coco.ubion.co.kr")
XMPP_DOMAIN = os.environ.get("DAOU_XMPP_DOMAIN", "xmppdaou.com")
XMPP_HOST = os.environ.get("DAOU_XMPP_HOST", "coco.ubion.co.kr")
XMPP_PORT = int(os.environ.get("DAOU_XMPP_PORT", "5222"))
LOGIN_ID = os.environ.get("DAOU_LOGIN_ID", "cwdaddy")
KEYCHAIN_SERVICE = os.environ.get("DAOU_KEYCHAIN_SERVICE", "daou-coco")
KEYCHAIN_ACCOUNT = os.environ.get("DAOU_KEYCHAIN_ACCOUNT", LOGIN_ID)
HOST = os.environ.get("DAOU_BIND", "127.0.0.1")
PORT = int(os.environ.get("DAOU_PORT", "8787"))
DATA_DIR = Path(os.environ.get("DAOU_DATA", Path.home() / ".daou-app"))
JAR_PATH = DATA_DIR / "cookies.txt"
ALPH = "nstopqrdefmabuvwxyzcghijkl"

def xmpp_key(login_id: str) -> str:
    out = []
    for n in range(10):
        r = n // len(login_id)
        i = n - r * len(login_id)
        ch = login_id[i]
        code = ord(ch) + 9 + 3 * r
        out.append(ALPH[int(code * (i + 1) % 26)])
    return "".join(out)
