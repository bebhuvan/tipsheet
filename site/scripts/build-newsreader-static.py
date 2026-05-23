#!/usr/bin/env python3
"""
Generate static, weight-pinned Newsreader woff2 subsets for the CLIENT critical path.

Why: the Google-hosted Newsreader files we self-host are *variable* fonts spanning the
full weight axis (200-800). The Latin subsets are ~132KB (roman) / ~147KB (italic) each,
and the headline (the LCP element) waits on them. Pinning the weight axis to the specific
weights the CSS actually uses cuts each file to ~20-60KB while KEEPING the optical-size
(opsz) axis variable, so `font-optical-sizing: auto` still refines large headlines — i.e.
no visual regression.

We deliberately do NOT touch the original variable woff2 files: src/lib/og.mjs embeds them
at build time to render OG images at weights 300/450/500, and needs the live weight axis.
Those files never reach the article critical path, so their size is irrelevant there.

Run from site/:  python3 scripts/build-newsreader-static.py
Outputs land in public/fonts/ as newsreader[-italic]-<wght>-<subset>.woff2 and are committed.
"""
import io, os
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

FONTS = os.path.join(os.path.dirname(__file__), "..", "public", "fonts")

# Source variable subsets (Google's split). We ship latin + latin-ext to the client
# (latin-ext carries ₹ U+20B9, which appears in nearly every headline). Vietnamese is
# dropped — it never occurs in India-English copy.
SOURCES = {
    "normal": {
        "latin":    "cY9AfjOCX1hbuyalUrK4397yjA.woff2",
        "latinext": "cY9AfjOCX1hbuyalUrK439DyjJBG.woff2",
    },
    "italic": {
        "latin":    "cY9CfjOCX1hbuyalUrK439vCjohC.woff2",
        "latinext": "cY9CfjOCX1hbuyalUrK439vCgIhCFpY.woff2",
    },
}

# Weights the CSS actually uses (see src/styles/global.css). Roman 200 & 600 appear once
# each; italic stays in the 300-500 editorial range.
WEIGHTS = {
    "normal": [200, 300, 400, 500, 600],
    "italic": [300, 400, 500],
}

def out_name(style, wght, subset):
    tag = "newsreader-italic" if style == "italic" else "newsreader"
    return f"{tag}-{wght}-{subset}.woff2"

def main():
    total_in = total_out = 0
    seen = set()
    for style, subsets in SOURCES.items():
        for subset, src in subsets.items():
            src_path = os.path.join(FONTS, src)
            sz_in = os.path.getsize(src_path)
            if src not in seen:
                total_in += sz_in
                seen.add(src)
            for wght in WEIGHTS[style]:
                f = TTFont(src_path)
                # Pin weight only; leave opsz variable so optical sizing still works.
                inst = instancer.instantiateVariableFont(f, {"wght": wght}, inplace=False)
                inst.flavor = "woff2"
                buf = io.BytesIO(); inst.save(buf); data = buf.getvalue()
                out = os.path.join(FONTS, out_name(style, wght, subset))
                with open(out, "wb") as fh:
                    fh.write(data)
                total_out += len(data)
                print(f"  {out_name(style, wght, subset):42s} {len(data):>7,d} B")
    print(f"\nsource variable subsets (kept for OG): {total_in:,} B")
    print(f"generated static subsets:              {total_out:,} B")

if __name__ == "__main__":
    main()
