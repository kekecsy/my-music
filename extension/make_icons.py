#!/usr/bin/env python3
"""local music · 浏览器扩展图标生成（源自 icons/cover.png）

用法：
    python3 make_icons.py                # 写入 icons/，覆盖 icon16/32/48/128.png
    python3 make_icons.py /tmp/icon-prev # 只输出到别处预览，不动正式图标

依赖：pillow、numpy

为什么不能简单裁剪：
  1. 原图 1254x1254，图形只占中间约 1021x1000，四周是黑边 → 要裁
  2. 图形是 iOS 风格的「超椭圆」圆角，不是标准圆角矩形（两个方向量出的
     切点距离分别是 259 / 237，套圆角公式贴不准）→ 改用像素亮度判定背景
  3. 圆角外的黑色必须在缩放到小尺寸之前处理掉：透明区域的 RGB 若留着黑色，
     LANCZOS 插值时会把它混进图形边缘，形成一圈「黑边」
     → 先把背景色向图形外侧扩散若干像素，再做缩放
"""

import sys
import pathlib

import numpy as np
from PIL import Image, ImageFilter

HERE = pathlib.Path(__file__).resolve().parent
SRC = HERE / "icons" / "cover.png"
SIZES = (16, 32, 48, 128)
DARK = 12      # 亮度阈值：不超过它 → 候选背景（实测背景为纯黑 0，内部最暗元素 25+）
BLEED = 48     # 背景颜色向外扩散的像素数（覆盖最小尺寸 16px 的插值采样半径）


def main():
    out_dir = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else HERE / "icons"
    out_dir.mkdir(parents=True, exist_ok=True)

    im = Image.open(SRC).convert("RGB")
    a = np.asarray(im).astype(np.float32)
    lum = 0.299 * a[:, :, 0] + 0.587 * a[:, :, 1] + 0.114 * a[:, :, 2]
    H, W = lum.shape

    # ---------- 1. 定位图形，裁成正方形 ----------
    ys, xs = np.where(lum > DARK)
    x0, x1, y0, y1 = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    side = max(x1 - x0, y1 - y0) + 1
    half = side / 2
    bx0, by0 = max(0, round(cx - half)), max(0, round(cy - half))
    bx1, by1 = min(W, bx0 + side), min(H, by0 + side)
    print(f"图形 bbox x[{x0},{x1}] y[{y0},{y1}]  ({x1 - x0 + 1}x{y1 - y0 + 1})")
    print(f"裁剪为正方形 ({bx0},{by0}) → ({bx1},{by1})  {side}x{side}")

    canvas = im.crop((bx0, by0, bx1, by1))
    ca = np.asarray(canvas).astype(np.float32)
    clum = 0.299 * ca[:, :, 0] + 0.587 * ca[:, :, 1] + 0.114 * ca[:, :, 2]

    # ---------- 2. 连通性判定背景 ----------
    # 不能只按亮度判定：圆角外的黑色与图形内部可能存在的深色元素亮度接近，
    # 只看亮度会在图形上开洞。改成「与画面四边连通的暗像素才算背景」。
    cand = clum <= DARK
    reach = np.zeros_like(cand)
    reach[0, :] = cand[0, :]
    reach[-1, :] = cand[-1, :]
    reach[:, 0] = cand[:, 0]
    reach[:, -1] = cand[:, -1]
    steps = 0
    for steps in range(1, 800):
        grown = reach.copy()
        grown[1:, :] |= reach[:-1, :]
        grown[:-1, :] |= reach[1:, :]
        grown[:, 1:] |= reach[:, :-1]
        grown[:, :-1] |= reach[:, 1:]
        grown &= cand
        if grown.sum() == reach.sum():
            break
        reach = grown
    bg = reach
    ratio = bg.mean() * 100
    print(f"背景（与画面外连通）占 {ratio:.2f}%，{steps} 轮收敛")
    # 独立佐证：裁剪后图形几乎铺满画布，背景只剩「四个圆角外面」+「上下各约 10px
    # 的透明边」，几何估算约 6%~9%。明显偏大 = 漏进图形内部；明显偏小 = 没传播开。
    if not 5 <= ratio <= 12:
        raise SystemExit(f"✗ 背景占比 {ratio:.2f}% 异常，需要人工核查")

    # ---------- 3. 抠图：背景透明，边缘轻微柔化 ----------
    alpha = Image.fromarray(np.where(bg, 0, 255).astype(np.uint8), "L")
    alpha = alpha.filter(ImageFilter.GaussianBlur(0.7))
    alpha_np = np.asarray(alpha).astype(np.float32)
    print(f"全透明 {(alpha_np < 8).mean() * 100:.1f}% / 全不透明 {(alpha_np > 247).mean() * 100:.1f}%")

    # ---------- 4. 颜色扩散：把背景区域涂成邻近的图形颜色 ----------
    rgb = ca.copy()
    known = alpha_np > 0
    rounds = 0
    for rounds in range(1, BLEED + 1):
        todo = ~known
        if not todo.any():
            break
        acc = np.zeros_like(rgb)
        cnt = np.zeros(known.shape, np.float32)
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            sr = np.roll(rgb, (dy, dx), (0, 1))
            sk = np.roll(known, (dy, dx), (0, 1))
            acc += sr * sk[..., None]
            cnt += sk
        fill = todo & (cnt > 0)
        rgb[fill] = acc[fill] / cnt[fill][..., None]
        known |= fill
    print(f"颜色扩散 {rounds} 轮，{'已铺满' if known.all() else '仍有残留（不影响，远离图形）'}")

    frame = np.dstack([np.clip(rgb, 0, 255), alpha_np]).astype(np.uint8)
    base = Image.fromarray(frame, "RGBA")
    if out_dir != HERE / "icons":          # 预览模式才留中间产物，正式目录保持干净
        base.save(out_dir / "cover-cropped.png")

    # ---------- 5. 输出各尺寸 ----------
    for s in SIZES:
        px = base.resize((s, s), Image.Resampling.LANCZOS)
        # 16/32 在工具栏里显示的细节会糊成一团，做一次轻度锐化找回轮廓
        # （只锐化 RGB、alpha 原样保留，否则透明边缘会被锐化出硬边/暗边）
        if s <= 32:
            px = sharpen_rgb(px, radius=0.8, percent=100)
        px.save(out_dir / f"icon{s}.png")
        print(f"  ✓ icon{s}.png")
    print(f"\n输出目录：{out_dir}")


def sharpen_rgb(img, radius, percent):
    r, g, b, a = img.split()
    rgb = Image.merge("RGB", (r, g, b)).filter(
        ImageFilter.UnsharpMask(radius=radius, percent=percent, threshold=2)
    )
    return Image.merge("RGBA", (*rgb.split(), a))


if __name__ == "__main__":
    main()
