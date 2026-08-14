#!/bin/sh
set -eu

target_root=/opt/media-root
runtime_base=/opt/runtime-base
path_manifest="$target_root/app/FFMPEG_RUNTIME_FILES.txt"
package_list=/tmp/ffmpeg-runtime-packages.txt

mkdir -p "$target_root/app/licenses/ffmpeg-runtime" "$target_root/usr/bin" "$target_root/var/lib/dpkg"
: > "$path_manifest"
: > "$package_list"

record_owner() {
  source_path="$1"
  resolved_path=$(readlink -f "$source_path")
  owner=$(dpkg-query -S "$source_path" 2>/dev/null | head -n 1 | sed 's/: .*//' || true)
  if [ -z "$owner" ]; then
    owner=$(dpkg-query -S "$resolved_path" 2>/dev/null | head -n 1 | sed 's/: .*//' || true)
  fi
  if [ -n "$owner" ]; then printf '%s\n' "$owner" >> "$package_list"; fi
}

copy_runtime_file() {
  source_path="$1"
  if [ -e "$runtime_base$source_path" ]; then return; fi
  destination="$target_root$source_path"
  mkdir -p "$(dirname "$destination")"
  cp -L "$source_path" "$destination"
  chmod --reference="$source_path" "$destination"
  printf '%s\n' "$source_path" >> "$path_manifest"
  record_owner "$source_path"
}

copy_runtime_file /usr/bin/ffmpeg
copy_runtime_file /usr/bin/ffprobe

for library in $(
  ldd /usr/bin/ffmpeg /usr/bin/ffprobe |
    awk '$2 == "=>" && $3 ~ /^\// { print $3 } $1 ~ /^\// && $1 !~ /:$/ { print $1 }' |
    sort -u
); do
  copy_runtime_file "$library"
done

if [ -d /usr/share/ffmpeg ]; then
  mkdir -p "$target_root/usr/share"
  cp -a /usr/share/ffmpeg "$target_root/usr/share/ffmpeg"
  printf '%s\n' /usr/share/ffmpeg >> "$path_manifest"
  record_owner /usr/share/ffmpeg
fi

sort -u "$path_manifest" -o "$path_manifest"
sort -u "$package_list" -o "$package_list"
if [ -f "$runtime_base/var/lib/dpkg/status" ]; then
  cp "$runtime_base/var/lib/dpkg/status" "$target_root/var/lib/dpkg/status"
else
  : > "$target_root/var/lib/dpkg/status"
fi

while IFS= read -r package; do
  [ -n "$package" ] || continue
  dpkg-query -s "$package" >> "$target_root/var/lib/dpkg/status"
  printf '\n' >> "$target_root/var/lib/dpkg/status"
  package_name=${package%%:*}
  copyright_file="/usr/share/doc/$package_name/copyright"
  if [ -f "$copyright_file" ]; then
    destination="$target_root/app/licenses/ffmpeg-runtime/$package_name.copyright"
    cp "$copyright_file" "$destination"
  fi
done < "$package_list"

cp "$package_list" "$target_root/app/FFMPEG_RUNTIME_PACKAGES.txt"
