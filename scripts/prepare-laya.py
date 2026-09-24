import argparse
import contextlib
import hashlib
import io
import json
import math
import os
import re
import shutil
import socket
import stat
import sys
import tempfile
import urllib.parse
import urllib.request
import warnings
from pathlib import Path, PurePosixPath

LOCK_SCHEMA_VERSION = 1
SDK_PACKAGE = "laya"
SDK_VERSION = "0.3.11"
HUB_ENDPOINT = "https://huggingface.co"
CHECKPOINT_FILES = ("rl_agent_config.json", "model.safetensors")
CHECKPOINT_DIRECTORIES = ("tokenizer/", "encoder/")
NOTICE_PATTERN = re.compile(r"^(README\.md|LICENSE(\.[A-Za-z0-9]+)?|NOTICE(\.[A-Za-z0-9]+)?)$")
TOKENIZER_CONFIG = "tokenizer/tokenizer_config.json"
REVISION_PATTERN = re.compile(r"^[0-9a-f]{40}$")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
CHUNK_BYTES = 1024 * 1024
REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
QUESTIONS_PATH = REPOSITORY_ROOT / "workers" / "laya" / "questions.json"
REQUIREMENTS_LOCK = REPOSITORY_ROOT / "workers" / "laya" / "requirements.lock"
SMOKE_STATE = "Query:\nHow is the search index rebuilt?\n\nNote title:\nSearch index\n\nNote excerpt:\nThe index is rebuilt from current Markdown files."


class PrepareError(Exception):
    pass


def fail(message):
    raise PrepareError(message)


def emit(document):
    sys.stdout.write(json.dumps(document, indent=2, ensure_ascii=False) + "\n")


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha256_file(path):
    digest = hashlib.sha256()
    size = 0
    with open(path, "rb") as handle:
        while True:
            block = handle.read(CHUNK_BYTES)
            if not block:
                break
            size += len(block)
            digest.update(block)
    return digest.hexdigest(), size


def git_blob_id(data):
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def safe_relative(path):
    pure = PurePosixPath(path)
    if pure.is_absolute() or any(part in ("", ".", "..") for part in pure.parts) or "\\" in path:
        fail("unsafe path in manifest: %r" % path)
    return pure


def hub_headers():
    headers = {"User-Agent": "second-brain-prepare-laya/1"}
    token = os.environ.get("HF_TOKEN")
    if token:
        headers["Authorization"] = "Bearer %s" % token
    return headers


def hub_request(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=hub_headers()), timeout=60)


def hub_json(url):
    with hub_request(url) as response:
        return json.loads(response.read().decode("utf-8"))


def resolve_url(repository, revision, path):
    return "%s/%s/resolve/%s/%s" % (
        HUB_ENDPOINT,
        repository,
        revision,
        urllib.parse.quote(path),
    )


def fetch_bytes(repository, revision, path):
    with hub_request(resolve_url(repository, revision, path)) as response:
        return response.read()


def selected(path, subfolder):
    prefix = subfolder + "/"
    if NOTICE_PATTERN.match(path):
        return "notice"
    if not path.startswith(prefix):
        return None
    inner = path[len(prefix):]
    if inner in CHECKPOINT_FILES or any(inner.startswith(directory) for directory in CHECKPOINT_DIRECTORIES):
        return "checkpoint"
    return None


def normalize_tokenizer_config(data):
    config = json.loads(data.decode("utf-8"))
    applied = []
    if config.get("tokenizer_class") in (None, "TokenizersBackend"):
        config["tokenizer_class"] = "PreTrainedTokenizerFast"
        config.pop("backend", None)
        config.pop("is_local", None)
        applied.append("tokenizer_class_fast")
    extra = config.get("extra_special_tokens")
    if isinstance(extra, list):
        config["extra_special_tokens"] = {"extra_%d" % index: token for index, token in enumerate(extra)}
        applied.append("extra_special_tokens_mapping")
    if not applied:
        return data, applied
    return json.dumps(config, indent=2).encode("utf-8"), applied


def runtime_fingerprint(files):
    lines = "".join("%s\t%d\t%s\n" % (item["path"], item["size"], item["sha256"]) for item in sorted(files, key=lambda item: item["path"]))
    return sha256_bytes(lines.encode("utf-8"))


def license_from_readme(data):
    text = data.decode("utf-8", errors="replace")
    match = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    if match:
        for line in match.group(1).splitlines():
            if line.startswith("license:"):
                return line.split(":", 1)[1].strip()
    return None


def command_lock(arguments):
    repository = arguments.repo
    subfolder = arguments.subfolder.strip("/")
    safe_relative(subfolder)
    info = hub_json("%s/api/models/%s/revision/%s?blobs=true" % (HUB_ENDPOINT, repository, urllib.parse.quote(arguments.revision, safe="")))
    revision = info.get("sha")
    if not isinstance(revision, str) or not REVISION_PATTERN.match(revision):
        fail("the hub did not resolve an immutable commit")
    source_files = []
    contents = {}
    for sibling in sorted(info.get("siblings", []), key=lambda item: item["rfilename"]):
        path = sibling["rfilename"]
        role = selected(path, subfolder)
        if role is None:
            continue
        safe_relative(path)
        lfs = sibling.get("lfs")
        entry = {"path": path, "role": role, "size": int(sibling["size"]), "git_blob_id": sibling.get("blobId"), "lfs": bool(lfs)}
        if lfs:
            if not SHA256_PATTERN.match(str(lfs.get("sha256", ""))) or int(lfs.get("size", -1)) != entry["size"]:
                fail("incomplete LFS metadata for %s" % path)
            entry["sha256"] = lfs["sha256"]
        else:
            data = fetch_bytes(repository, revision, path)
            if len(data) != entry["size"] or git_blob_id(data) != entry["git_blob_id"]:
                fail("downloaded %s does not match the hub blob id" % path)
            entry["sha256"] = sha256_bytes(data)
            contents[path] = data
        source_files.append(entry)
    prefix = subfolder + "/"
    checkpoint_config_path = prefix + "rl_agent_config.json"
    required = [prefix + name for name in CHECKPOINT_FILES] + [prefix + TOKENIZER_CONFIG, prefix + "encoder/config.json", prefix + "tokenizer/tokenizer.json"]
    present = {entry["path"] for entry in source_files}
    missing = [path for path in required if path not in present]
    if missing:
        fail("checkpoint is missing required files: %s" % ", ".join(missing))
    checkpoint = json.loads(contents[checkpoint_config_path].decode("utf-8"))
    encoder = json.loads(contents[prefix + "encoder/config.json"].decode("utf-8"))
    tokenizer_source = contents[prefix + TOKENIZER_CONFIG]
    tokenizer_runtime, applied = normalize_tokenizer_config(tokenizer_source)
    tokenizer_config = json.loads(tokenizer_runtime.decode("utf-8"))
    runtime_files = []
    for entry in source_files:
        if entry["role"] != "checkpoint":
            continue
        inner = entry["path"][len(prefix):]
        if inner == TOKENIZER_CONFIG:
            runtime_files.append({"path": inner, "source": entry["path"], "size": len(tokenizer_runtime), "sha256": sha256_bytes(tokenizer_runtime)})
        else:
            runtime_files.append({"path": inner, "source": entry["path"], "size": entry["size"], "sha256": entry["sha256"]})
    readme = contents.get("README.md")
    lock = {
        "schema_version": LOCK_SCHEMA_VERSION,
        "repository": repository,
        "requested_revision": arguments.revision,
        "revision": revision,
        "revision_last_modified": info.get("lastModified"),
        "subfolder": subfolder,
        "license": {
            "id": license_from_readme(readme) if readme else None,
            "card_data": (info.get("cardData") or {}).get("license"),
            "notice_files": [entry["path"] for entry in source_files if entry["role"] == "notice"],
        },
        "sdk": {
            "package": SDK_PACKAGE,
            "version": SDK_VERSION,
            "requirements_lock_sha256": sha256_file(REQUIREMENTS_LOCK)[0],
        },
        "checkpoint": {
            "config_path": checkpoint_config_path,
            "config": checkpoint,
            "max_len": checkpoint.get("max_len"),
            "head_max_len": checkpoint.get("head_max_len"),
            "encoder_model_type": encoder.get("model_type"),
            "encoder_vocab_size": encoder.get("vocab_size"),
            "encoder_max_position_embeddings": encoder.get("max_position_embeddings"),
        },
        "tokenizer": {
            "config_path": prefix + TOKENIZER_CONFIG,
            "tokenizer_class": tokenizer_config.get("tokenizer_class"),
            "mask_token": tokenizer_config.get("mask_token"),
            "cls_token": tokenizer_config.get("cls_token"),
            "sep_token": tokenizer_config.get("sep_token"),
            "pad_token": tokenizer_config.get("pad_token"),
            "model_max_length": tokenizer_config.get("model_max_length"),
        },
        "normalization": [
            {
                "path": TOKENIZER_CONFIG,
                "rules": ["tokenizer_class_fast", "extra_special_tokens_mapping"],
                "applied": applied,
                "source_sha256": sha256_bytes(tokenizer_source),
                "runtime_sha256": sha256_bytes(tokenizer_runtime),
            }
        ],
        "source_files": source_files,
        "runtime": {
            "directory": "runtime",
            "files": sorted(runtime_files, key=lambda item: item["path"]),
            "fingerprint": runtime_fingerprint(runtime_files),
        },
    }
    output = Path(arguments.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + ".tmp")
    temporary.write_text(json.dumps(lock, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(temporary, output)
    emit({"command": "lock", "revision": revision, "files": len(source_files), "runtime_fingerprint": lock["runtime"]["fingerprint"]})


def read_lock(path):
    with open(path, encoding="utf-8") as handle:
        lock = json.load(handle)
    if lock.get("schema_version") != LOCK_SCHEMA_VERSION:
        fail("unsupported lock schema")
    if not REVISION_PATTERN.match(str(lock.get("revision", ""))):
        fail("lock does not name an immutable revision")
    for entry in lock["source_files"] + lock["runtime"]["files"]:
        safe_relative(entry["path"])
        if not SHA256_PATTERN.match(entry["sha256"]):
            fail("lock contains an invalid checksum")
    if runtime_fingerprint(lock["runtime"]["files"]) != lock["runtime"]["fingerprint"]:
        fail("lock runtime fingerprint does not match its file list")
    return lock


def snapshot_dir(destination, lock):
    return Path(destination) / "snapshots" / lock["revision"]


def runtime_dir(destination, lock):
    return Path(destination) / lock["runtime"]["directory"]


def matches(path, entry):
    if not path.is_file() or path.is_symlink():
        return False
    digest, size = sha256_file(path)
    return size == entry["size"] and digest == entry["sha256"]


def download(lock, entry, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".partial")
    digest = hashlib.sha256()
    size = 0
    with hub_request(resolve_url(lock["repository"], lock["revision"], entry["path"])) as response, open(partial, "wb") as handle:
        while True:
            block = response.read(CHUNK_BYTES)
            if not block:
                break
            size += len(block)
            digest.update(block)
            handle.write(block)
    if size != entry["size"] or digest.hexdigest() != entry["sha256"]:
        partial.unlink()
        fail("downloaded %s does not match the locked checksum" % entry["path"])
    os.chmod(partial, stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)
    os.replace(partial, target)


def build_runtime(lock, snapshot, runtime):
    staging = Path(tempfile.mkdtemp(prefix=".runtime-", dir=runtime.parent))
    try:
        os.chmod(staging, 0o755)
        for entry in lock["runtime"]["files"]:
            source = snapshot / entry["source"]
            target = staging / entry["path"]
            target.parent.mkdir(parents=True, exist_ok=True)
            if entry["path"] == TOKENIZER_CONFIG:
                data, _applied = normalize_tokenizer_config(source.read_bytes())
                target.write_bytes(data)
            else:
                shutil.copyfile(source, target)
            if not matches(target, entry):
                fail("runtime copy of %s does not match the locked checksum" % entry["path"])
        previous = runtime.with_name(runtime.name + ".previous")
        if previous.exists():
            shutil.rmtree(previous)
        if runtime.exists():
            os.replace(runtime, previous)
        os.replace(staging, runtime)
        if previous.exists():
            shutil.rmtree(previous)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def command_fetch(arguments):
    lock = read_lock(arguments.lock)
    destination = Path(arguments.destination)
    snapshot = snapshot_dir(destination, lock)
    downloaded = 0
    for entry in lock["source_files"]:
        target = snapshot / entry["path"]
        if matches(target, entry):
            continue
        if target.exists():
            os.chmod(target, stat.S_IWUSR | stat.S_IRUSR)
            target.unlink()
        download(lock, entry, target)
        downloaded += 1
    runtime = runtime_dir(destination, lock)
    runtime.parent.mkdir(parents=True, exist_ok=True)
    if not all(matches(runtime / entry["path"], entry) for entry in lock["runtime"]["files"]) or unexpected_files(runtime, lock["runtime"]["files"]):
        build_runtime(lock, snapshot, runtime)
    emit({"command": "fetch", "revision": lock["revision"], "downloaded": downloaded, "snapshot": str(snapshot), "runtime": str(runtime)})


def unexpected_files(root, entries):
    if not root.exists():
        return []
    expected = {entry["path"] for entry in entries}
    found = []
    for directory, _dirs, names in os.walk(root):
        for name in names:
            relative = Path(directory, name).relative_to(root).as_posix()
            if relative not in expected:
                found.append(relative)
    return sorted(found)


def check_files(root, entries, label):
    problems = []
    for entry in entries:
        if not matches(root / entry["path"], entry):
            problems.append("%s %s" % (label, entry["path"]))
    return problems


def guard_network():
    def refuse(*_args, **_kwargs):
        raise OSError("network access is disabled during offline verification")

    socket.socket.connect = refuse
    socket.socket.connect_ex = refuse
    socket.create_connection = refuse
    socket.getaddrinfo = refuse


def offline_load(lock, runtime, guarded):
    for key, value in {
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "TOKENIZERS_PARALLELISM": "false",
    }.items():
        os.environ[key] = value
    for key in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"):
        os.environ.pop(key, None)
    if guarded:
        guard_network()
    import laya
    from laya import load

    if laya.__version__ != lock["sdk"]["version"]:
        fail("installed laya %s does not match the locked %s" % (laya.__version__, lock["sdk"]["version"]))
    with open(QUESTIONS_PATH, encoding="utf-8") as handle:
        questions = json.load(handle)
    relevance = {"relevance": questions["questions"]["relevance"]}
    with warnings.catch_warnings(), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        warnings.simplefilter("ignore")
        agent = load(str(runtime), device="cpu", fast=False)
        results = agent.predict_batch([SMOKE_STATE], relevance, batch_size=8)
    if agent.cfg.get("max_len") != lock["checkpoint"]["max_len"] or agent.cfg.get("head_max_len") != lock["checkpoint"]["head_max_len"]:
        fail("loaded checkpoint limits differ from the lock")
    probabilities = results[0]["answers"]["relevance"]["probabilities"]
    values = [probabilities.get(key) for key in ("A", "B", "C")]
    if set(probabilities) != {"A", "B", "C"} or not all(isinstance(value, float) and math.isfinite(value) and 0 <= value <= 1 for value in values):
        fail("offline smoke prediction returned an invalid distribution")
    if abs(sum(values) - 1) > 0.002:
        fail("offline smoke prediction does not sum to one")
    return {
        "laya": laya.__version__,
        "device": str(agent.device),
        "max_len": agent.cfg.get("max_len"),
        "head_max_len": agent.cfg.get("head_max_len"),
        "smoke_input_tokens": results[0]["usage"]["input_tokens"],
        "network_guard": guarded,
    }


def command_verify(arguments):
    lock = read_lock(arguments.lock)
    destination = Path(arguments.destination)
    snapshot = snapshot_dir(destination, lock)
    runtime = runtime_dir(destination, lock)
    problems = check_files(snapshot, lock["source_files"], "snapshot")
    problems += check_files(runtime, lock["runtime"]["files"], "runtime")
    problems += ["unexpected runtime file %s" % path for path in unexpected_files(runtime, lock["runtime"]["files"])]
    if problems:
        fail("verification failed: %s" % "; ".join(problems))
    load_report = offline_load(lock, runtime, arguments.offline)
    after = check_files(snapshot, lock["source_files"], "snapshot") + check_files(runtime, lock["runtime"]["files"], "runtime")
    after += ["unexpected runtime file %s" % path for path in unexpected_files(runtime, lock["runtime"]["files"])]
    if after:
        fail("loading modified verified files: %s" % "; ".join(after))
    emit({
        "command": "verify",
        "revision": lock["revision"],
        "runtime_fingerprint": lock["runtime"]["fingerprint"],
        "source_files_verified": len(lock["source_files"]),
        "runtime_files_verified": len(lock["runtime"]["files"]),
        "load": load_report,
        "unchanged_after_load": True,
    })


def parser():
    root = argparse.ArgumentParser(prog="prepare-laya")
    commands = root.add_subparsers(dest="command", required=True)
    lock = commands.add_parser("lock")
    lock.add_argument("--repo", required=True)
    lock.add_argument("--subfolder", required=True)
    lock.add_argument("--revision", default="main")
    lock.add_argument("--output", required=True)
    lock.set_defaults(handler=command_lock)
    fetch = commands.add_parser("fetch")
    fetch.add_argument("--lock", required=True)
    fetch.add_argument("--destination", required=True)
    fetch.set_defaults(handler=command_fetch)
    verify = commands.add_parser("verify")
    verify.add_argument("--lock", required=True)
    verify.add_argument("--destination", required=True)
    verify.add_argument("--offline", action="store_true")
    verify.set_defaults(handler=command_verify)
    return root


def main(argv=None):
    arguments = parser().parse_args(argv)
    try:
        arguments.handler(arguments)
    except PrepareError as error:
        sys.stderr.write("prepare-laya: %s\n" % error)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
