"""Reads a game menu screenshot on this PC with free, local OCR and turns what it
read into the same small report Game Log shows. Nothing leaves your PC except
that report (numbers and text), never the picture, and nothing is paid for.

OCR copies the text that is on screen, so it can't invent a number the way an
image-reading AI can. When it can't read something clearly the field stays empty.

Library: RapidOCR (rapidocr-onnxruntime), which bundles its own models.

    python gamelog_reader.py --shot FILE     print what it read from one screenshot
"""
import re

LEAGUES = ["BRONZE", "SILVER", "GOLD", "PLATINUM", "DIAMOND", "EMERALD", "RUBY"]
LEAGUE_RE = re.compile(r"\b(" + "|".join(LEAGUES) + r")\b(?:\s*(IV|III|II|I|[1-4])\b)?")
NUMRE = re.compile(r"\d{1,3}(?:[,.]\d{3})+|\d+")
FRACTION_END = re.compile(r"^(?P<name>.*?)[\s:\-\u2013]*(?P<a>" + NUMRE.pattern + r")\s*/\s*(?P<b>" + NUMRE.pattern + r")\s*$")
GENERIC = {"CONTRACTS", "CONTRACT", "CHALLENGES", "CHALLENGE", "DAILY", "WEEKLY", "SEASONAL", "REWARD", "REWARDS",
           "PROGRESS", "COMPLETE", "COMPLETED", "CLAIM", "ACTIVE", "BATTLE PASS", "TIER", "LEVEL", "XP"}


class OcrMissing(Exception):
    """RapidOCR isn't installed (run setup.bat again)."""


# ---------------------------------------------------------------- OCR

def _overlap(a, b):
    w = min(a["x1"], b["x1"]) - max(a["x0"], b["x0"])
    h = min(a["y1"], b["y1"]) - max(a["y0"], b["y0"])
    if w <= 0 or h <= 0:
        return 0.0
    small = min((a["x1"] - a["x0"]) * (a["y1"] - a["y0"]), (b["x1"] - b["x0"]) * (b["y1"] - b["y0"]))
    return (w * h) / small if small > 0 else 0.0


def _merge(lines, new):
    """Keep the better reading when two passes found the same text."""
    hit = [l for l in lines if _overlap(l, new) > 0.5]
    if not hit:
        lines.append(new)
    elif new["score"] > sum(l["score"] for l in hit) / len(hit):
        for l in hit:
            lines.remove(l)
        lines.append(new)


def ocr_lines(path):
    """[{text, score, x0, y0, x1, y1}] in the picture's own pixels, top to bottom.

    Two passes, merged: a full-size greyscale pass (best on small text) and a half-size
    pass (best on big stylised text). Each one alone misses or garbles something."""
    try:
        import numpy as np
        from PIL import Image, ImageOps
        from rapidocr_onnxruntime import RapidOCR
    except ImportError as e:
        raise OcrMissing(str(e)) from None
    im = Image.open(path).convert("RGB")
    W, H = im.size
    passes = [(ImageOps.autocontrast(im.convert("L")).convert("RGB"), 1.0)]
    if max(W, H) > 1920:
        k = 1920 / max(W, H)
        passes.append((im.resize((round(W * k), round(H * k)), Image.LANCZOS), 1 / k))
    engine = RapidOCR()
    lines = []
    for img, up in passes:
        res, _ = engine(np.asarray(img))
        for box, text, score in res or []:
            text = str(text).strip()
            if not text:
                continue
            xs, ys = [p[0] * up for p in box], [p[1] * up for p in box]
            _merge(lines, {"text": text, "score": float(score), "x0": min(xs), "y0": min(ys), "x1": max(xs), "y1": max(ys)})
    del engine
    return sorted(lines, key=lambda l: (l["y0"], l["x0"]))


# ---------------------------------------------------------------- helpers

def _h(l): return max(1.0, l["y1"] - l["y0"])
def _cy(l): return (l["y0"] + l["y1"]) / 2
def _cx(l): return (l["x0"] + l["x1"]) / 2


def to_int(s):
    return int(re.sub(r"[,.]", "", s))


def number_near(lines, i, after=None):
    """The number a label line points at: after the label on the same line, else the
    closest number to its right, else the closest one just below it."""
    lab = lines[i]
    txt = lab["text"].upper()
    if after:
        m = re.search(after + r"\D{0,6}(" + NUMRE.pattern + ")", txt)
        if m:
            return to_int(m.group(1))
    h = _h(lab)
    right, below = [], []
    for j, o in enumerate(lines):
        t = o["text"].strip()
        if j == i or not NUMRE.search(t) or t.startswith("#"):
            continue
        if len(re.sub(r"[\d,.\s]", "", t)) > 3:   # a sentence, not a value
            continue
        d = abs(_cx(o) - _cx(lab)) + abs(_cy(o) - _cy(lab))
        if abs(_cy(o) - _cy(lab)) <= 1.2 * h and 0 <= o["x0"] - lab["x1"] <= 14 * h:
            right.append((d, t))
        elif 0 < o["y0"] - lab["y1"] <= 2.5 * h and abs(_cx(o) - _cx(lab)) <= 6 * h:
            below.append((d, t))
    pick = min(right) if right else min(below) if below else None
    return to_int(NUMRE.search(pick[1]).group(0)) if pick else None


def find(lines, pattern):
    return [i for i, l in enumerate(lines) if re.search(pattern, l["text"].upper())]


def classify(lines):
    text = " ".join(l["text"].upper() for l in lines)
    s = {"battle_pass": 0, "league": 0, "contracts": 0}
    if re.search(r"BATTLE\s*PASS", text): s["battle_pass"] += 3
    if re.search(r"\bT[I1L]?ER\b|\bLEVEL\b", text) and re.search(r"\bXP\b", text): s["battle_pass"] += 1
    if "RANK SCORE" in text or re.search(r"\bRS\b", text): s["league"] += 3
    if LEAGUE_RE.search(text) and ("RANK" in text or "LEAGUE" in text): s["league"] += 1
    if re.search(r"CONTRACT|CHALLENGE|WEEKLY|DAILY", text): s["contracts"] += 2
    if sum(1 for l in lines if FRACTION_END.match(l["text"].strip()) and "XP" not in l["text"].upper()) >= 3: s["contracts"] += 1
    best = max(s, key=lambda k: s[k])
    return best if s[best] >= 2 else "other"


# ---------------------------------------------------------------- THE FINALS

def _battle_pass(lines):
    out = {"tier": None, "tierMax": None, "xp": None, "xpNeeded": None, "track": None}
    for l in lines:
        t = l["text"].upper()
        m = re.search(r"\b(?:T[I1L]?ER|LEVEL|LVL|LV)\.?\s*(\d{1,3})\b(?:\s*/\s*(\d{2,3}))?", t)
        if m and out["tier"] is None:
            out["tier"] = int(m.group(1))
            if m.group(2) and int(m.group(2)) >= out["tier"]:
                out["tierMax"] = int(m.group(2))
    if out["tier"] is None:   # label and number came out as separate boxes: "TIER" ... "47"
        for i in find(lines, r"^(T[I1L]?ER|LEVEL)\.?$"):
            n = number_near(lines, i)
            if n is not None and n <= 500:
                out["tier"] = n
                break
    for i in find(lines, r"\bXP\b"):
        t = lines[i]["text"].upper()
        m = re.search(r"(" + NUMRE.pattern + r")\s*/\s*(" + NUMRE.pattern + ")", t)
        if m:
            out["xp"], out["xpNeeded"] = to_int(m.group(1)), to_int(m.group(2))
            break
        for o in lines:   # "12,300 / 20,000" in the box next to the XP label
            m = FRACTION_END.match(o["text"].strip())
            if m and not m.group("name").strip() and o is not lines[i] and abs(_cy(o) - _cy(lines[i])) <= 2.5 * _h(lines[i]):
                out["xp"], out["xpNeeded"] = to_int(m.group("a")), to_int(m.group("b"))
                break
        if out["xp"] is not None:
            break
    if out["xp"] is not None and out["xp"] > out["xpNeeded"]:
        out["xp"] = out["xpNeeded"] = None   # not an XP bar after all
    return out


def _league(lines):
    out = {"name": None, "rankScore": None, "position": None}
    labels = find(lines, r"RANK\s*SCORE|\bRS\b")
    if labels:
        out["rankScore"] = number_near(lines, labels[0], r"(?:RANK\s*SCORE|RS)")
        if out["rankScore"] is None:
            for l in lines:
                m = re.search(r"(" + NUMRE.pattern + r")\s*RS\b", l["text"].upper())
                if m:
                    out["rankScore"] = to_int(m.group(1))
                    break
    cands = []
    for i, l in enumerate(lines):
        m = LEAGUE_RE.search(l["text"].upper())
        if m:
            cands.append((m.group(1).title() + (" " + m.group(2) if m.group(2) else ""), m.group(1), i))
    if cands:
        if len({c[1] for c in cands}) == 1:
            out["name"] = cands[0][0]
        elif labels:   # a ladder of leagues is on screen: take the one next to the score
            lab = lines[labels[0]]
            d, c = min((abs(_cy(lines[c[2]]) - _cy(lab)) + abs(_cx(lines[c[2]]) - _cx(lab)), c) for c in cands)
            if d <= 12 * _h(lab):
                out["name"] = c[0]
    for l in lines:
        m = re.search(r"#\s*(" + NUMRE.pattern + ")", l["text"])
        if m:
            out["position"] = to_int(m.group(1))
            break
    return out


def _contracts(lines):
    out, seen = [], set()
    for i, l in enumerate(lines):
        m = FRACTION_END.match(l["text"].strip())
        if not m or "XP" in l["text"].upper():
            continue
        a, b = to_int(m.group("a")), to_int(m.group("b"))
        if b <= 0 or a > b * 50:
            continue
        name = re.sub(r"^[^A-Za-z0-9]+|[^A-Za-z0-9)]+$", "", m.group("name")).strip()
        if len(re.findall(r"[A-Za-z]", name)) < 4:
            name = ""
            h = _h(l)
            row = [o for j, o in enumerate(lines) if j != i and abs(_cy(o) - _cy(l)) <= 0.8 * h and o["x1"] <= l["x0"] + 5]
            above = [o for j, o in enumerate(lines) if j != i and 0 <= l["y0"] - o["y1"] <= 3 * h and abs(o["x0"] - l["x0"]) <= 500]
            for o in sorted(row, key=lambda o: l["x0"] - o["x1"]) + sorted(above, key=lambda o: l["y0"] - o["y1"]):
                t = re.sub(r"^[^A-Za-z0-9]+|[^A-Za-z0-9)]+$", "", o["text"]).strip()
                if len(re.findall(r"[A-Za-z]", t)) >= 4 and t.upper() not in GENERIC and not FRACTION_END.match(o["text"].strip()):
                    name = t
                    break
        if not name or name.upper() in seen or name.upper() in GENERIC:
            continue
        seen.add(name.upper())
        out.append({"name": name[:120], "progress": a, "target": b, "done": a >= b})
        if len(out) >= 12:
            break
    return out


def parse_finals(lines):
    """OCR lines from a THE FINALS menu -> the report Game Log stores."""
    screen = classify(lines)
    text = " ".join(l["text"].upper() for l in lines)
    sm = re.search(r"SEASON\s*(\d{1,2})\b", text)
    rep = {"screen": screen, "season": f"Season {sm.group(1)}" if sm else None,
           "battlePass": {"tier": None, "tierMax": None, "xp": None, "xpNeeded": None, "track": None},
           "league": {"name": None, "rankScore": None, "position": None},
           "challenges": [], "confidence": "low", "notes": None,
           "raw": [l["text"][:80] for l in lines][:60]}
    found = 0
    if screen == "battle_pass":
        rep["battlePass"] = _battle_pass(lines)
        found = sum(v is not None for k, v in rep["battlePass"].items() if k in ("tier", "xp"))
    elif screen == "league":
        rep["league"] = _league(lines)
        found = sum(v is not None for k, v in rep["league"].items() if k in ("name", "rankScore"))
    elif screen == "contracts":
        rep["challenges"] = _contracts(lines)
        found = 2 if len(rep["challenges"]) >= 2 else len(rep["challenges"])
    if screen != "other":
        scores = [l["score"] for l in lines] or [0]
        conf = 2 if found >= 2 else 1 if found == 1 else 0
        if sum(scores) / len(scores) < 0.8:
            conf -= 1   # shaky OCR scores: one notch less sure
        rep["confidence"] = {2: "high", 1: "medium"}.get(conf, "low")
        if found == 0:
            rep["notes"] = "The screen looked like this one but no numbers could be read from it."
    return rep


PARSERS = {"the-finals": parse_finals}


def read(path, slug="the-finals"):
    if slug not in PARSERS:
        raise ValueError(f"no screenshot reader for {slug}")
    return PARSERS[slug](ocr_lines(path))
