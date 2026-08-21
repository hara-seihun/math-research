#!/usr/bin/env bash
# Regenerate site/assets/stix-two-math-subset.woff2 from the STIX Two Math
# package in nixpkgs.
#
# Why the site ships a font at all: pandoc renders mathematics as MathML, and
# browsers draw an italic variable by mapping it into the Mathematical
# Alphanumeric Symbols block (U+1D400-U+1D7FF). Most system font stacks have no
# glyphs there, so a reader without a math font installed sees a row of tofu
# boxes where the variables should be -- which is every Linux reader with a
# default font set, and was exactly what the first rendered paper looked like.
# STIX Two Math is the reference font for MathML and carries the OpenType MATH
# table that positions fractions, radicals and stretchy delimiters.
#
# The whole face is 838 KB and covers scripts this site will never set, so it
# is subsetted to the ranges mathematics actually uses. style.css applies it
# only inside <math>, so the file is fetched only by a reader who opens
# something containing mathematics, and never by the results list.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=site/assets/stix-two-math-subset.woff2

# Ranges: ASCII and Latin-1 (numbers and upright text inside formulas),
# combining marks and Greek, punctuation and sub/superscripts, letterlike
# symbols and number forms (ℝ, ℵ, ½), arrows, the four mathematical operator
# blocks, geometric shapes and misc technical (stretchy delimiters), and the
# mathematical alphanumerics that are the whole reason this exists.
RANGES='U+0020-007E,U+00A0-00FF,U+0131,U+0237,U+0300-036F,U+0370-03FF,U+2000-206F,U+2070-209F,U+20D0-20FF,U+2100-214F,U+2150-218F,U+2190-21FF,U+2200-22FF,U+2300-23FF,U+25A0-25FF,U+2600-26FF,U+27C0-27EF,U+27F0-27FF,U+2900-297F,U+2980-29FF,U+2A00-2AFF,U+2B00-2BFF,U+1D400-1D7FF'

SOURCE=$(nix-build '<nixpkgs>' -A stix-two --no-out-link)/share/fonts/opentype/STIXTwoMath-Regular.otf
[[ -f $SOURCE ]] || { echo "STIX Two Math not found at $SOURCE" >&2; exit 1; }

# pyftsubset needs brotli to write woff2, and the system fonttools is built
# without it, so the tool comes from an explicit environment rather than PATH.
nix shell --impure --expr 'let p = import <nixpkgs> {}; in p.python3.withPackages (ps: [ ps.fonttools ps.brotli ])' \
  --command pyftsubset "$SOURCE" \
  --output-file="$OUT" --flavor=woff2 \
  --layout-features='*' --no-hinting --desubroutinize \
  --unicodes="$RANGES"

# A subset that lost the MATH table would still render glyphs and would space
# every formula wrongly, which is harder to notice than tofu.
nix shell --impure --expr 'let p = import <nixpkgs> {}; in p.python3.withPackages (ps: [ ps.fonttools ps.brotli ])' \
  --command python3 -c "
from fontTools.ttLib import TTFont
f = TTFont('$OUT')
assert 'MATH' in f, 'the subset dropped the OpenType MATH table'
cmap = f.getBestCmap()
for cp in (0x1D461, 0x1D6EC, 0x211D, 0x222B, 0x2264):
    assert cp in cmap, f'the subset dropped {chr(cp)!r}'
print(f'{len(f.getGlyphOrder())} glyphs, MATH table intact')
"

echo "wrote $OUT ($(stat -c %s "$OUT") bytes)"
