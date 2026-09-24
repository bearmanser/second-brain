import argparse
import contextlib
import hashlib
import io
import json
import os
import platform
import re
import sys
import warnings

from laya import load

from workers.laya.fitting import FittingError, InputTooLong, context_title, fit_state, select_segment
from workers.laya.protocol import (
    MAX_LINE_BYTES,
    ProtocolError,
    diagnostic_message,
    encode_message,
    error_message,
    normalize_probabilities,
    parse_request,
    ready_message,
    result_message,
    validate_scores,
)

EXIT_RUNTIME_INVALID = 3
EXIT_LOAD_FAILED = 4
RECHECK_MAX_BYTES = 1024 * 1024
QUESTION_VERSION_PATTERN = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")
WARMUP_QUERY = "warm up"
WARMUP_TITLE = "Warm up"
WARMUP_EXCERPT = "Warm up excerpt."


def load_local_agent(model_path):
    with contextlib.redirect_stdout(io.StringIO()):
        return load(model_path, device="cpu", fast=False)


def predict_relevance(agent, states, questions):
    with contextlib.redirect_stdout(io.StringIO()):
        results = agent.predict_batch(states, questions, batch_size=8)
    return [item["answers"]["relevance"]["probabilities"] for item in results]


class Channels:
    def __init__(self):
        self.protocol = os.fdopen(os.dup(1), "wb")
        self.diagnostics = os.fdopen(os.dup(2), "wb")
        null = os.open(os.devnull, os.O_WRONLY)
        os.dup2(null, 1)
        os.dup2(null, 2)
        os.close(null)

    def send(self, message):
        self.protocol.write(encode_message(message))
        self.protocol.flush()

    def diagnostic(self, event, error_class=None):
        try:
            self.diagnostics.write(encode_message(diagnostic_message(event, error_class)))
            self.diagnostics.flush()
        except (OSError, ValueError):
            pass


class RuntimeInvalid(Exception):
    pass


def file_digest(path):
    digest = hashlib.sha256()
    size = 0
    with open(path, "rb") as handle:
        while True:
            block = handle.read(1024 * 1024)
            if not block:
                break
            size += len(block)
            digest.update(block)
    return digest.hexdigest(), size


def fingerprint(entries):
    lines = "".join(
        "%s\t%d\t%s\n" % (entry["path"], entry["size"], entry["sha256"])
        for entry in sorted(entries, key=lambda entry: entry["path"])
    )
    return hashlib.sha256(lines.encode("utf-8")).hexdigest()


def check_entry(model_dir, entry):
    path = os.path.join(model_dir, entry["path"])
    if os.path.islink(path) or not os.path.isfile(path):
        raise RuntimeInvalid()
    digest, size = file_digest(path)
    if digest != entry["sha256"] or size != entry["size"]:
        raise RuntimeInvalid()


def verify_runtime(model_dir, lock_path):
    with open(lock_path, encoding="utf-8") as handle:
        lock = json.load(handle)
    entries = lock["runtime"]["files"]
    if fingerprint(entries) != lock["runtime"]["fingerprint"]:
        raise RuntimeInvalid()
    expected = {entry["path"] for entry in entries}
    for directory, _dirs, names in os.walk(model_dir):
        for name in names:
            relative = os.path.relpath(os.path.join(directory, name), model_dir).replace(os.sep, "/")
            if relative not in expected:
                raise RuntimeInvalid()
    for entry in entries:
        check_entry(model_dir, entry)
    return lock


def recheck_small_files(model_dir, lock):
    for entry in lock["runtime"]["files"]:
        if entry["size"] <= RECHECK_MAX_BYTES:
            check_entry(model_dir, entry)


def read_questions(path):
    with open(path, encoding="utf-8") as handle:
        document = json.load(handle)
    version = document.get("question_version")
    if document.get("schema_version") != 1 or not isinstance(version, str) or not QUESTION_VERSION_PATTERN.match(version):
        raise RuntimeInvalid()
    question = document.get("questions", {}).get("relevance")
    if not isinstance(question, dict):
        raise RuntimeInvalid()
    return version, question


def quiet():
    stack = contextlib.ExitStack()
    stack.enter_context(warnings.catch_warnings())
    warnings.simplefilter("ignore")
    stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
    return stack


def score_request(agent, request, question):
    plans = []
    states = []
    for item in request["items"]:
        fitted = fit_state(
            agent,
            request["query"],
            context_title(item["title"], item["heading"]),
            item["excerpt"],
            question,
        )
        plans.append((item["chunk_key"], fitted, len(states)))
        states.extend(segment.state for segment in fitted.segments)
    with quiet():
        raw = predict_relevance(agent, states, {"relevance": question})
    if len(raw) != len(states):
        raise ProtocolError("inference_failed", request["id"])
    probabilities = [normalize_probabilities(value) for value in raw]
    scores = []
    for chunk_key, fitted, offset in plans:
        window = probabilities[offset:offset + len(fitted.segments)]
        chosen = select_segment(window)
        scores.append(
            {
                "chunk_key": chunk_key,
                "probabilities": window[chosen],
                "input_tokens": fitted.segments[chosen].input_tokens,
                "truncated": fitted.truncated,
            }
        )
    return validate_scores([item["chunk_key"] for item in request["items"]], scores)


def handle_line(channels, agent, question, line):
    try:
        request = parse_request(line)
    except ProtocolError as error:
        channels.diagnostic("request_rejected", error.code)
        channels.send(error_message(error.request_id, error.code))
        return
    try:
        scores = score_request(agent, request, question)
    except InputTooLong:
        channels.send(error_message(request["id"], "input_too_long"))
        return
    except FittingError as error:
        channels.diagnostic("fitting_failed", error.code)
        channels.send(error_message(request["id"], "inference_failed"))
        return
    except Exception as error:
        channels.diagnostic("inference_failed", type(error).__name__)
        channels.send(error_message(request["id"], "inference_failed"))
        return
    channels.send(result_message(request["id"], scores))


def read_lines(stream):
    while True:
        line = stream.readline(MAX_LINE_BYTES + 1)
        if not line:
            return
        if len(line) > MAX_LINE_BYTES or not line.endswith(b"\n"):
            overlong = len(line) > MAX_LINE_BYTES
            while line and not line.endswith(b"\n"):
                line = stream.readline(MAX_LINE_BYTES + 1)
            if overlong:
                yield None
                continue
            if not line:
                return
        yield line


def arguments(argv):
    parser = argparse.ArgumentParser(prog="laya-worker")
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--lock", required=True)
    parser.add_argument("--questions", required=True)
    parser.add_argument("--threads", type=int, required=True)
    return parser.parse_args(argv)


def main(argv=None):
    options = arguments(argv)
    channels = Channels()
    channels.diagnostic("worker_starting")
    try:
        lock = verify_runtime(options.model_dir, options.lock)
        question_version, question = read_questions(options.questions)
    except (OSError, ValueError, KeyError, TypeError, RuntimeInvalid) as error:
        channels.diagnostic("runtime_verification_failed", type(error).__name__)
        return EXIT_RUNTIME_INVALID
    channels.diagnostic("model_loading")
    try:
        with quiet():
            import torch
            import transformers

            torch.set_num_threads(max(1, options.threads))
            with contextlib.suppress(RuntimeError):
                torch.set_num_interop_threads(1)
            agent = load_local_agent(options.model_dir)
        recheck_small_files(options.model_dir, lock)
        warmup = fit_state(agent, WARMUP_QUERY, WARMUP_TITLE, WARMUP_EXCERPT, question)
        with quiet():
            predict_relevance(agent, [warmup.segments[0].state], {"relevance": question})
    except Exception as error:
        channels.diagnostic("model_load_failed", type(error).__name__)
        return EXIT_LOAD_FAILED
    import laya

    runtime = {
        "laya": laya.__version__,
        "python": platform.python_version(),
        "torch": torch.__version__,
        "transformers": transformers.__version__,
        "device": str(agent.device),
        "threads": torch.get_num_threads(),
        "max_len": int(agent.cfg["max_len"]),
        "head_max_len": int(agent.cfg["head_max_len"]),
    }
    channels.send(ready_message(lock["runtime"]["fingerprint"], question_version, runtime))
    channels.diagnostic("model_ready")
    for line in read_lines(sys.stdin.buffer):
        if line is None:
            channels.diagnostic("request_rejected", "line_too_long")
            channels.send(error_message(None, "line_too_long"))
            continue
        handle_line(channels, agent, question, line)
    channels.diagnostic("worker_stopping")
    return 0


if __name__ == "__main__":
    sys.exit(main())
