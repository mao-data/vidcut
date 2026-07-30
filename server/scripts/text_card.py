#!/usr/bin/env python3
"""文字 → 透明 PNG 字卡（給 vidcut render 的 caption 用，繞過 ffmpeg 無 drawtext）。

用法：讀 stdin 的 JSON：
  {"out": "...png", "text": "字幕", "fontSize": 64, "fill": "#ffffff",
   "stroke": "#000000"|null, "width": 1080}

逐詞高亮（karaoke）時額外給：
  {"tokens": ["這","隻","貓"], "activeIndex": 1, "highlight": "#FCDE5A"}
activeIndex 及其之前的詞用 highlight 色，之後用 fill 色。排版對同一組 tokens
是確定性的（只有顏色隨 activeIndex 變），所以 N 張卡幾何完全對齊，
播起來就像同一張圖在變色。

產出：寬 = width、高 = 依字級與行數自動、透明底、水平置中、可選描邊的 PNG。
與 make_overlays.py 同路子（Pillow）。跨機器不依賴 ffmpeg 字型支援。
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


def main() -> None:
    cfg = json.load(sys.stdin)
    size = int(cfg.get("fontSize", 64))
    fill = cfg.get("fill", "#ffffff")
    stroke = cfg.get("stroke")
    highlight = cfg.get("highlight") or fill
    width = int(cfg.get("width", 1080))
    tokens = cfg.get("tokens") or None
    active = int(cfg.get("activeIndex", -1))
    stroke_w = max(2, size // 16) if stroke else 0
    # 左右留白：避免長句貼邊
    margin = int(cfg.get("margin", max(32, width // 20)))

    font = load_font(size)
    tmp = Image.new("RGBA", (1, 1))
    measure = ImageDraw.Draw(tmp)
    line_h = size + max(6, size // 5)

    if tokens:
        lines = layout_tokens(measure, tokens, font, width - margin * 2)
    else:
        # 無 tokens：沿用原本的整行模式（顯式換行由 \n 決定）
        lines = [[(part, 0.0, -1)] for part in cfg["text"].split("\n")]

    height = line_h * len(lines) + stroke_w * 2 + 8
    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    y = stroke_w + 4
    for line in lines:
        x0 = (width - line_width(draw, line, font)) / 2
        for tok, dx, idx in line:
            draw.text(
                (x0 + dx, y),
                tok,
                font=font,
                fill=highlight if (idx >= 0 and idx <= active) else fill,
                stroke_width=stroke_w,
                stroke_fill=stroke if stroke else None,
            )
        y += line_h

    img.save(cfg["out"])
    # 回報實際尺寸給呼叫端
    print(json.dumps({"width": width, "height": height, "lines": len(lines)}))


if __name__ == "__main__":
    main()
