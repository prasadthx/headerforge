#!/usr/bin/env python3
"""Generate HeaderForge PNG icons with no third-party dependencies.

Draws a rounded-square with a diagonal indigo->purple gradient and three white
"header line" bars, rendered at 4x and downsampled (premultiplied alpha) for
smooth edges. Run:  python3 tools/gen-icons.py
"""
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
SIZES = [16, 48, 128]
SS = 4  # supersampling factor

# Gradient endpoints (top-left -> bottom-right).
C0 = (99, 102, 241)   # indigo-500  #6366f1
C1 = (168, 85, 247)   # purple-500  #a855f7

# Three white bars, in normalized 0..1 icon coordinates: (x0, x1, y_center).
BAR_H = 0.09
BARS = [
    (0.28, 0.72, 0.34),
    (0.28, 0.66, 0.50),
    (0.28, 0.60, 0.66),
]


def lerp(a, b, t):
    return a + (b - a) * t


def in_round_rect(x, y, x0, y0, x1, y1, r):
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    dx, dy = x - cx, y - cy
    return dx * dx + dy * dy <= r * r


def render(size):
    S = size * SS
    # radius of the outer rounded square and the bars.
    rect_r = S * 0.22
    bar_r = (BAR_H * S) / 2.0
    margin = S * 0.06
    x0, y0, x1, y1 = margin, margin, S - margin, S - margin

    # Hi-res premultiplied accumulation happens during downsample; here we just
    # produce a straight-alpha hi-res buffer as (r, g, b, a) per pixel.
    hi = bytearray(S * S * 4)
    for py in range(S):
        for px in range(S):
            idx = (py * S + px) * 4
            if not in_round_rect(px + 0.5, py + 0.5, x0, y0, x1, y1, rect_r):
                continue  # transparent
            # Gradient color.
            t = (px + py) / (2.0 * (S - 1))
            r = int(round(lerp(C0[0], C1[0], t)))
            g = int(round(lerp(C0[1], C1[1], t)))
            b = int(round(lerp(C0[2], C1[2], t)))
            a = 255
            # White bars on top.
            for (bx0, bx1, bcy) in BARS:
                rx0, rx1 = bx0 * S, bx1 * S
                rcy = bcy * S
                if in_round_rect(
                    px + 0.5, py + 0.5,
                    rx0, rcy - bar_r, rx1, rcy + bar_r, bar_r,
                ):
                    r = g = b = 255
                    break
            hi[idx:idx + 4] = bytes((r, g, b, a))

    # Downsample with premultiplied alpha to avoid dark edge fringes.
    out = bytearray(size * size * 4)
    for oy in range(size):
        for ox in range(size):
            pr = pg = pb = pa = 0
            for sy in range(SS):
                for sx in range(SS):
                    sidx = (((oy * SS + sy) * S) + (ox * SS + sx)) * 4
                    a = hi[sidx + 3]
                    pr += hi[sidx] * a
                    pg += hi[sidx + 1] * a
                    pb += hi[sidx + 2] * a
                    pa += a
            n = SS * SS
            out_a = pa // n
            if pa > 0:
                out_r = min(255, pr // pa)
                out_g = min(255, pg // pa)
                out_b = min(255, pb // pa)
            else:
                out_r = out_g = out_b = 0
            oidx = (oy * size + ox) * 4
            out[oidx:oidx + 4] = bytes((out_r, out_g, out_b, out_a))
    return out


def write_png(path, size, rgba):
    def chunk(typ, data):
        return (
            struct.pack(">I", len(data))
            + typ
            + data
            + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)
        )

    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter type: none
        raw.extend(rgba[y * size * 4:(y + 1) * size * 4])
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(png)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        rgba = render(size)
        path = os.path.join(OUT_DIR, f"icon{size}.png")
        write_png(path, size, rgba)
        print(f"wrote {path} ({size}x{size})")


if __name__ == "__main__":
    main()
