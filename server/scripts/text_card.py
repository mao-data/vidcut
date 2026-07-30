#!/usr/bin/env python3
"""文字 → 透明 PNG 字卡（給 vidcut render 的 caption 用，繞過 ffmpeg 無 drawtext）。

用法：讀 stdin 的 JSON：
  {"out": "...png", "text": "字幕", "fontSize": 64, "fill": "#ffffff",
   "stroke": "#000000"|null, "width": 1080}
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


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default()


def main() -> None:
    cfg = json.load(sys.stdin)
    text = cfg["text"]
    size = int(cfg.get("fontSize", 64))
    fill = cfg.get("fill", "#ffffff")
    stroke = cfg.get("stroke")
    width = int(cfg.get("width", 1080))
    stroke_w = max(2, size // 16) if stroke else 0

    font = load_font(size)
    lines = text.split("\n")

    # 量測：用臨時 draw 取每行寬高
    tmp = Image.new("RGBA", (1, 1))
    d = ImageDraw.Draw(tmp)
    line_h = size + max(6, size // 5)
    height = line_h * len(lines) + stroke_w * 2 + 8

    img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    y = stroke_w + 4
    for line in lines:
        bbox = draw.textbbox((0, 0), line, font=font, stroke_width=stroke_w)
        lw = bbox[2] - bbox[0]
        x = (width - lw) // 2
        draw.text(
            (x, y),
            line,
            font=font,
            fill=fill,
            stroke_width=stroke_w,
            stroke_fill=stroke if stroke else None,
        )
        y += line_h

    img.save(cfg["out"])
    # 回報實際尺寸給呼叫端
    print(json.dumps({"width": width, "height": height}))


if __name__ == "__main__":
    main()
