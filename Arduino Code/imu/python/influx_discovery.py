import time
import urllib.request
import urllib.error
from pathlib import Path

CANDIDATES_FILE = Path(__file__).with_name("influx_candidates.txt")

def load_candidates():
    if not CANDIDATES_FILE.exists():
        raise RuntimeError(f"Missing {CANDIDATES_FILE}")
    lines = [x.strip() for x in CANDIDATES_FILE.read_text().splitlines()]
    return [x for x in lines if x and not x.startswith("#")]

def is_reachable(base_url: str, token: str, timeout: float = 2.0) -> bool:
    req = urllib.request.Request(f"{base_url.rstrip('/')}/health")
    req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status < 500
    except urllib.error.HTTPError as e:
        # 401/403 still proves host+port are reachable
        return e.code in (401, 403)
    except Exception:
        return False

def pick_influx_url(logger, token: str, retry_seconds: int = 2) -> str:
    candidates = load_candidates()
    while True:
        for url in candidates:
            if is_reachable(url, token):
                logger.info(f"Using Influx URL: {url}")
                return url
        logger.warning("Influx not reachable, retrying...")
        time.sleep(retry_seconds)
