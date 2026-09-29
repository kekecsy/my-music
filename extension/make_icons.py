# -*- coding: utf-8 -*-
"""生成插件图标（B站粉圆角方块 + 白色心形）。

不依赖任何图像库：4 倍超采样 + 纯 Python 写 PNG。
用法：python3 make_icons.py
"""
import math
import os
import struct
import zlib

C1 = (251, 114, 153)   # B 站粉
C2 = (214, 51, 118)    # 渐变的深端

# 心形缩放/位移：让心形在图标里居中且留出合理边距
HS, HC = 0.268, -0.106


def heart_inside(u, v):
    """隐式心形方程 (x^2+y^2-1)^3 - x^2*y^3 <= 0"""
    x = (u - 0.5) / HS
    y = (0.5 - v) / HS + HC
    a = x * x + y * y - 1.0
    return a * a * a - x * x * y * y * y <= 0.0


def rounded_inside(u, v, r=0.225):
    cx = min(max(u, r), 1.0 - r)
    cy = min(max(v, r), 1.0 - r)
    dx, dy = u - cx, v - cy
    return dx * dx + dy * dy <= r * r


def render(size, ss=4):
    """返回 size×size 的 RGBA 行列表"""
    n = size * ss
    rows = []
    for py in range(size):
        row = []
        for px in range(size):
            r = g = b = 0.0
            hit = 0
            for sy in range(ss):
                for sx in range(ss):
                    u = (px * ss + sx + 0.5) / n
                    v = (py * ss + sy + 0.5) / n
                    if not rounded_inside(u, v):
                        continue
                    hit += 1
                    if heart_inside(u, v):
                        r += 255.0
                        g += 255.0
                        b += 255.0
                    else:
                        t = u * 0.72 + v * 0.28
                        r += C1[0] + (C2[0] - C1[0]) * t
                        g += C1[1] + (C2[1] - C1[1]) * t
                        b += C1[2] + (C2[2] - C1[2]) * t
            k = ss * ss
            if hit == 0:
                row.append((0, 0, 0, 0))
                continue
            # 非预乘：颜色取被覆盖样本的均值，alpha 取覆盖率
            row.append((round(r / hit), round(g / hit), round(b / hit),
                        round(255.0 * hit / k)))
        rows.append(row)
    return rows


def write_png(path, rows):
    size = len(rows)
    raw = bytearray()
    for row in rows:
        raw.append(0)
        for px in row:
            raw += bytes(px)

    def chunk(typ, data):
        body = typ + data
        return (struct.pack(">I", len(data)) + body
                + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF))

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)
    return len(png)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.join(here, "icons")
    os.makedirs(out, exist_ok=True)
    for size in (16, 32, 48, 128):
        path = os.path.join(out, f"icon{size}.png")
        n = write_png(path, render(size))
        print(f"{path}  {size}x{size}  {n} bytes")


if __name__ == "__main__":
    main()
