#!/bin/sh
# Damsko's Backdrop scenes load their pictures from your app's /backdrops/ folder. This puts them
# there: each scene's picture and its small one for a preview tile, from the Damsko site. It lands
# beside Backdrop when you add it; run it from your app's root, once:
#
#   sh <your components folder>/grasp/backdrop/pictures.sh                into public/backdrops/
#   sh <your components folder>/grasp/backdrop/pictures.sh --to static/backdrops
#   sh <your components folder>/grasp/backdrop/pictures.sh --from https://another.host/backdrops/
#
# Offline, or if it fails: copy public/backdrops/ from the Damsko repository (grasplabs/ui) into
# your app's public/backdrops/ by hand. It stops with exit code 1 and says which files are missing.
from="https://damsko.joingrasp.com/backdrops/"
to="public/backdrops"
while [ $# -gt 0 ]; do
  case "$1" in
    --from) from="$2"; shift 2 ;;
    --to) to="$2"; shift 2 ;;
    *) echo "Unknown option: $1 (use --from <address> or --to <folder>)" >&2; exit 2 ;;
  esac
done
case "$from" in */) ;; *) from="$from/" ;; esac

if ! command -v curl >/dev/null 2>&1; then
  echo "Backdrop pictures: curl is not installed. Copy public/backdrops/ from the Damsko repository (grasplabs/ui) into $to/ by hand." >&2
  exit 1
fi

mkdir -p "$to"
missing=""
count=0
for scene in cliffs wave aurora starry fuji wanderer; do
  for file in "$scene.jpg" "$scene.small.jpg"; do
    count=$((count + 1))
    type=$(curl -fsSL -o "$to/$file.part" -w '%{content_type}' "$from$file" 2>/dev/null)
    case "$?:$type" in
      0:image/*) mv "$to/$file.part" "$to/$file" && echo "wrote $to/$file" ;;
      *) rm -f "$to/$file.part"; missing="$missing $file" ;;
    esac
  done
done

if [ -n "$missing" ]; then
  {
    echo ""
    echo "Backdrop pictures: some of $count could not be fetched from $from"
    for file in $missing; do echo "  missing: $file"; done
    echo ""
    echo "Copy them by hand: public/backdrops/ from the Damsko repository (grasplabs/ui) into $to/."
    echo "Until then the scenes draw nothing; the rest of Backdrop works."
  } >&2
  exit 1
fi
echo "Backdrop pictures: all $count in $to/"
