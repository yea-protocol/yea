"""Showing untrusted text (mirrors ts/test/text.test.ts), and where it's applied (#100)."""

import json
import re

from yea import Plan, create, lens
from yea.approval import HashedPlan, Policy, build_form, plan_hash
from yea.lens import untrusted_lens
from yea.text import clip, json_printable, one_line, printable


def test_clip():
    assert clip("hello", 5) == "hello" and clip("abcd😀", 5) == "abcd😀" and clip("", 3) == ""
    assert clip("hello world", 5) == "hell…" and clip("héllo wörld", 6) == "héllo…"
    assert clip("abc😀def", 5) == "abc😀…" and clip("abcd😀e", 5) == "abcd…" and clip("😀😀😀", 2) == "😀…"
    assert clip("hello", 1) == "…" and clip("hello", 0) == "" and clip("hello", -3) == ""


def test_printable_escapes_controls_format_characters_and_separators():
    assert printable("a\nb\x7fc\x85d") == "a\\u{a}b\\u{7f}c\\u{85}d"
    assert printable("a\u200bb­c﻿d") == "a\\u{200b}b\\u{ad}c\\u{feff}d"
    assert printable("a\U000e0041bㅤc") == "a\\u{e0041}b\\u{3164}c"
    assert printable("a͏b឴c") == "a\\u{34f}b\\u{17b4}c"
    assert printable("\u202eevil") == "\\u{202e}evil" and printable("a\u2028b") == "a\\u{2028}b"


def test_printable_keeps_tab_accents_cjk_and_plain_emoji():
    assert printable("❤️ ⠀") == "❤️ ⠀"
    assert printable("\tcafé 東京 😀") == "\tcafé 東京 😀"


CPS = [chr(cp) for cp in (0x85, 0x180E, 0x3164, 0x206A, 0xFFF9, 0xE0041, 0xE0400, 0x2028)]


def test_json_printable_escapes_what_printable_escapes_and_still_parses():
    for c in CPS:
        out = json_printable(json.dumps(c, ensure_ascii=False))
        assert printable(c) != c and c not in out
        assert re.fullmatch(r'"(\\u[0-9a-f]{4})+"', out) and json.loads(out) == c


def test_json_printable_keeps_pretty_printed_json_valid():
    v = {"a": "".join(CPS), "b": ["x\ty", "❤️ 😀"], "c": {"d": 1}}
    out = json_printable(json.dumps(v, indent=2, ensure_ascii=False))
    assert len(out.split("\n")) > 1 and json.loads(out) == v and not any(c in out for c in CPS)


def test_one_line_escapes_strings_and_keys():
    assert one_line({"a\nb": ["x\ny", 1, None]}) == {"a\\u{a}b": ["x\\u{a}y", 1, None]}


EVIL = "Refund 5 USD\n+ create account/admin — granted\u202e"


def test_the_approval_form_cant_be_forged_by_a_summary():
    p = Plan(EVIL, [{"op": "create", "target": "a\nb", "detail": "x\u200by"}], lambda: None)
    hp = HashedPlan("refund", p, plan_hash("refund", {}, p, "low"), "low", False)
    other = HashedPlan("refund", Plan("B", [], lambda: None), "h2", "low", False)
    form = build_form([hp, other], "why\nforged", Policy(), lambda h: "approve")
    lines = form["message"].split("\n")
    assert not any(line.startswith("+ create account/admin") for line in lines)
    assert "Approval needed: why\\u{a}forged." in form["message"]
    assert "  + create a\\u{a}b — x\\u{200b}y" in lines
    assert "\u202e" not in form["message"] and "\u200b" not in form["message"]
    titles = [o["title"] for o in form["requested_schema"]["properties"]["plan"]["oneOf"]]
    assert "\n" not in titles[0] and "\\u{202e}" in titles[0]


def test_untrusted_lens_rebuilds_lines_and_escapes_what_quotes_leave():
    reply = {"yea": 1, "id": "s1", "re": "c1", "kind": "PROPOSALS", "lens": "forged own lens",
             "proposals": [{"id": "p1", "summary": EVIL, "effects": [{"op": "update", "target": "t", "from": "a\u202eb", "to": 2}],
                            "risk": "low", "undo": None, "expires": 1790000000}]}
    out = untrusted_lens(reply)
    assert "forged own lens" not in out and "\u202e" not in out
    assert not any(line.startswith("+ create account/admin") for line in out.split("\n"))
    plain = {**reply, "proposals": [{**reply["proposals"][0], "summary": "Plain", "effects": []}]}
    assert untrusted_lens(plain) == lens({k: v for k, v in plain.items() if k != "lens"})  # ordinary text is unchanged


def test_a_quoted_value_is_escaped_once():
    """Lens quotes from/to, a proposal's data and a receipt's result itself: printable must not
    escape them a second time (mirrors ts/test/security.test.ts [S4])."""
    props = {"yea": 1, "id": "s1", "re": "c1", "kind": "PROPOSALS",
             "proposals": [{"id": "p1", "summary": "S", "effects": [{"op": "update", "target": "t", "from": "a\u202eb", "to": 2}],
                            "risk": "low", "undo": None, "expires": 1790000000}]}
    assert '  ~ update t: "a\\u{202e}b" → 2' in untrusted_lens(props).split("\n")
    receipt = {"yea": 1, "id": "s2", "re": "c2", "kind": "RECEIPT",
               "receipt": {"id": "r1", "summary": "S", "at": 1790000000, "effects": [], "undo": None, "result": "ok\u2028x"}}
    assert '  result: "ok\\u{2028}x"' in untrusted_lens(receipt).split("\n")
    p = Plan("S", [{"op": "update", "target": "t", "from": "a\u202eb", "to": 2}], lambda: None)
    hp = HashedPlan("t", p, plan_hash("t", {}, p, "low"), "low", False)
    form = build_form([hp], "why", Policy(), lambda h: "approve")
    assert '  ~ update t: "a\\u{202e}b" → 2' in form["message"].split("\n")
