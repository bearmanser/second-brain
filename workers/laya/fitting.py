import functools
import re
from dataclasses import dataclass

TITLE_TOKEN_LIMIT = 32
MAX_SEGMENTS = 3
MIN_EXCERPT_TOKENS = 16
MAX_OPTION_TOKENS = 48
MIN_OPTION_BUDGET = 16
CHOICE_KEYS = ("A", "B", "C")
WORD_JOINER = "\u2060"
PLAIN_ADDED_TOKEN = re.compile(r"[\s\u2581]+")
_RESERVED = {}


class FittingError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


class InputTooLong(FittingError):
    def __init__(self):
        super().__init__("input_too_long")


@dataclass(frozen=True)
class FittedSegment:
    state: str
    input_ids: tuple
    input_tokens: int
    title: str
    excerpt: str
    excerpt_start: int
    excerpt_end: int


@dataclass(frozen=True)
class FitResult:
    segments: tuple
    truncated: bool


def reserved_literals(tok):
    literals = set(getattr(tok, "all_special_tokens", None) or ())
    decoder = getattr(tok, "added_tokens_decoder", None)
    if isinstance(decoder, dict):
        literals.update(getattr(token, "content", token) for token in decoder.values())
    mask = getattr(tok, "mask_token", None)
    if mask:
        literals.add(mask)
    kept = [
        literal
        for literal in literals
        if isinstance(literal, str) and len(literal) > 1 and not PLAIN_ADDED_TOKEN.fullmatch(literal)
    ]
    return tuple(sorted(kept, key=lambda literal: (-len(literal), literal)))


@functools.lru_cache(maxsize=8)
def _literal_pattern(literals):
    return re.compile("|".join(re.escape(literal) for literal in literals))


def literal_text(text, literals):
    if not literals:
        return text
    return _literal_pattern(tuple(literals)).sub(lambda match: match.group(0)[0] + WORD_JOINER + match.group(0)[1:], text)


def render_state(query, title, excerpt, literals=()):
    return "Query:\n%s\n\nNote title:\n%s\n\nNote excerpt:\n%s" % (
        literal_text(query, literals),
        literal_text(title, literals),
        literal_text(excerpt, literals),
    )


def _reserved(tok):
    cached = _RESERVED.get(id(tok))
    if cached is not None and cached[0] is tok:
        return cached[1], cached[2]
    literals = reserved_literals(tok)
    ids = {getattr(tok, name, None) for name in ("mask_token_id", "cls_token_id", "sep_token_id", "pad_token_id")}
    for literal in literals:
        encoded = tok(literal, add_special_tokens=False)["input_ids"]
        if len(encoded) == 1:
            ids.add(encoded[0])
    ids.discard(None)
    _RESERVED[id(tok)] = (tok, literals, frozenset(ids))
    return literals, frozenset(ids)


def context_title(title, heading):
    if heading is None or heading.strip() == "" or heading.strip() == title.strip():
        return title
    return "%s > %s" % (title, heading)


def select_segment(probabilities):
    best_index = 0
    best_value = None
    for index, item in enumerate(probabilities):
        value = item["A"] + 0.5 * item["B"]
        if best_value is None or value > best_value:
            best_index = index
            best_value = value
    return best_index


def _sequence_builder(agent):
    builder = getattr(agent, "build_sequence", None)
    if builder is not None:
        return builder
    from laya.common import build_sequence

    return build_sequence


def _internal_question(question):
    if not isinstance(question, dict) or question.get("type") != "choice":
        raise FittingError("unsupported_question")
    criteria = question.get("criteria")
    instructions = question.get("instructions")
    if not isinstance(instructions, str) or instructions.strip() == "":
        raise FittingError("unsupported_question")
    if not isinstance(criteria, dict) or tuple(criteria.keys()) != CHOICE_KEYS:
        raise FittingError("unsupported_question")
    if not all(isinstance(value, str) and value.strip() != "" for value in criteria.values()):
        raise FittingError("unsupported_question")
    return {"t": "choice", "ins": instructions, "crit": dict(criteria)}


class _Fitter:
    def __init__(self, agent, question):
        self.tok = agent.tok
        self.max_len = int(agent.cfg.get("max_len", 512))
        self.head_max_len = int(agent.cfg.get("head_max_len", 192))
        self.internal = _internal_question(question)
        self.build = _sequence_builder(agent)
        self.mask = self.tok.mask_token
        self.literals, self.reserved_ids = _reserved(self.tok)
        prefix, markers = self.build(self.tok, "", self.internal, self.max_len, self.head_max_len)
        self.prefix = list(prefix[:-1])
        self.markers = list(markers)
        self._verify_head()
        self.capacity = self.max_len - len(prefix)

    def encode(self, text, offsets=False):
        return self.tok(text, add_special_tokens=False, return_offsets_mapping=offsets)

    def neutral(self, text):
        return text.replace(self.mask, " ")

    def state_tokens(self, text):
        return list(self.encode(self.neutral(text))["input_ids"])

    def fits(self, state):
        return len(self.state_tokens(state)) <= self.capacity

    def render(self, query, title, excerpt):
        return render_state(query, title, excerpt, self.literals)

    def _verify_head(self):
        tok = self.tok
        head_ids = list(self.encode("choice question: %s" % self.neutral(self.internal["ins"]))["input_ids"])
        options = []
        for key, value in self.internal["crit"].items():
            option = [tok.mask_token_id] + list(self.encode(" " + self.neutral("%s: %s" % (key, value)))["input_ids"])
            if len(option) > MAX_OPTION_TOKENS + 1:
                raise FittingError("question_too_long")
            options.append(option)
        option_budget = self.head_max_len - sum(len(option) for option in options)
        if option_budget < MIN_OPTION_BUDGET or len(head_ids) > option_budget:
            raise FittingError("question_too_long")
        expected = [tok.cls_token_id] + head_ids + [tok.sep_token_id]
        markers = []
        for option in options:
            markers.append(len(expected))
            expected.extend(option)
        expected.append(tok.sep_token_id)
        if self.prefix != expected or self.markers != markers or len(markers) != len(CHOICE_KEYS):
            raise FittingError("question_too_long")
        if len(expected) + 1 > self.max_len:
            raise FittingError("question_too_long")

    def segment(self, query, title, excerpt, start, end):
        state = self.render(query, title, excerpt)
        ids, markers = self.build(self.tok, state, self.internal, self.max_len, self.head_max_len)
        ids = list(ids)
        state_ids = self.state_tokens(state)
        if list(markers) != self.markers or len(markers) != len(CHOICE_KEYS):
            raise FittingError("sequence_contract")
        if ids != self.prefix + state_ids + [self.tok.sep_token_id] or len(ids) > self.max_len:
            raise FittingError("sequence_contract")
        if self.neutral(state) != state or literal_text(query, self.literals) not in state:
            raise FittingError("sequence_contract")
        if self.reserved_ids.intersection(state_ids):
            raise FittingError("sequence_contract")
        return FittedSegment(
            state=state,
            input_ids=tuple(ids),
            input_tokens=len(ids),
            title=title,
            excerpt=excerpt,
            excerpt_start=start,
            excerpt_end=end,
        )

    def shortened_title(self, title):
        encoded = self.encode(title, offsets=True)
        offsets = encoded["offset_mapping"]
        if len(offsets) <= TITLE_TOKEN_LIMIT:
            return title
        return title[: offsets[TITLE_TOKEN_LIMIT - 1][1]]

    def windows(self, query, title, excerpt):
        offsets = list(self.encode(excerpt, offsets=True)["offset_mapping"])
        segments = []
        index = 0
        start = 0
        while index < len(offsets) and len(segments) < MAX_SEGMENTS:
            low, high, best = index, len(offsets) - 1, None
            while low <= high:
                middle = (low + high) // 2
                end = offsets[middle][1]
                if self.fits(self.render(query, title, excerpt[start:end])):
                    best = middle
                    low = middle + 1
                else:
                    high = middle - 1
            if best is None:
                raise InputTooLong()
            end = offsets[best][1]
            segments.append(self.segment(query, title, excerpt[start:end], start, end))
            index = best + 1
            if index < len(offsets):
                start = offsets[index][0]
        return tuple(segments)


def fit_state(agent, query, title, excerpt, question):
    fitter = _Fitter(agent, question)
    if not fitter.fits(fitter.render(query, "", "")):
        raise InputTooLong()
    short_title = fitter.shortened_title(title)
    for candidate in dict.fromkeys([title, short_title, ""]):
        if fitter.fits(fitter.render(query, candidate, excerpt)):
            segment = fitter.segment(query, candidate, excerpt, 0, len(excerpt))
            return FitResult(segments=(segment,), truncated=candidate != title)
    window_title = short_title
    title_room = fitter.capacity - len(fitter.state_tokens(fitter.render(query, short_title, "")))
    if title_room < MIN_EXCERPT_TOKENS:
        window_title = ""
    return FitResult(segments=fitter.windows(query, window_title, excerpt), truncated=True)
