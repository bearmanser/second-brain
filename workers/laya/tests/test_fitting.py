import copy
import importlib.util
import json
import os
import re
import unittest
from pathlib import Path

from workers.laya.fitting import (
    MAX_SEGMENTS,
    TITLE_TOKEN_LIMIT,
    WORD_JOINER,
    FittingError,
    InputTooLong,
    fit_state,
    literal_text,
    render_state,
    reserved_literals,
    select_segment,
)

QUESTIONS_PATH = Path(__file__).resolve().parents[1] / "questions.json"


def relevance_question():
    with QUESTIONS_PATH.open(encoding="utf-8") as handle:
        return json.load(handle)["questions"]["relevance"]


class FakeTokenizer:
    mask_token = "<mask>"
    cls_token_id = 1
    sep_token_id = 2
    mask_token_id = 4
    pad_token_id = 0
    special_ids = {"<pad>": 0, "<bos>": 1, "<eos>": 2, "<mask>": 4}
    all_special_tokens = ["<pad>", "<bos>", "<eos>", "<mask>"]
    pattern = re.compile(r"<pad>|<bos>|<eos>|<mask>|[^\s<]+|<")

    def __init__(self):
        self.vocabulary = {}
        self.calls = 0

    def _id(self, word):
        if word in self.special_ids:
            return self.special_ids[word]
        if word not in self.vocabulary:
            self.vocabulary[word] = 10 + len(self.vocabulary)
        return self.vocabulary[word]

    def __call__(self, text, add_special_tokens=True, return_offsets_mapping=False):
        self.calls += 1
        matches = list(self.pattern.finditer(text))
        result = {"input_ids": [self._id(match.group(0)) for match in matches]}
        if add_special_tokens:
            result["input_ids"] = [self.cls_token_id] + result["input_ids"] + [self.sep_token_id]
        if return_offsets_mapping:
            result["offset_mapping"] = [(match.start(), match.end()) for match in matches]
        return result


def sdk_sequence_contract(tok, state, q, max_len=512, head_max_len=192, option_order=None, truncate_left=False):
    mask_tok = tok.mask_token
    crit = q["crit"]
    opts = [k if v is None or v == "" else "%s: %s" % (k, v) for k, v in crit.items()]
    order = option_order if option_order is not None else list(range(len(opts)))
    ins = str(q["ins"]).replace(mask_tok, " ")
    head_ids = tok("%s question: %s" % (q["t"], ins), add_special_tokens=False)["input_ids"]
    opt_ids = []
    for i in order:
        opt_ids.append(
            [tok.mask_token_id]
            + tok(" " + opts[i].replace(mask_tok, " "), add_special_tokens=False)["input_ids"][:48]
        )
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


class FakeAgent:
    build_sequence = staticmethod(sdk_sequence_contract)

    def __init__(self, max_len=128, head_max_len=64):
        self.tok = FakeTokenizer()
        self.cfg = {"max_len": max_len, "head_max_len": head_max_len}


def words(count, prefix="word"):
    return " ".join("%s%d" % (prefix, index) for index in range(count))


class FitStateTest(unittest.TestCase):
    def setUp(self):
        self.question = relevance_question()

    def test_short_input_fits_in_one_untruncated_segment(self):
        agent = FakeAgent()
        result = fit_state(agent, "how is the index rebuilt", "Search index", "Rebuild it from Markdown.", self.question)
        self.assertFalse(result.truncated)
        self.assertEqual(len(result.segments), 1)
        segment = result.segments[0]
        self.assertEqual(segment.state, render_state("how is the index rebuilt", "Search index", "Rebuild it from Markdown."))
        self.assertEqual(segment.title, "Search index")
        self.assertEqual(segment.excerpt, "Rebuild it from Markdown.")
        self.assertEqual((segment.excerpt_start, segment.excerpt_end), (0, len("Rebuild it from Markdown.")))
        self.assertEqual(segment.input_tokens, len(segment.input_ids))
        self.assertLessEqual(segment.input_tokens, agent.cfg["max_len"])

    def test_final_sequence_retains_every_choice_marker_and_the_query(self):
        agent = FakeAgent()
        result = fit_state(agent, "where are backups stored", "Backups", "Backups live in state.", self.question)
        segment = result.segments[0]
        ids, markers = sdk_sequence_contract(agent.tok, segment.state, {
            "t": "choice", "ins": self.question["instructions"], "crit": self.question["criteria"]
        }, agent.cfg["max_len"], agent.cfg["head_max_len"])
        self.assertEqual(list(segment.input_ids), ids)
        self.assertEqual(len(markers), 3)
        self.assertTrue(all(ids[marker] == agent.tok.mask_token_id for marker in markers))
        query_ids = agent.tok("where are backups stored", add_special_tokens=False)["input_ids"]
        joined = ",".join(str(value) for value in ids)
        self.assertIn(",".join(str(value) for value in query_ids), joined)

    def test_shortens_the_title_before_reducing_the_excerpt(self):
        agent = FakeAgent(max_len=128, head_max_len=64)
        title = words(60, "title")
        excerpt = words(20, "body")
        result = fit_state(agent, "query terms", title, excerpt, self.question)
        self.assertTrue(result.truncated)
        self.assertEqual(len(result.segments), 1)
        segment = result.segments[0]
        self.assertEqual(segment.excerpt, excerpt)
        self.assertTrue(title.startswith(segment.title))
        self.assertLess(len(segment.title), len(title))
        self.assertLessEqual(len(agent.tok(segment.title, add_special_tokens=False)["input_ids"]), TITLE_TOKEN_LIMIT)

    def test_rechunks_an_overlong_excerpt_into_exact_source_slices(self):
        agent = FakeAgent(max_len=128, head_max_len=64)
        excerpt = words(90, "body")
        result = fit_state(agent, "query terms", "Short title", excerpt, self.question)
        self.assertTrue(result.truncated)
        self.assertGreater(len(result.segments), 1)
        self.assertLessEqual(len(result.segments), MAX_SEGMENTS)
        previous_end = 0
        for segment in result.segments:
            self.assertEqual(segment.excerpt, excerpt[segment.excerpt_start:segment.excerpt_end])
            self.assertGreaterEqual(segment.excerpt_start, previous_end)
            previous_end = segment.excerpt_end
            self.assertLessEqual(segment.input_tokens, agent.cfg["max_len"])
            self.assertEqual(segment.input_tokens, len(segment.input_ids))
            self.assertIn("query terms", segment.state)
        self.assertEqual(result.segments[0].excerpt_start, 0)

    def test_rejects_a_query_that_cannot_fit_on_its_own(self):
        agent = FakeAgent(max_len=128, head_max_len=64)
        with self.assertRaises(InputTooLong) as caught:
            fit_state(agent, words(200, "query"), "Title", "Excerpt", self.question)
        self.assertEqual(caught.exception.code, "input_too_long")

    def test_never_changes_checkpoint_context_limits(self):
        agent = FakeAgent(max_len=128, head_max_len=64)
        before = copy.deepcopy(agent.cfg)
        fit_state(agent, "query", "Title", words(400, "body"), self.question)
        self.assertEqual(agent.cfg, before)

    def test_rejects_a_question_whose_choices_do_not_fit_the_head(self):
        agent = FakeAgent(max_len=128, head_max_len=24)
        with self.assertRaises(FittingError) as caught:
            fit_state(agent, "query", "Title", "Excerpt", self.question)
        self.assertEqual(caught.exception.code, "question_too_long")

    def state_ids(self, agent, segment):
        internal = {"t": "choice", "ins": self.question["instructions"], "crit": self.question["criteria"]}
        prefix, _markers = sdk_sequence_contract(agent.tok, "", internal, agent.cfg["max_len"], agent.cfg["head_max_len"])
        return list(segment.input_ids[len(prefix) - 1:-1])

    def test_represents_reserved_literals_without_classifier_markers(self):
        agent = FakeAgent()
        excerpt = "Body <mask> text <eos> end"
        result = fit_state(agent, "find <mask> notes", "Title <bos>", excerpt, self.question)
        segment = result.segments[0]
        self.assertFalse(result.truncated)
        self.assertEqual(segment.excerpt, excerpt)
        self.assertEqual(segment.title, "Title <bos>")
        self.assertIn("Query:\nfind <" + WORD_JOINER + "mask> notes\n", segment.state)
        self.assertIn("Title <" + WORD_JOINER + "bos>", segment.state)
        self.assertIn("Body <" + WORD_JOINER + "mask> text <" + WORD_JOINER + "eos> end", segment.state)
        self.assertEqual(sum(1 for value in segment.input_ids if value == agent.tok.mask_token_id), 3)
        state_ids = self.state_ids(agent, segment)
        self.assertFalse(set(state_ids) & set(FakeTokenizer.special_ids.values()))
        self.assertIn(agent.tok.vocabulary[WORD_JOINER + "mask>"], state_ids)
        self.assertIn(agent.tok.vocabulary[WORD_JOINER + "eos>"], state_ids)

    def test_query_consisting_only_of_a_reserved_literal_is_scored_literally(self):
        agent = FakeAgent()
        result = fit_state(agent, "<mask>", "Title", "Excerpt", self.question)
        segment = result.segments[0]
        self.assertFalse(result.truncated)
        self.assertTrue(segment.state.startswith("Query:\n<" + WORD_JOINER + "mask>\n"))
        self.assertEqual(sum(1 for value in segment.input_ids if value == agent.tok.mask_token_id), 3)
        self.assertFalse(set(self.state_ids(agent, segment)) & set(FakeTokenizer.special_ids.values()))

    def test_literal_representation_is_defined_and_idempotent_on_plain_text(self):
        literals = reserved_literals(FakeTokenizer())
        self.assertEqual(literals, ("<mask>", "<bos>", "<eos>", "<pad>"))
        self.assertEqual(literal_text("<<mask>>", literals), "<<" + WORD_JOINER + "mask>>")
        self.assertEqual(literal_text("plain text", literals), "plain text")
        self.assertEqual(literal_text("<mask>", ()), "<mask>")
        self.assertEqual(render_state("q", "t", "e"), "Query:\nq\n\nNote title:\nt\n\nNote excerpt:\ne")

    def test_rejects_unsupported_question_shapes(self):
        agent = FakeAgent()
        with self.assertRaises(FittingError):
            fit_state(agent, "query", "Title", "Excerpt", {"type": "noul", "instructions": "x"})
        with self.assertRaises(FittingError):
            fit_state(agent, "query", "Title", "Excerpt", {
                "type": "choice", "instructions": "x", "criteria": {"A": "a", "B": "b"}
            })


class SegmentSelectionTest(unittest.TestCase):
    def test_selects_the_segment_with_the_strongest_ordering_signal(self):
        probabilities = [
            {"A": 0.1, "B": 0.2, "C": 0.7},
            {"A": 0.4, "B": 0.4, "C": 0.2},
            {"A": 0.5, "B": 0.0, "C": 0.5},
        ]
        self.assertEqual(select_segment(probabilities), 1)

    def test_keeps_the_first_segment_on_ties(self):
        probabilities = [{"A": 0.5, "B": 0.0, "C": 0.5}, {"A": 0.25, "B": 0.5, "C": 0.25}]
        self.assertEqual(select_segment(probabilities), 0)


@unittest.skipUnless(importlib.util.find_spec("laya") is not None, "locked laya package is not installed")
class LockedSequenceContractTest(unittest.TestCase):
    def test_fake_sequence_contract_matches_the_locked_sdk(self):
        from laya.common import build_sequence

        tok = FakeTokenizer()
        question = relevance_question()
        internal = {"t": "choice", "ins": question["instructions"], "crit": question["criteria"]}
        for state in ["short state", words(300, "body"), "with <mask> token"]:
            for max_len, head_max_len in [(128, 64), (96, 24), (1024, 256)]:
                self.assertEqual(
                    sdk_sequence_contract(tok, state, internal, max_len, head_max_len),
                    build_sequence(tok, state, internal, max_len, head_max_len),
                )


def real_model_available():
    model_dir = os.environ.get("BRAIN_LAYA_MODEL_DIR")
    return bool(model_dir) and os.path.isdir(model_dir) and importlib.util.find_spec("laya") is not None


REQUIRE_MODEL = os.environ.get("BRAIN_LAYA_REQUIRE_MODEL") == "1"


@unittest.skipUnless(real_model_available() or REQUIRE_MODEL, "real Laya checkpoint is not prepared")
class RealCheckpointFittingContractTest(unittest.TestCase):
    agent = None

    @classmethod
    def setUpClass(cls):
        if not real_model_available():
            raise AssertionError("BRAIN_LAYA_MODEL_DIR must point to a verified runtime copy with laya installed")
        from workers.laya.worker import load_local_agent

        cls.agent = load_local_agent(os.environ["BRAIN_LAYA_MODEL_DIR"])
        cls.question = relevance_question()

    def assert_sequence_contract(self, result):
        from laya.common import build_sequence

        internal = {"t": "choice", "ins": self.question["instructions"], "crit": self.question["criteria"]}
        for segment in result.segments:
            ids, markers = build_sequence(
                self.agent.tok, segment.state, internal, self.agent.cfg["max_len"], self.agent.cfg["head_max_len"]
            )
            self.assertEqual(list(segment.input_ids), ids)
            self.assertEqual(len(markers), 3)
            self.assertLessEqual(len(ids), self.agent.cfg["max_len"])

    def test_checkpoint_limits_are_the_shipped_values(self):
        self.assertEqual(self.agent.cfg["max_len"], 1024)
        self.assertEqual(self.agent.cfg["head_max_len"], 256)

    def test_english_and_norwegian_inputs_fit_and_match_sdk_token_counts(self):
        cases = [
            ("How is the search index rebuilt?", "Search index", "The index is rebuilt from current Markdown files."),
            ("Hvordan gjenoppbygges søkeindeksen?", "Søkeindeks", "Indeksen bygges på nytt fra gjeldende Markdown-filer."),
        ]
        for query, title, excerpt in cases:
            result = fit_state(self.agent, query, title, excerpt, self.question)
            self.assertFalse(result.truncated)
            self.assert_sequence_contract(result)
            predicted = self.agent.predict_batch([result.segments[0].state], {"relevance": self.question}, batch_size=8)
            self.assertEqual(predicted[0]["usage"]["input_tokens"], result.segments[0].input_tokens)

    def test_long_excerpt_is_rechunked_into_exact_slices(self):
        excerpt = " ".join("Avsnitt %d beskriver gjenoppbygging av indeksen og sikkerhetskopier." % index for index in range(400))
        result = fit_state(self.agent, "sikkerhetskopi", "Drift", excerpt, self.question)
        self.assertTrue(result.truncated)
        self.assertGreater(len(result.segments), 1)
        for segment in result.segments:
            self.assertEqual(segment.excerpt, excerpt[segment.excerpt_start:segment.excerpt_end])
        self.assert_sequence_contract(result)

    def test_reserved_literals_reach_the_model_as_literal_text(self):
        from laya.common import build_sequence

        tok = self.agent.tok
        internal = {"t": "choice", "ins": self.question["instructions"], "crit": self.question["criteria"]}
        prefix, _markers = build_sequence(tok, "", internal, self.agent.cfg["max_len"], self.agent.cfg["head_max_len"])
        literals = reserved_literals(tok)
        reserved_ids = set(tok.all_special_ids)
        for literal in literals:
            encoded = tok(literal, add_special_tokens=False)["input_ids"]
            if len(encoded) == 1:
                reserved_ids.add(encoded[0])
        self.assertIn("<mask>", literals)
        self.assertIn("<eos>", literals)
        self.assertIn("<unused5>", literals)
        for query, piece in [
            ("<mask>", "mask"),
            ("find <mask> notes", "mask"),
            ("<eos>", "eos"),
            ("a <start_of_turn> b", "start"),
            ("<unused5>", "unused"),
        ]:
            result = fit_state(self.agent, query, "Title", "Excerpt with <mask> inside", self.question)
            self.assertFalse(result.truncated)
            segment = result.segments[0]
            ids = list(segment.input_ids)
            state_ids = ids[len(prefix) - 1:-1]
            self.assertEqual(ids.count(tok.mask_token_id), 3)
            self.assertFalse(reserved_ids.intersection(state_ids), query)
            self.assertIn(piece, tok.convert_ids_to_tokens(state_ids))
            decoded = tok.decode(state_ids)
            self.assertIn(literal_text(query, literals), decoded)
            self.assertIn("Excerpt with <" + WORD_JOINER + "mask> inside", decoded)
            self.assertEqual(segment.excerpt, "Excerpt with <mask> inside")
            predicted = self.agent.predict_batch([segment.state], {"relevance": self.question}, batch_size=8)
            self.assertEqual(predicted[0]["usage"]["input_tokens"], segment.input_tokens)

    def test_overlong_query_is_rejected(self):
        with self.assertRaises(InputTooLong):
            fit_state(self.agent, " ".join("term%d" % index for index in range(1500)), "Title", "Body", self.question)
        self.assertEqual(self.agent.cfg["max_len"], 1024)


if __name__ == "__main__":
    unittest.main()
