#!/usr/bin/env python3
"""生成扩展图标（紫→青渐变圆角方块 + 白色地球/箭头符号）。
用法：python3 tools/make_icons.py
"""
from PIL import Image, ImageDraw

SIZES = [16, 32, 48, 128]
SS = 8  # 超采样倍数

C1 = (99, 102, 241)   # indigo
C2 = (34, 211, 238)   # cyan


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def make(size):
    S = size * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 渐变背景
    grad = Image.new("RGBA", (S, S))
    gd = ImageDraw.Draw(grad)
    for y in range(S):
        gd.line([(0, y), (S, y)], fill=lerp(C1, C2, y / max(1, S - 1)) + (255,))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.26), fill=255)
    img.paste(grad, (0, 0), mask)

    # 白色地球
    pad = S * 0.2
    box = [pad, pad, S - pad, S - pad]
    w = max(1, int(S * 0.055))
    d.ellipse(box, outline=(255, 255, 255, 255), width=w)
    # 赤道
    d.line([pad, S / 2, S - pad, S / 2], fill=(255, 255, 255, 230), width=int(w * 0.8))
    # 经线（椭圆）
    d.ellipse([S * 0.36, pad, S * 0.64, S - pad], outline=(255, 255, 255, 210), width=int(w * 0.7))
    # 中间的小箭头（表示「翻译」）
    d.line([S * 0.5, S * 0.33, S * 0.5, S * 0.67], fill=(255, 255, 255, 0), width=0)
    ax = S * 0.30
    ay = S * 0.5
    d.polygon(
        [(ax + S * 0.09, ay - S * 0.045), (ax + S * 0.20, ay), (ax + S * 0.09, ay + S * 0.045)],
        fill=(255, 255, 255, 255),
    )
    d.line([ax, ay, ax + S * 0.16, ay], fill=(255, 255, 255, 255), width=int(w * 0.9))

    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    import os

    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
    os.makedirs(out, exist_ok=True)
    for s in SIZES:
        make(s).save(os.path.join(out, f"icon-{s}.png"))
        print(f"icons/icon-{s}.png")
