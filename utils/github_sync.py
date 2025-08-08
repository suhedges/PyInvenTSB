import os
import base64
import json
from pathlib import Path
import requests
from .token_fragments import assemble_token

class GithubSync:
    """
    Best-effort GitHub file pusher. If no token present or network fails,
    it simply no-ops (app keeps working offline with local JSON files).
    """
    def __init__(self, repo_owner: str, repo_name: str, path_prefix: str = ""):
        self.repo_owner = repo_owner
        self.repo_name = repo_name
        self.path_prefix = (path_prefix or "").strip("/")

    def _token(self):
        # 1) direct env var (recommended)
        t = os.environ.get("GITHUB_TOKEN")
        if t:
            return t.strip()
        # 2) encrypted fragments (optional)
        t = assemble_token()
        return t

    def _gh_headers(self):
        tok = self._token()
        if not tok:
            return None
        return {
            "Authorization": f"Bearer {tok}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28"
        }

    def _remote_path_for(self, local_file: Path):
        name = local_file.name
        if self.path_prefix:
            return f"{self.path_prefix}/{name}"
        return name

    def _get_sha(self, remote_path: str):
        headers = self._gh_headers()
        if not headers:
            return None
        url = f"https://api.github.com/repos/{self.repo_owner}/{self.repo_name}/contents/{remote_path}"
        r = requests.get(url, headers=headers, timeout=15)
        if r.status_code == 200:
            return r.json().get("sha")
        return None

    def push_file(self, local_file: Path):
        headers = self._gh_headers()
        if not headers:
            return  # offline / not configured
        remote_path = self._remote_path_for(local_file)
        url = f"https://api.github.com/repos/{self.repo_owner}/{self.repo_name}/contents/{remote_path}"

        content_b64 = base64.b64encode(local_file.read_bytes()).decode("utf-8")
        sha = self._get_sha(remote_path)

        payload = {
            "message": f"Sync {local_file.name}",
            "content": content_b64,
        }
        if sha:
            payload["sha"] = sha

        r = requests.put(url, headers=headers, json=payload, timeout=20)
        # Silently ignore failures; app is still fine offline
        if r.status_code not in (200, 201):
            # print for debugging
            print(f"[SYNC] {remote_path} -> {r.status_code}: {r.text[:200]}")
