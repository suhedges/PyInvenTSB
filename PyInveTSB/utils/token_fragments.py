import os
import base64
from typing import Optional

# Lightweight "fragment assembly" with optional obfuscation.
# Prefer putting a full token in Replit Secrets as GITHUB_TOKEN.
#
# If you *really* want fragments:
#   1) Choose a key phrase and set it as env var KEY_PHRASE in Replit Secrets.
#   2) Split your token into 3 chunks (roughly equal), base64-encode each,
#      then XOR each byte with the bytes of KEY_PHRASE (cycled).
#   3) Store each result in env vars TOK_A, TOK_B, TOK_C (or paste into
#      the Replit Secrets panel).
#
# This isn't strong cryptography—it's lightweight obfuscation to keep the raw
# token out of the repo and the code. Anyone with server access can still
# recover it. For real security, stick to GITHUB_TOKEN only.

def _xor(data: bytes, key: bytes) -> bytes:
    out = bytearray()
    for i, b in enumerate(data):
        out.append(b ^ key[i % len(key)])
    return bytes(out)

def _deobfuscate(part_env: str, key: bytes) -> Optional[str]:
    v = os.environ.get(part_env)
    if not v:
        return None
    try:
        raw = base64.b64decode(v.encode("utf-8"))
        plain = _xor(raw, key)
        return plain.decode("utf-8")
    except Exception:
        return None

def assemble_token() -> Optional[str]:
    # 1) If fragments not provided, return None so sync becomes no-op.
    key_phrase = os.environ.get("KEY_PHRASE")
    if not key_phrase:
        return None
    key = key_phrase.encode("utf-8")

    # 2) Deobfuscate three parts
    p1 = _deobfuscate("TOK_A", key)
    p2 = _deobfuscate("TOK_B", key)
    p3 = _deobfuscate("TOK_C", key)
    if not (p1 and p2 and p3):
        return None

    token = (p1 + p2 + p3).strip()
    if token.startswith("ghp_") or token.startswith("github_pat_"):
        return token
    # not a valid token pattern -> ignore
    return None
