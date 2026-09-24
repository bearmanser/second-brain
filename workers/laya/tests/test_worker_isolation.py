import hashlib
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
QUESTIONS_PATH = REPOSITORY_ROOT / "workers" / "laya" / "questions.json"

NOISE = textwrap.dedent(
    """
    import os
    import sys


    def emit_noise(stage):
        print("PY-STDOUT-NOISE-" + stage)
        sys.stdout.write("SYS-STDOUT-NOISE-" + stage + "\\n")
        sys.stdout.flush()
        sys.stderr.write("SYS-STDERR-NOISE-" + stage + "\\n")
        sys.stderr.flush()
        os.write(1, ("FD1-NOISE-" + stage + "\\n").encode())
        os.write(2, ("FD2-NOISE-" + stage + "\\n").encode())
    """
)

FAKE_LAYA = textwrap.dedent(
    """
    import os
    import re

    from _noise import emit_noise

    emit_noise("laya-import")
    if os.environ.get("FAKE_LAYA_FAIL") == "import":
        raise RuntimeError("sdk import failed with secret query text")

    __version__ = "0.3.11"


    class Tokenizer:
        mask_token = "<mask>"
        cls_token_id = 1
        sep_token_id = 2
        mask_token_id = 4
        pad_token_id = 0
        all_special_tokens = ["<pad>", "<bos>", "<eos>", "<mask>"]
        special_ids = {"<pad>": 0, "<bos>": 1, "<eos>": 2, "<mask>": 4}
        pattern = re.compile(r"<pad>|<bos>|<eos>|<mask>|[^\\s<]+|<")

        def __init__(self):
            self.vocabulary = {}

        def __call__(self, text, add_special_tokens=True, return_offsets_mapping=False):
            matches = list(self.pattern.finditer(text))
            ids = []
            for match in matches:
                word = match.group(0)
                if word in self.special_ids:
                    ids.append(self.special_ids[word])
                else:
                    ids.append(self.vocabulary.setdefault(word, 10 + len(self.vocabulary)))
            result = {"input_ids": ids}
            if return_offsets_mapping:
                result["offset_mapping"] = [(match.start(), match.end()) for match in matches]
            return result


    class Agent:
        device = "cpu"

        def __init__(self):
            self.tok = Tokenizer()
            self.cfg = {"max_len": 256, "head_max_len": 128}

        def predict_batch(self, states, questions, batch_size=None):
            emit_noise("predict")
            return [
                {"answers": {"relevance": {"probabilities": {"A": 0.5, "B": 0.25, "C": 0.25}}}, "usage": {"input_tokens": 1}}
                for _ in states
            ]


    def load(model_path, device=None, fast=False):
        emit_noise("load")
        if os.environ.get("FAKE_LAYA_FAIL") == "load":
            raise ValueError("model load failed with secret note text")
        return Agent()
    """
)

FAKE_COMMON = textwrap.dedent(
    """
    import json

    from _noise import emit_noise

    emit_noise("common-import")


    def build_sequence(tok, state, q, max_len=512, head_max_len=192, option_order=None, truncate_left=False):
        mask_tok = tok.mask_token
        opts = [k if v is None or v == "" else "%s: %s" % (k, v) for k, v in q["crit"].items()]
        order = option_order if option_order is not None else list(range(len(opts)))
        ins = str(q["ins"]).replace(mask_tok, " ")
        head_ids = tok("%s question: %s" % (q["t"], ins), add_special_tokens=False)["input_ids"]
        opt_ids = []
        for i in order:
            opt_ids.append([tok.mask_token_id] + tok(" " + opts[i].replace(mask_tok, " "), add_special_tokens=False)["input_ids"][:48])
        opt_budget = head_max_len - sum(len(o) for o in opt_ids)
        if opt_budget < 16:
            per = max(4, (head_max_len - 16) // max(1, len(opt_ids)))
            opt_ids = [o[:per] for o in opt_ids]
            opt_budget = head_max_len - sum(len(o) for o in opt_ids)
        head_ids = head_ids[: max(8, opt_budget)]
        ids = [tok.cls_token_id] + head_ids + [tok.sep_token_id]
        markers = []
        for o in opt_ids:
            markers.append(len(ids))
            ids.extend(o)
        ids.append(tok.sep_token_id)
        room = max(0, max_len - len(ids) - 1)
        text = state if isinstance(state, str) else json.dumps(state, ensure_ascii=False)
        st = tok(text.replace(mask_tok, " "), add_special_tokens=False)["input_ids"]
        st = st[max(0, len(st) - room):] if truncate_left else st[:room]
        ids = ids + st + [tok.sep_token_id]
        return ids[:max_len], [m for m in markers if m < max_len]
    """
)

FAKE_TORCH = textwrap.dedent(
    """
    from _noise import emit_noise

    emit_noise("torch-import")
    __version__ = "2.14.0+cpu"
    _threads = [1]


    def set_num_threads(count):
        _threads[0] = count


    def set_num_interop_threads(count):
        return None


    def get_num_threads():
        return _threads[0]
    """
)

FAKE_TRANSFORMERS = textwrap.dedent(
    """
    from _noise import emit_noise

    emit_noise("transformers-import")
    __version__ = "5.17.0"
    """
)


def fingerprint(entries):
    lines = "".join("%s\t%d\t%s\n" % (entry["path"], entry["size"], entry["sha256"]) for entry in sorted(entries, key=lambda entry: entry["path"]))
    return hashlib.sha256(lines.encode("utf-8")).hexdigest()


class WorkerOutputIsolationTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        root = Path(self.directory.name)
        sdk = root / "sdk"
        (sdk / "laya").mkdir(parents=True)
        (sdk / "torch").mkdir()
        (sdk / "transformers").mkdir()
        (sdk / "_noise.py").write_text(NOISE, encoding="utf-8")
        (sdk / "laya" / "__init__.py").write_text(FAKE_LAYA, encoding="utf-8")
        (sdk / "laya" / "common.py").write_text(FAKE_COMMON, encoding="utf-8")
        (sdk / "torch" / "__init__.py").write_text(FAKE_TORCH, encoding="utf-8")
        (sdk / "transformers" / "__init__.py").write_text(FAKE_TRANSFORMERS, encoding="utf-8")
        model = root / "runtime"
        model.mkdir()
        weights = b"fake weights"
        (model / "model.safetensors").write_bytes(weights)
        entries = [{"path": "model.safetensors", "size": len(weights), "sha256": hashlib.sha256(weights).hexdigest()}]
        self.lock = root / "lock.json"
        self.lock.write_text(json.dumps({"runtime": {"files": entries, "fingerprint": fingerprint(entries)}}), encoding="utf-8")
        self.sdk = sdk
        self.model = model

    def tearDown(self):
        self.directory.cleanup()

    def run_worker(self, stdin, fail=None, arguments=None):
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "PYTHONPATH": str(self.sdk), "PYTHONDONTWRITEBYTECODE": "1"}
        if fail is not None:
            env["FAKE_LAYA_FAIL"] = fail
        if arguments is None:
            arguments = [
                "--model-dir", str(self.model),
                "--lock", str(self.lock),
                "--questions", str(QUESTIONS_PATH),
                "--threads", "2",
            ]
        return subprocess.run(
            [sys.executable, "-B", "-m", "workers.laya.worker", *arguments],
            cwd=REPOSITORY_ROOT,
            env=env,
            input=stdin,
            capture_output=True,
            timeout=60,
        )

    def assert_only_diagnostics(self, stderr):
        for line in stderr.decode("utf-8").splitlines():
            message = json.loads(line)
            self.assertEqual(message["type"], "diagnostic")
            self.assertEqual(set(message) - {"v", "type", "event", "error_class"}, set())
        self.assertNotIn(b"NOISE", stderr)
        self.assertNotIn(b"secret", stderr)

    def test_stdout_carries_only_protocol_messages_across_import_load_and_prediction(self):
        request = {
            "v": 1,
            "id": "batch-1",
            "action": "score",
            "payload": {"query": "find <mask> notes", "items": [{"chunk_key": "k1", "title": "Title", "excerpt": "Body text"}]},
        }
        completed = self.run_worker((json.dumps(request) + "\n").encode("utf-8"))
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertNotIn(b"NOISE", completed.stdout)
        messages = [json.loads(line) for line in completed.stdout.decode("utf-8").splitlines()]
        self.assertEqual([message["type"] for message in messages], ["ready", "result"])
        self.assertEqual(messages[1]["id"], "batch-1")
        self.assertEqual([score["chunk_key"] for score in messages[1]["scores"]], ["k1"])
        self.assert_only_diagnostics(completed.stderr)
        events = [json.loads(line)["event"] for line in completed.stderr.decode("utf-8").splitlines()]
        self.assertIn("model_ready", events)

    def test_import_failures_produce_only_sanitized_diagnostics(self):
        completed = self.run_worker(b"", fail="import")
        self.assertEqual(completed.returncode, 4)
        self.assertEqual(completed.stdout, b"")
        self.assert_only_diagnostics(completed.stderr)
        diagnostics = [json.loads(line) for line in completed.stderr.decode("utf-8").splitlines()]
        self.assertIn({"v": 1, "type": "diagnostic", "event": "model_load_failed", "error_class": "RuntimeError"}, diagnostics)

    def test_load_failures_produce_only_sanitized_diagnostics(self):
        completed = self.run_worker(b"", fail="load")
        self.assertEqual(completed.returncode, 4)
        self.assertEqual(completed.stdout, b"")
        self.assert_only_diagnostics(completed.stderr)

    def test_argument_errors_produce_only_sanitized_diagnostics(self):
        completed = self.run_worker(b"", arguments=["--threads", "two"])
        self.assertEqual(completed.returncode, 2)
        self.assertEqual(completed.stdout, b"")
        self.assert_only_diagnostics(completed.stderr)

    def test_worker_module_imports_without_the_sdk(self):
        completed = subprocess.run(
            [sys.executable, "-B", "-c", "import sys, workers.laya.worker; sys.exit(1 if 'laya' in sys.modules or 'torch' in sys.modules else 0)"],
            cwd=REPOSITORY_ROOT,
            env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "PYTHONPATH": str(self.sdk)},
            capture_output=True,
            timeout=60,
        )
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        self.assertEqual(completed.stdout, b"")


if __name__ == "__main__":
    unittest.main()
