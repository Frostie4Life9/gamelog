"""Game Log save reader.

Watches game saves on this PC, reads them (never writes), and sends Game Log a
short progress report through your gamelog-sync Worker.

Each game is one reader function that returns the same report shape:
    {"savedAt": ms, "slot": str, "done": [{"tab", "id"}], "summary": {...}}
Game Log only ever sees that report.

Crimson Desert save format credit: NattKh/CRIMSON-DESERT-SAVE-EDITOR-AND-GAME-MODS
(MPL-2.0) and its contributors (gek, potter420, LukeFZ). This is an independent,
read-only reimplementation of the parts Game Log needs.

Usage:
    python gamelog_reader.py --once     read the newest save now, send, exit
    python gamelog_reader.py            keep running; send whenever a save changes
    python gamelog_reader.py --dry-run  print the report instead of sending it
"""
import glob, hashlib, hmac, json, os, struct, sys, time, urllib.request

import lz4.block
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(HERE, "gamelog-reader.json")
LOG = os.path.join(HERE, "gamelog-reader.log")
POLL_SECONDS = 20
SETTLE_SECONDS = 15  # wait for the game to finish writing before reading


def log(msg):
    line = time.strftime("%Y-%m-%d %H:%M:%S ") + msg
    print(line)
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
        if os.path.getsize(LOG) > 200_000:  # keep the log small
            keep = open(LOG, encoding="utf-8").read()[-100_000:]
            open(LOG, "w", encoding="utf-8").write(keep)
    except OSError:
        pass


# ---------------------------------------------------------------- Crimson Desert

_CD_BASE = bytes.fromhex("C41B8E730DF259A637CC04E9B12F9668DA107A853E61F9224DB80AD75C13EF90")[:31]
_CD_PREFIX = {1: b'^Qgbrm/.#@`zsr]\\@rvfal#"', 2: b"^Pearl--#Abyss__@!!"}


def cd_decrypt(path):
    data = open(path, "rb").read()
    if data[:4] != b"SAVE":
        raise ValueError("not a Crimson Desert save")
    version = struct.unpack_from("<H", data, 0x04)[0]
    if version not in _CD_PREFIX:
        raise ValueError(f"unknown save version {version} (a patch may have changed the format)")
    key = bytes(a ^ b for a, b in zip(_CD_BASE, _CD_PREFIX[version] + b"PRIVATE_HMAC_SECRET_CHECK")) + b"\x00"
    uncomp, size = struct.unpack_from("<I", data, 0x12)[0], struct.unpack_from("<I", data, 0x16)[0]
    nonce, tag = data[0x1A:0x2A], data[0x2A:0x4A]
    dec = Cipher(algorithms.ChaCha20(key, nonce), mode=None).decryptor()
    comp = dec.update(data[0x80:0x80 + size]) + dec.finalize()
    if not hmac.compare_digest(hmac.new(key, comp, hashlib.sha256).digest(), tag):
        raise ValueError("integrity check failed (save mid-write, or the format changed)")
    return lz4.block.decompress(comp, uncompressed_size=uncomp)


def _u16(b, o): return struct.unpack_from("<H", b, o)[0]
def _u32(b, o): return struct.unpack_from("<I", b, o)[0]


def cd_schema(raw):
    pos = 0x12
    count = _u16(raw, pos); pos += 2
    n = _u32(raw, pos); pos += 4
    name = raw[pos:pos + n].decode("ascii", "replace"); pos += n
    types = []
    for i in range(count):
        fc = _u16(raw, pos); pos += 2
        fields = []
        for _ in range(fc):
            n = _u32(raw, pos); pos += 4
            fname = raw[pos:pos + n].decode("ascii", "replace"); pos += n
            n = _u32(raw, pos); pos += 4
            pos += n  # type name
            fields.append((fname, _u16(raw, pos), _u16(raw, pos + 2))); pos += 8
        types.append((name, fields))
        if i != count - 1:
            n = _u32(raw, pos); pos += 4
            name = raw[pos:pos + n].decode("ascii", "replace"); pos += n
    toc_count = _u32(raw, pos + 4)
    blocks = {}
    for i in range(toc_count):
        ci, _, _, off, sz = struct.unpack_from("<5I", raw, pos + 12 + i * 20)
        if ci < len(types):
            blocks.setdefault(types[ci][0], (off, sz))
    return types, blocks


def cd_elements(raw, start, end, type_index, fields):
    """Decode inline list elements of one type: their leading fixed-size fields."""
    out, sentinel = [], b"\xff" * 8
    i = raw.find(sentinel, start, end)
    while i != -1:
        hdr = i - 3
        if hdr - 3 >= start and _u16(raw, hdr) == type_index and _u32(raw, i + 8) == i + 12:
            for mc in range(1, 17):
                m0 = hdr - mc - 2
                if m0 < start or _u16(raw, m0) != mc:
                    continue
                mask, rec, cur = raw[m0 + 2:hdr], {}, i + 16
                for idx, (fname, kind, size) in enumerate(fields):
                    if not (idx // 8 < len(mask) and mask[idx // 8] >> (idx % 8) & 1):
                        continue
                    if kind not in (0, 2) or size not in (1, 2, 4, 8):
                        break
                    rec[fname] = int.from_bytes(raw[cur:cur + size], "little"); cur += size
                out.append(rec)
                break
        i = raw.find(sentinel, i + 8, end)
    return out


def cd_states(raw, block, type_name, key_field, value_field):
    types, blocks = cd_schema(raw)
    names = [t[0] for t in types]
    if block not in blocks or type_name not in names:
        raise ValueError(f"no {type_name} found (the save layout may have changed)")
    ti = names.index(type_name)
    off, sz = blocks[block]
    out = {}
    for e in cd_elements(raw, off, off + sz, ti, types[ti][1]):
        if key_field in e:
            out[e[key_field]] = max(out.get(e[key_field], 0), e.get(value_field, 0))
    return out


def cd_quest_states(raw):
    states = cd_states(raw, "QuestSaveData", "QuestStateData", "_questKey", "_state")
    if len(states) < 20:
        raise ValueError(f"only {len(states)} quests decoded (the save layout may have changed)")
    return states


# Challenges, collectibles and Observe skills: cd_goals.json (built from Game Log's
# content files) maps mission and knowledge keys in the save to goals.
CD_GOALS = os.path.join(HERE, "cd_goals.json")


def cd_extra_done(raw):
    try:
        goals = json.load(open(CD_GOALS, encoding="utf-8"))
    except FileNotFoundError:
        log("crimson-desert: cd_goals.json is missing, so only main quests are read")
        return []
    done = []
    missions = cd_states(raw, "QuestSaveData", "MissionStateData", "_key", "_state")
    for key, (tab, gid) in goals.get("mission", {}).items():
        if missions.get(int(key), 0) >= COMPLETED:
            done.append({"tab": tab, "id": gid})
    known = cd_states(raw, "KnowledgeSaveData", "KnowledgeElementSaveData", "_key", "_level")
    for key, (tab, gid) in goals.get("knowledge", {}).items():
        if int(key) in known:
            done.append({"tab": tab, "id": gid})
    return done


# Main story: save keys from the game's quest table (game version 2.0.x), names as
# guides show them. Groups 1001-1012 are Chapters 1-12; 1000 the Prologue, 1013 the Epilogue.
# Each quest is goal cd-main-<key> in content/crimson-desert/story.json.
CD_MAIN = [
    (1000, 10001, "Ambush"), (1000, 1000123, "Unknown Space"),
    (1001, 1000027, "Trials of Kindness"), (1001, 1000509, "Trace"),
    (1002, 1000004, "Unexpected Gift"), (1002, 10011000, "Hernand in Chaos"), (1002, 1000267, "The End of Greed"),
    (1003, 11006000, "Homestead"), (1003, 10029000, "The Face Behind the Mask"), (1003, 1001048, "Pioneering"),
    (1004, 1000142, "Mysterious Iron Pot"), (1004, 1001216, "Daily Life"), (1004, 10040400, "Forbidden Knowledge"),
    (1005, 1000118, "Uninvited Guest"), (1005, 1000724, "Black and White"),
    (1006, 10060100, "Blazing Beacon"), (1006, 1000781, "Under the Banner Pike Again"), (1006, 1000281, "Turning Tides"), (1006, 1000112, "The Unyielding Shields"),
    (1007, 1000579, "Dawn Mist"), (1007, 1000597, "Dawnrise"), (1007, 1000099, "Decisive Battle"), (1007, 1000009, "Twisted Fate"),
    (1008, 1001076, "Ashen Steps"), (1008, 1000725, "To Demeniss"), (1008, 1000180, "Traitor"),
    (1009, 1000354, "The Calling"), (1009, 1000212, "Shattered Ties"), (1009, 1000292, "Thinning Blade"), (1009, 1000305, "Six Pensive Statues and the Evil Spirit"), (1009, 1000319, "Veiled Witch"), (1009, 1000355, "Enlightenment"),
    (1010, 1000767, "Secret Weapon"), (1010, 1000776, "Greater Firepower"),
    (1011, 1000741, "Brave New World"), (1011, 1000135, "Foreboding Shadow"),
    (1012, 1000139, "The Final Battle"), (1012, 1000726, "The Void"),
    (1013, 1000358, "Journey's End"),
]
COMPLETED = 5  # 5 = completed, 6 = reward received


def cd_report(states):
    done_q = lambda k: states.get(k, 0) >= COMPLETED
    groups = {}
    for grp, key, _ in CD_MAIN:
        groups.setdefault(grp, []).append(key)
    group_done = {g: all(done_q(k) for k in ks) for g, ks in groups.items()}
    done = [{"tab": "story", "id": f"cd-main-{k}"} for _, k, _ in CD_MAIN if done_q(k)]
    nxt = next(((g, n) for g, k, n in CD_MAIN if not done_q(k)), None)
    left = sum(1 for g in range(1001, 1013) if not group_done[g])
    summary = {"chaptersLeft": left}
    if nxt:
        g, n = nxt
        summary["next"] = n
        summary["chapter"] = "Epilogue" if g == 1013 else "Prologue" if g == 1000 else f"Chapter {g - 1000}"
    else:
        summary["note"] = "Main story finished."
    return done, summary


def crimson_desert():
    root = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Pearl Abyss", "CD", "save")
    saves = [p for p in glob.glob(os.path.join(root, "*", "slot*", "save.save"))]
    if not saves:
        return None
    path = max(saves, key=os.path.getmtime)
    raw = cd_decrypt(path)
    done, summary = cd_report(cd_quest_states(raw))
    done += cd_extra_done(raw)
    slot = os.path.basename(os.path.dirname(path))
    num = int(slot[4:]) if slot[4:].isdigit() else -1
    return {
        "game": "crimson-desert",
        "savedAt": int(os.path.getmtime(path) * 1000),
        "slot": ("Autosave" if num >= 100 else f"Slot {num + 1}") if num >= 0 else slot,
        "reader": "gamelog-reader 3",
        "done": done,
        "summary": summary,
    }, path


READERS = {"crimson-desert": crimson_desert}


# ---------------------------------------------------------------- sending

def load_config():
    try:
        cfg = json.load(open(CONFIG, encoding="utf-8"))
    except FileNotFoundError:
        sys.exit(f"Missing {CONFIG}. Copy gamelog-reader.example.json to that name and fill it in.")
    if not cfg.get("url") or not cfg.get("key"):
        sys.exit("gamelog-reader.json needs both 'url' (your Worker URL) and 'key' (your sync secret).")
    return cfg


def send(cfg, slug, report):
    req = urllib.request.Request(
        cfg["url"].rstrip("/") + "/progress/" + slug,
        data=json.dumps(report).encode(), method="PUT",
        headers={"x-sync-key": cfg["key"], "content-type": "application/json", "user-agent": "gamelog-reader"},
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read() or b"{}")


def run_once(cfg, dry, last, once=False):
    ok = True
    for slug, reader in READERS.items():
        try:
            got = reader()
        except Exception as e:  # a broken reader only affects its own game
            log(f"{slug}: couldn't read the save: {e}")
            ok = False
            continue
        if not got:
            continue
        report, path = got
        sig = (path, report["savedAt"])
        if last.get(slug) == sig:
            continue
        if time.time() - report["savedAt"] / 1000 < SETTLE_SECONDS and not dry and not once:
            continue  # still being written; next pass picks it up
        if dry:
            print(json.dumps(report, indent=2))
            last[slug] = sig
            continue
        try:
            res = send(cfg, slug, report)
            last[slug] = sig
            log(f"{slug}: sent ({report['slot']}, {len(report['done'])} goals done, next: {report['summary'].get('next', '-')}) {res}")
        except Exception as e:
            log(f"{slug}: couldn't reach the Worker: {e}")
            ok = False
    return ok


def main():
    dry = "--dry-run" in sys.argv
    cfg = {} if dry else load_config()
    last = {}
    if "--once" in sys.argv or dry:
        ok = run_once(cfg, dry, last, once=True)
        if ok and not last:
            log("no Crimson Desert save found on this PC")
            ok = False
        sys.exit(0 if ok else 1)
    log("watching saves")
    while True:
        run_once(cfg, dry, last)
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
