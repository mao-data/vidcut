#!/usr/bin/env python3
"""文字 → 透明 PNG 字卡（給 vidcut render 的 caption 用，繞過 ffmpeg 無 drawtext）。

用法：讀 stdin 的 JSON：
  {"out": "...png", "text": "字幕", "fontSize": 64, "fill": "#ffffff",
   "stroke": "#000000"|null, "width": 1080, "margin": 54}

自動換行：可用寬 = width - margin*2。`margin` 由呼叫端算（TS 那側是
`cardMargin(width, maxWidthFrac)`，見 server/src/rasterizer.ts），省略時退回
`max(32, width // 20)`（＝ 1080 寬時的 maxWidthFrac 0.9）。有無 tokens 都會換行：
CJK 逐字、拉丁在空白處（不切進單字中間）、真的 `\n` 強制換行、
單一原子超寬時逐字硬切（見 wrap_text / break_overwide）。

逐詞高亮（karaoke）時額外給：
  {"tokens": ["這","隻","貓"], "activeIndex": 1, "highlight": "#FCDE5A"}
activeIndex 及其之前的詞用 highlight 色，之後用 fill 色。排版對同一組 tokens
是確定性的（只有顏色隨 activeIndex 變），所以 N 張卡幾何完全對齊，
播起來就像同一張圖在變色。

產出：寬 = width、高 = 依字級與行數自動、透明底、水平置中、可選描邊的 PNG。
與 make_overlays.py 同路子（Pillow）。跨機器不依賴 ffmpeg 字型支援。

--worker：改吃常駐模式（stdin 一行 JSON → stdout 一行 JSON，逐行處理直到 EOF）。
供 server/src/rasterizer.ts 用（7ms/張 vs 逐次 spawn 50-70ms）。CLI 單卡模式
（本檔預設走法，"out" 鍵）行為不變 —— server/src/render.ts 依賴它。
"""
import json
import sys
from PIL import Image, ImageDraw, ImageFont

# CJK + 拉丁字型候選（macOS 內建），依序嘗試
FONT_CANDIDATES = [
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
]

# 與 shared/src/captions.ts 的 CJK 判定一致：決定詞之間要不要空白
CJK_RANGES = (
    (0x3000, 0x303F),
    (0x3040, 0x30FF),
    (0x3400, 0x4DBF),
    (0x4E00, 0x9FFF),
    (0xF900, 0xFAFF),
    (0xFF00, 0xFFEF),
)


def is_cjk(ch: str) -> bool:
    cp = ord(ch)
    return any(lo <= cp <= hi for lo, hi in CJK_RANGES)


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def separator(prev: str, nxt: str) -> str:
    """CJK 與任何字之間不加空白（中文排版慣例）；拉丁之間加空白。"""
    if not prev or not nxt:
        return ""
    return "" if is_cjk(prev[-1]) or is_cjk(nxt[0]) else " "


# 不得置於行首的字元（中文標點禁則的最小版本）。這些字在切「原子」時會被黏回
# 前一個原子，所以永遠不會變成某一行的開頭。**只做「行首禁則」**：
# 「開頭引號不得置於行尾」（「（《…）沒有做，那需要往後看一個原子的預讀，
# 而且會讓「每個原子至少消耗一次迴圈」的收斂論證變複雜——刻意留白，不是漏掉。
NO_BREAK_BEFORE = "。，、．：；！？）〕］｝」』〉》】…—～·%!?,.:;)]}"


def _atom_class(ch: str) -> str:
    if ch.isspace():
        return "space"
    return "cjk" if is_cjk(ch) else "word"


def split_atoms(s: str):
    """段落 → 不可再拆的排版單位（原子）。回傳 [(text, cls), ...]。

    - **CJK 逐字**：中文可以在任意兩字之間換行，所以每個漢字/假名/全形標點自成一個原子。
    - **拉丁整個單字**：連續的非空白、非 CJK 字元合成一個原子 → 換行不會切進單字中間。
    - **空白成串**：只是換行機會本身，換到下一行時會被丟掉（不帶到行首）。
    - 行首禁則字元（見 NO_BREAK_BEFORE）黏回前一個原子。

    只做合併、不做拆分 → 原子數 ≤ 字元數，這是 cardBudget.ts 上界估算的依據。
    """
    atoms = []  # [(text, cls)]
    for ch in s:
        # 禁則字元黏回前一個原子——但**不能黏到空白原子上**：空白原子在行首會被整個丟掉，
        # 黏上去等於把這個標點一起吞掉（實測 " 。" 曾經整段變成空字串）。
        if atoms and atoms[-1][1] != "space" and ch in NO_BREAK_BEFORE:
            atoms[-1] = (atoms[-1][0] + ch, atoms[-1][1])
            continue
        cls = _atom_class(ch)
        # CJK 永遠自成一個原子；word/space 與同類的前一個原子合併
        if cls != "cjk" and atoms and atoms[-1][1] == cls:
            atoms[-1] = (atoms[-1][0] + ch, cls)
        else:
            atoms.append((ch, cls))
    return atoms


def break_overwide(draw, atom: str, font, max_width: float):
    """單一原子自己就超過可用寬時（超長英文網址、maxWidthFrac 調到極小…）的退路：
    逐字硬切（等同 CSS 的 break-word）。

    為什麼不是「讓它整條溢出」：那正是這次要修的舊行為——文字被畫布邊緣裁掉，
    使用者看不到也收不到警告。硬切至少每個字都看得見。
    **每一段保證至少放一個字元**，所以一定收斂（不會無窮迴圈），
    代價是「單一字元本身就比可用寬還寬」時該行仍會溢出——那已經無解，
    但溢出的只有一個字。
    """
    if draw.textlength(atom, font=font) <= max_width:
        return [atom]
    out, cur = [], ""
    for ch in atom:
        if cur and draw.textlength(cur + ch, font=font) > max_width:
            out.append(cur)
            cur = ch
        else:
            cur += ch
    if cur:
        out.append(cur)
    return out


def wrap_text(draw, text: str, font, max_width: float):
    """沒有 tokens 時的自動換行（貪婪填行）。回傳每一行的字串。

    - 真的 `\\n` 一律強制換行（原本唯一的行為，維持不變）。
    - 段落內依 split_atoms 給的換行機會貪婪填行；量測與繪製用同一套 textlength。
    - 換行點上的空白丟掉（不會讓下一行以空白開頭，也不會讓上一行尾端多一段
      看不見的寬度而害置中偏移）。

    **行數上界**：每一行至少含一個非空白字元，且各行不重複使用同一個字元
    → 行數 ≤ max(1, 段落內字元數)。`server/src/cardBudget.ts` 的預算估算就是靠這條。
    """
    lines = []
    for para in text.split("\n"):
        cur = ""
        emitted = 0
        for atom, cls in split_atoms(para):
            if cls == "space":
                if cur:
                    cur += atom  # 尾端空白先留著，真的換行時再 rstrip 掉
                continue
            for piece in break_overwide(draw, atom, font, max_width):
                if cur and draw.textlength(cur + piece, font=font) > max_width:
                    lines.append(cur.rstrip())
                    emitted += 1
                    cur = ""
                cur += piece
        if cur or emitted == 0:
            lines.append(cur.rstrip())  # 空段落（連續 \n）仍佔一行，與舊行為一致
    return lines


def layout_tokens(draw, tokens, font, max_width):
    """貪婪換行。回傳 [[(token, x, index), ...], ...]，每個內層 list 是一行。

    量測與繪製用同一套 textlength，所以排版和實際輸出必然一致
    （不會有「量一整串」與「逐詞畫」對不上的漂移）。
    """
    lines = []
    cur = []
    cur_w = 0.0
    for i, tok in enumerate(tokens):
        sep = separator(cur[-1][0] if cur else "", tok)
        sep_w = draw.textlength(sep, font=font) if sep else 0.0
        tok_w = draw.textlength(tok, font=font)
        if cur and cur_w + sep_w + tok_w > max_width:
            lines.append(cur)
            cur, cur_w = [], 0.0
            sep_w = 0.0
        cur.append((tok, cur_w + sep_w, i))
        cur_w += sep_w + tok_w
    if cur:
        lines.append(cur)
    return lines


def line_width(draw, line, font) -> float:
    if not line:
        return 0.0
    last_tok, last_x, _ = line[-1]
    return last_x + draw.textlength(last_tok, font=font)


def load_font_by(path, size, cache):
    key = (path, size)
    if key not in cache:
        cache[key] = ImageFont.truetype(path, size) if path else load_font(size)
    return cache[key]


def render_cards(cfg, font_cache):
    """一次排版 → 畫 base(全 fill 色)與 hl(全 highlight 色)兩張,回幾何+逐詞 bbox。"""
    size = int(cfg.get("fontSize", 64))
    fill = cfg.get("fill", "#ffffff")
    stroke = cfg.get("stroke")
    highlight = cfg.get("highlight") or fill
    width = int(cfg.get("width", 1080))
    tokens = cfg.get("tokens") or None
    stroke_w = max(2, size // 16) if stroke else 0
    margin = int(cfg.get("margin", max(32, width // 20)))

    font = load_font_by(cfg.get("fontPath"), size, font_cache)
    tmp = Image.new("RGBA", (1, 1))
    measure = ImageDraw.Draw(tmp)
    line_h = size + max(6, size // 5)

    # 可用寬（換行寬）：兩條路徑共用同一個式子，才不會出現「karaoke 折在這裡、
    # 一般文字折在別的地方」。max(1, ...) 只是防呆：margin 由呼叫端給，
    # width 很小時（下限 16）CLI 的預設 margin 可能大於半個寬。
    max_width = max(1, width - margin * 2)

    if tokens:
        lines = layout_tokens(measure, tokens, font, max_width)
    else:
        # 沒有 tokens 也要換行（以前這裡只有 split("\n")，maxWidth 因此是死欄位，
        # 長文字直接被畫布邊緣裁掉）。
        lines = [[(part, 0.0, -1)] for part in wrap_text(measure, cfg["text"], font, max_width)]

    height = line_h * len(lines) + stroke_w * 2 + 8
    y_start = stroke_w + 4

    boxes = []
    if tokens:
        for li, line in enumerate(lines):
            x0 = (width - line_width(measure, line, font)) / 2
            for tok, dx, idx in line:
                if idx >= 0:
                    boxes.append({
                        "x": round(x0 + dx, 1), "y": y_start + li * line_h,
                        "w": round(measure.textlength(tok, font=font), 1), "h": line_h,
                    })

    def paint(active, out_path):
        img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        y = y_start
        for line in lines:
            x0 = (width - line_width(draw, line, font)) / 2
            for tok, dx, idx in line:
                draw.text((x0 + dx, y), tok, font=font,
                          fill=highlight if (idx >= 0 and idx <= active) else fill,
                          stroke_width=stroke_w, stroke_fill=stroke if stroke else None)
            y += line_h
        img.save(out_path)

    paint(int(cfg.get("activeIndex", -1)), cfg["out"] if "out" in cfg else cfg["outBase"])
    if tokens and cfg.get("outHl"):
        paint(len(tokens) - 1, cfg["outHl"])
    return {"ok": True, "width": width, "height": height, "lines": len(lines),
            "tokens": boxes if tokens else None}


def worker_loop():
    font_cache = {}
    for raw in sys.stdin:
        try:
            req = json.loads(raw)
            if req.get("op") == "probeFont":
                try:
                    ImageFont.truetype(req["path"], 32)
                    print(json.dumps({"ok": True}), flush=True)
                except OSError as e:
                    print(json.dumps({"ok": False, "error": str(e)}), flush=True)
                continue
            print(json.dumps(render_cards(req, font_cache)), flush=True)
        except Exception as e:  # worker 絕不因單一請求死掉
            print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}), flush=True)


def main() -> None:
    if "--worker" in sys.argv:
        worker_loop()
        return
    cfg = json.load(sys.stdin)
    out = render_cards(cfg, {})
    print(json.dumps({"width": out["width"], "height": out["height"], "lines": out["lines"]}))


if __name__ == "__main__":
    main()
