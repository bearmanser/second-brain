import json
import math
import re

PROTOCOL_VERSION = 1
MAX_LINE_BYTES = 262144
MAX_BATCH_ITEMS = 8
MAX_QUERY_CHARS = 8000
MAX_TITLE_CHARS = 1024
MAX_HEADING_CHARS = 1024
MAX_EXCERPT_CHARS = 8000
MAX_CHUNK_KEY_CHARS = 512
MAX_INPUT_TOKENS = 65536
PROBABILITY_KEYS = ("A", "B", "C")
PROBABILITY_SUM_TOLERANCE = 0.002
EXACT_SUM_TOLERANCE = 1e-12
ID_PATTERN = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
ERROR_CODES = frozenset(
    {
        "invalid_json",
        "line_too_long",
        "invalid_request",
        "unsupported_version",
        "input_too_long",
        "inference_failed",
    }
)
REQUEST_FIELDS = frozenset({"v", "id", "action", "payload"})
PAYLOAD_FIELDS = frozenset({"query", "items"})
ITEM_REQUIRED_FIELDS = frozenset({"chunk_key", "title", "excerpt"})
ITEM_FIELDS = ITEM_REQUIRED_FIELDS | {"heading"}
SCORE_FIELDS = frozenset({"chunk_key", "probabilities", "input_tokens", "truncated"})


class ProtocolError(ValueError):
    def __init__(self, code, request_id=None):
        if code not in ERROR_CODES:
            raise ValueError("unknown protocol error code")
        super().__init__(code)
        self.code = code
        self.request_id = request_id


def _is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def normalize_probabilities(value):
    if not isinstance(value, dict) or set(value.keys()) != set(PROBABILITY_KEYS):
        raise ValueError("probabilities must contain exactly A, B, and C")
    numbers = {}
    for key in PROBABILITY_KEYS:
        item = value[key]
        if not _is_number(item):
            raise ValueError("probabilities must be numbers")
        number = float(item)
        if not math.isfinite(number) or number < 0.0 or number > 1.0:
            raise ValueError("probabilities must be finite values in [0, 1]")
        numbers[key] = number
    total = math.fsum(numbers.values())
    if total <= 0.0 or abs(total - 1.0) > PROBABILITY_SUM_TOLERANCE:
        raise ValueError("probabilities must sum to 1")
    if abs(total - 1.0) <= EXACT_SUM_TOLERANCE:
        return numbers
    return {key: numbers[key] / total for key in PROBABILITY_KEYS}


def _reject_constant(_value):
    raise ValueError("non-finite JSON constant")


def _bounded_text(value, limit, allow_blank=False):
    if not isinstance(value, str) or len(value) > limit:
        return False
    if not allow_blank and value.strip() == "":
        return False
    return True


def _parse_item(item, request_id):
    if not isinstance(item, dict):
        raise ProtocolError("invalid_request", request_id)
    keys = set(item.keys())
    if not ITEM_REQUIRED_FIELDS <= keys or not keys <= ITEM_FIELDS:
        raise ProtocolError("invalid_request", request_id)
    heading = item.get("heading")
    if not _bounded_text(item["chunk_key"], MAX_CHUNK_KEY_CHARS):
        raise ProtocolError("invalid_request", request_id)
    if not _bounded_text(item["title"], MAX_TITLE_CHARS, allow_blank=True):
        raise ProtocolError("invalid_request", request_id)
    if not _bounded_text(item["excerpt"], MAX_EXCERPT_CHARS, allow_blank=True):
        raise ProtocolError("invalid_request", request_id)
    if heading is not None and not _bounded_text(heading, MAX_HEADING_CHARS, allow_blank=True):
        raise ProtocolError("invalid_request", request_id)
    return {
        "chunk_key": item["chunk_key"],
        "title": item["title"],
        "heading": heading,
        "excerpt": item["excerpt"],
    }


def parse_request(line):
    if not isinstance(line, (bytes, bytearray)):
        raise ProtocolError("invalid_json")
    if len(line) > MAX_LINE_BYTES:
        raise ProtocolError("line_too_long")
    try:
        document = json.loads(bytes(line).decode("utf-8"), parse_constant=_reject_constant)
    except (UnicodeDecodeError, ValueError):
        raise ProtocolError("invalid_json") from None
    if not isinstance(document, dict):
        raise ProtocolError("invalid_request")
    raw_id = document.get("id")
    request_id = raw_id if isinstance(raw_id, str) and ID_PATTERN.match(raw_id) else None
    if set(document.keys()) != REQUEST_FIELDS or request_id is None:
        raise ProtocolError("invalid_request", request_id)
    version = document["v"]
    if not isinstance(version, int) or isinstance(version, bool):
        raise ProtocolError("invalid_request", request_id)
    if version != PROTOCOL_VERSION:
        raise ProtocolError("unsupported_version", request_id)
    if document["action"] != "score":
        raise ProtocolError("invalid_request", request_id)
    payload = document["payload"]
    if not isinstance(payload, dict) or set(payload.keys()) != PAYLOAD_FIELDS:
        raise ProtocolError("invalid_request", request_id)
    if not _bounded_text(payload["query"], MAX_QUERY_CHARS):
        raise ProtocolError("invalid_request", request_id)
    items = payload["items"]
    if not isinstance(items, list) or not 1 <= len(items) <= MAX_BATCH_ITEMS:
        raise ProtocolError("invalid_request", request_id)
    parsed = [_parse_item(item, request_id) for item in items]
    keys = [item["chunk_key"] for item in parsed]
    if len(set(keys)) != len(keys):
        raise ProtocolError("invalid_request", request_id)
    return {"id": request_id, "query": payload["query"], "items": parsed}


def _validate_score(score):
    if not isinstance(score, dict) or set(score.keys()) != SCORE_FIELDS:
        raise ProtocolError("inference_failed")
    tokens = score["input_tokens"]
    if not isinstance(tokens, int) or isinstance(tokens, bool) or not 1 <= tokens <= MAX_INPUT_TOKENS:
        raise ProtocolError("inference_failed")
    if not isinstance(score["truncated"], bool):
        raise ProtocolError("inference_failed")
    try:
        probabilities = normalize_probabilities(score["probabilities"])
    except ValueError:
        raise ProtocolError("inference_failed") from None
    return {
        "chunk_key": score["chunk_key"],
        "probabilities": probabilities,
        "input_tokens": tokens,
        "truncated": score["truncated"],
    }


def validate_scores(expected_keys, scores):
    if not isinstance(scores, list) or len(scores) != len(expected_keys):
        raise ProtocolError("inference_failed")
    by_key = {}
    for score in scores:
        checked = _validate_score(score)
        key = checked["chunk_key"]
        if key in by_key or key not in expected_keys:
            raise ProtocolError("inference_failed")
        by_key[key] = checked
    if set(by_key) != set(expected_keys):
        raise ProtocolError("inference_failed")
    return [by_key[key] for key in expected_keys]


def encode_message(message):
    text = json.dumps(message, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    line = (text + "\n").encode("utf-8")
    if len(line) > MAX_LINE_BYTES:
        raise ProtocolError("line_too_long")
    return line


def ready_message(model_fingerprint, question_version, runtime):
    return {
        "v": PROTOCOL_VERSION,
        "type": "ready",
        "model_fingerprint": model_fingerprint,
        "question_version": question_version,
        "runtime": dict(runtime),
    }


def result_message(request_id, scores):
    return {"v": PROTOCOL_VERSION, "type": "result", "id": request_id, "scores": list(scores)}


def error_message(request_id, code):
    if code not in ERROR_CODES:
        raise ValueError("unknown protocol error code")
    return {"v": PROTOCOL_VERSION, "type": "error", "id": request_id, "code": code}


def diagnostic_message(event, error_class=None):
    message = {"v": PROTOCOL_VERSION, "type": "diagnostic", "event": event}
    if error_class is not None:
        message["error_class"] = error_class
    return message
