import json
import math
import unittest

from workers.laya.protocol import (
    MAX_BATCH_ITEMS,
    MAX_LINE_BYTES,
    PROTOCOL_VERSION,
    ProtocolError,
    encode_message,
    error_message,
    normalize_probabilities,
    parse_request,
    ready_message,
    result_message,
    validate_scores,
)


def request_line(**overrides):
    body = {
        "v": PROTOCOL_VERSION,
        "id": "batch-1",
        "action": "score",
        "payload": {
            "query": "How is the search index rebuilt?",
            "items": [
                {"chunk_key": "note-a#0-10", "title": "Search index", "excerpt": "Rebuild from Markdown."},
                {"chunk_key": "note-b#0-10", "title": "Laya", "heading": "Limits", "excerpt": "Local model."},
            ],
        },
    }
    body.update(overrides)
    return (json.dumps(body, ensure_ascii=False) + "\n").encode("utf-8")


def score(chunk_key, a=0.6, b=0.3, c=0.1, input_tokens=120, truncated=False):
    return {
        "chunk_key": chunk_key,
        "probabilities": {"A": a, "B": b, "C": c},
        "input_tokens": input_tokens,
        "truncated": truncated,
    }


class ProbabilityContractTest(unittest.TestCase):
    def test_preserves_valid_choice_distribution(self):
        actual = normalize_probabilities({"A": 0.7, "B": 0.2, "C": 0.1})
        self.assertEqual(actual, {"A": 0.7, "B": 0.2, "C": 0.1})

    def test_rejects_nonfinite_distribution(self):
        with self.assertRaises(ValueError):
            normalize_probabilities({"A": float("nan"), "B": 0.2, "C": 0.8})

    def test_rejects_infinite_values(self):
        with self.assertRaises(ValueError):
            normalize_probabilities({"A": float("inf"), "B": 0.0, "C": 0.0})

    def test_rejects_out_of_range_values(self):
        with self.assertRaises(ValueError):
            normalize_probabilities({"A": 1.2, "B": -0.1, "C": -0.1})
        with self.assertRaises(ValueError):
            normalize_probabilities({"A": -0.0001, "B": 0.5, "C": 0.5001})

    def test_rejects_missing_or_extra_keys(self):
        with self.assertRaises(ValueError):
            normalize_probabilities({"A": 0.5, "B": 0.5})
        with self.assertRaises(ValueError):
            normalize_probabilities({"A": 0.5, "B": 0.25, "C": 0.25, "D": 0.0})
        with self.assertRaises(ValueError):
            normalize_probabilities([0.5, 0.25, 0.25])

    def test_rejects_strings_and_booleans_as_numbers(self):
        with self.assertRaises(ValueError):
            normalize_probabilities({"A": "0.5", "B": 0.25, "C": 0.25})
        with self.assertRaises(ValueError):
            normalize_probabilities({"A": True, "B": False, "C": False})

    def test_rejects_sum_outside_rounding_tolerance(self):
        with self.assertRaises(ValueError):
            normalize_probabilities({"A": 0.5, "B": 0.2, "C": 0.2})
        with self.assertRaises(ValueError):
            normalize_probabilities({"A": 0.0, "B": 0.0, "C": 0.0})

    def test_normalizes_only_rounding_error(self):
        actual = normalize_probabilities({"A": 0.3333, "B": 0.3333, "C": 0.3333})
        self.assertAlmostEqual(sum(actual.values()), 1.0, places=12)
        for value in actual.values():
            self.assertAlmostEqual(value, 1 / 3, places=12)

    def test_accepts_integer_extremes(self):
        self.assertEqual(normalize_probabilities({"A": 1, "B": 0, "C": 0}), {"A": 1.0, "B": 0.0, "C": 0.0})


class RequestParsingTest(unittest.TestCase):
    def test_parses_bounded_score_request(self):
        request = parse_request(request_line())
        self.assertEqual(request["id"], "batch-1")
        self.assertEqual(request["query"], "How is the search index rebuilt?")
        self.assertEqual([item["chunk_key"] for item in request["items"]], ["note-a#0-10", "note-b#0-10"])
        self.assertIsNone(request["items"][0]["heading"])
        self.assertEqual(request["items"][1]["heading"], "Limits")

    def test_rejects_invalid_json(self):
        with self.assertRaises(ProtocolError) as caught:
            parse_request(b"{not json\n")
        self.assertEqual(caught.exception.code, "invalid_json")

    def test_rejects_nonfinite_json_constants(self):
        with self.assertRaises(ProtocolError) as caught:
            parse_request(b'{"v": NaN, "id": "x", "action": "score", "payload": {}}\n')
        self.assertEqual(caught.exception.code, "invalid_json")

    def test_rejects_huge_lines(self):
        line = request_line()[:-1] + b" " * MAX_LINE_BYTES + b"\n"
        with self.assertRaises(ProtocolError) as caught:
            parse_request(line)
        self.assertEqual(caught.exception.code, "line_too_long")

    def test_rejects_unknown_top_level_fields(self):
        with self.assertRaises(ProtocolError) as caught:
            parse_request(request_line(extra=True))
        self.assertEqual(caught.exception.code, "invalid_request")
        self.assertEqual(caught.exception.request_id, "batch-1")

    def test_rejects_unknown_item_fields(self):
        payload = json.loads(request_line())["payload"]
        payload["items"][0]["score"] = 1
        with self.assertRaises(ProtocolError) as caught:
            parse_request(request_line(payload=payload))
        self.assertEqual(caught.exception.code, "invalid_request")

    def test_rejects_unsupported_version_and_action(self):
        with self.assertRaises(ProtocolError) as caught:
            parse_request(request_line(v=2))
        self.assertEqual(caught.exception.code, "unsupported_version")
        with self.assertRaises(ProtocolError):
            parse_request(request_line(v=True))
        with self.assertRaises(ProtocolError) as caught:
            parse_request(request_line(action="classify"))
        self.assertEqual(caught.exception.code, "invalid_request")

    def test_rejects_malformed_request_ids(self):
        for value in ["", "has space", "x" * 129, 7, None]:
            with self.assertRaises(ProtocolError):
                parse_request(request_line(id=value))

    def test_rejects_batches_above_the_active_model_batch(self):
        payload = json.loads(request_line())["payload"]
        payload["items"] = [
            {"chunk_key": "k%d" % index, "title": "t", "excerpt": "e"} for index in range(MAX_BATCH_ITEMS + 1)
        ]
        with self.assertRaises(ProtocolError) as caught:
            parse_request(request_line(payload=payload))
        self.assertEqual(caught.exception.code, "invalid_request")

    def test_rejects_empty_batches_and_duplicate_chunk_keys(self):
        payload = json.loads(request_line())["payload"]
        payload["items"] = []
        with self.assertRaises(ProtocolError):
            parse_request(request_line(payload=payload))
        payload["items"] = [
            {"chunk_key": "same", "title": "t", "excerpt": "e"},
            {"chunk_key": "same", "title": "u", "excerpt": "f"},
        ]
        with self.assertRaises(ProtocolError):
            parse_request(request_line(payload=payload))

    def test_rejects_unbounded_strings(self):
        payload = json.loads(request_line())["payload"]
        payload["query"] = "q" * 8001
        with self.assertRaises(ProtocolError):
            parse_request(request_line(payload=payload))
        payload = json.loads(request_line())["payload"]
        payload["items"][0]["excerpt"] = "e" * 8001
        with self.assertRaises(ProtocolError):
            parse_request(request_line(payload=payload))
        payload = json.loads(request_line())["payload"]
        payload["query"] = "   "
        with self.assertRaises(ProtocolError):
            parse_request(request_line(payload=payload))

    def test_rejects_invalid_utf8(self):
        with self.assertRaises(ProtocolError) as caught:
            parse_request(b'{"v": 1, "id": "a", "action": "score", "payload": "\xff"}\n')
        self.assertEqual(caught.exception.code, "invalid_json")


class ScoreValidationTest(unittest.TestCase):
    def test_returns_scores_in_request_order(self):
        actual = validate_scores(["a", "b"], [score("b"), score("a")])
        self.assertEqual([item["chunk_key"] for item in actual], ["a", "b"])

    def test_rejects_missing_duplicated_or_unexpected_chunk_keys(self):
        with self.assertRaises(ProtocolError):
            validate_scores(["a", "b"], [score("a")])
        with self.assertRaises(ProtocolError):
            validate_scores(["a", "b"], [score("a"), score("a")])
        with self.assertRaises(ProtocolError):
            validate_scores(["a"], [score("a"), score("z")])

    def test_rejects_nonfinite_or_out_of_range_scores(self):
        for bad in [float("nan"), float("inf"), 1.5, -0.2]:
            with self.assertRaises(ProtocolError):
                validate_scores(["a"], [score("a", a=bad)])

    def test_rejects_invalid_token_counts_and_flags(self):
        with self.assertRaises(ProtocolError):
            validate_scores(["a"], [score("a", input_tokens=0)])
        with self.assertRaises(ProtocolError):
            validate_scores(["a"], [score("a", input_tokens=True)])
        with self.assertRaises(ProtocolError):
            validate_scores(["a"], [score("a", truncated="no")])


class MessageEncodingTest(unittest.TestCase):
    def test_encodes_one_json_line(self):
        line = encode_message(result_message("batch-1", [score("a")]))
        self.assertTrue(line.endswith(b"\n"))
        self.assertEqual(line.count(b"\n"), 1)
        decoded = json.loads(line)
        self.assertEqual(decoded["type"], "result")
        self.assertEqual(decoded["id"], "batch-1")
        self.assertEqual(decoded["v"], PROTOCOL_VERSION)

    def test_refuses_nonfinite_values(self):
        with self.assertRaises(ValueError):
            encode_message({"v": 1, "type": "result", "id": "x", "value": math.nan})

    def test_refuses_lines_above_the_limit(self):
        with self.assertRaises(ProtocolError) as caught:
            encode_message({"v": 1, "type": "result", "id": "x", "padding": "p" * MAX_LINE_BYTES})
        self.assertEqual(caught.exception.code, "line_too_long")

    def test_error_messages_carry_only_codes(self):
        message = error_message("batch-1", "input_too_long")
        self.assertEqual(message, {"v": PROTOCOL_VERSION, "type": "error", "id": "batch-1", "code": "input_too_long"})
        with self.assertRaises(ValueError):
            error_message("batch-1", "secret query text")

    def test_ready_message_contains_only_identifiers(self):
        message = ready_message("f" * 64, "relevance-v1", {"laya": "0.3.11", "device": "cpu"})
        self.assertEqual(set(message), {"v", "type", "model_fingerprint", "question_version", "runtime"})


if __name__ == "__main__":
    unittest.main()
