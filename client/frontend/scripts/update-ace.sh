#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
package_dir=$(cd -- "$root" && node -p "require('path').dirname(require.resolve('ace-builds/package.json'))")
source_dir="$package_dir/src-min-noconflict"
destination_dir="$root/public/js/ace"

[[ -d "$package_dir" && ! -L "$package_dir" ]]
[[ -d "$source_dir" && ! -L "$source_dir" ]]
[[ -d "$destination_dir" && ! -L "$destination_dir" ]]

while IFS= read -r -d '' path; do
  relative=${path#"$destination_dir"/}
  [[ "$relative" != LICENSE ]]
  source="$source_dir/$relative"
  [[ -f "$source" && ! -L "$source" ]]
  cp -- "$source" "$path"
done < <(find "$destination_dir" -type f ! -name LICENSE -print0)

cp -- "$package_dir/LICENSE" "$destination_dir/LICENSE"
