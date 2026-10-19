# Casalaggiù · crea img/*.webp da img/*.jpg (stesso nome): più leggere per il sito.
# Lanciato da .github/workflows/build.yml. Le .jpg restano (anteprime social, email).
# Foto grandi: lato lungo max 1600 px, qualità 75. Miniature (-t): qualità 72.
import sys, pathlib
from PIL import Image, ImageOps

root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")
tot_j = tot_w = 0
for j in sorted((root / "img").glob("*.jpg")):
    w = j.with_suffix(".webp")
    im = ImageOps.exif_transpose(Image.open(j)).convert("RGB")
    thumb = j.stem.endswith("-t")
    if not thumb and max(im.size) > 1600:
        im.thumbnail((1600, 1600), Image.LANCZOS)
    im.save(w, "WEBP", quality=72 if thumb else 75, method=6)
    tot_j += j.stat().st_size
    tot_w += w.stat().st_size
print(f"jpg {tot_j/1e6:.2f} MB -> webp {tot_w/1e6:.2f} MB")
