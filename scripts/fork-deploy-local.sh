#!/usr/bin/env bash
# Deploy a local build of this checkout, without a release. See docs/fork/operations.md
# "Update and install".
# Usage:
#   scripts/fork-deploy-local.sh <ssh-host>                         server: build, install, switch
#   scripts/fork-deploy-local.sh --archive <linux-x64|linux-arm64>  server: build the archive only
#   scripts/fork-deploy-local.sh --mac                              Mac app: build the signed zip only
#   scripts/fork-deploy-local.sh --mac --install                    Mac app: build and replace the app
#   scripts/fork-deploy-local.sh --mac --publish                    Mac app: build and publish a prerelease
# The build and the version rule are the same for both programs. Only the last step differs: the
# server switches with `t3 update <version> --yes`, and the Mac app replaces /Applications.
set -euo pipefail

readonly FORK_REPOSITORY="Yarden-zamir/t3code"
readonly SIGN_IDENTITY="Yarden Zamir T3 Fork"
# Files that decide the native packages in the server archive. A local change to one of them needs
# a release, because the archive keeps the native packages of the release.
readonly NATIVE_INPUTS=(apps/server/package.json pnpm-workspace.yaml pnpm-lock.yaml patches)

usage() {
  echo "Usage: $0 <ssh-host> | --archive <linux-x64|linux-arm64> | --mac [--install | --publish]" >&2
  exit 2
}

target=""
host=""
platform=""
mac_step=build
case "${1:-}" in
  --archive)
    target=server
    platform="${2:-}"
    [[ "$platform" == linux-x64 || "$platform" == linux-arm64 ]] || usage
    ;;
  --mac)
    target=mac
    case "${2:-}" in
      "") ;;
      --install) mac_step=install ;;
      --publish) mac_step=publish ;;
      *) usage ;;
    esac
    ;;
  "" | -*) usage ;;
  *)
    target=server
    host="$1"
    ;;
esac

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"
export PATH="$repo_root/node_modules/.bin:$PATH"
sha="$(git rev-parse HEAD)"

# The fork releases from CI, highest build number first. The list order is not the build order:
# the daily release moves to the top. Local releases end with "(local)" and do not count.
ci_releases="$(gh api "repos/$FORK_REPOSITORY/releases?per_page=50" \
  --jq '[.[] | select(.draft | not) | select(.name | endswith("(local)") | not)
        | {tag: .tag_name, name: .name, sums: any(.assets[]; .name == "SHA256SUMS"),
           number: (.tag_name | split(".") | last | tonumber)}] | sort_by(-.number)')"
# Prints one field of the first release: of any release, or of one with SHA256SUMS.
ci_field() {
  node -p 'const [json, which, field] = process.argv.slice(1);
    JSON.parse(json).find((release) => which === "any" || release.sums)?.[field] ?? ""' \
    "$ci_releases" "$1" "$2"
}

# Versions: the newest CI number plus the minute of the UTC day (1 to 1440). The version sorts
# above the CI release it follows and below the next one, so the next CI release replaces it.
ci_number="$(ci_field any number)"
[[ "$ci_number" =~ ^[0-9]+$ ]] || { echo "Could not read the newest CI build number." >&2; exit 1; }
minute_of_day=$((10#$(date -u +%H) * 60 + 10#$(date -u +%M) + 1))
version="$(node scripts/resolve-nightly-release.ts \
  --date "$(date -u +%Y%m%d)" --run-number "$((ci_number + minute_of_day))" --sha "$sha" |
  sed -n 's/^version=//p')"
[[ -n "$version" ]] || { echo "Could not resolve the build version." >&2; exit 1; }

# Mac app ----------------------------------------------------------------------------------------

build_mac() {
  if ! security find-identity -v -p codesigning | grep -q "\"$SIGN_IDENTITY\""; then
    echo "No trusted code signing identity \"$SIGN_IDENTITY\" in the keychain. See docs/fork/operations.md." >&2
    exit 1
  fi
  if [[ "$mac_step" == publish ]] && ! git branch -r --contains "$sha" | grep -q "origin/"; then
    echo "Push $sha to origin before you publish, so the release tag points at a public commit." >&2
    exit 1
  fi
  rm -rf release
  T3CODE_DESKTOP_UPDATE_REPOSITORY="$FORK_REPOSITORY" \
    T3CODE_DESKTOP_MAC_SELF_SIGNED=true \
    CSC_NAME="$SIGN_IDENTITY" \
    vp run dist:desktop:artifact \
    --platform mac --target zip --arch arm64 --build-version "$version" --signed --verbose
  # The build keeps only the zip, so check the app inside it.
  verify_dir="$(mktemp -d)"
  ditto -x -k release/*-arm64.zip "$verify_dir"
  codesign --verify --deep --strict "$verify_dir"/*.app
  echo "Built $version in $repo_root/release"
}

# The last step of the Mac app: replace the app in /Applications and start it.
install_mac() {
  local app_name installed backup
  app_name="$(basename "$verify_dir"/*.app)"
  installed="/Applications/$app_name"
  # One backup only: the previous install. Older backups are not kept.
  backup="$repo_root/../_shared/backup/$app_name"
  mkdir -p "$(dirname "$backup")"
  # Drop an update the old app downloaded; macOS installs it on quit otherwise, so clear it before the quit.
  rm -rf "$HOME/Library/Caches/t3code-updater" "$HOME/Library/Caches/com.t3tools.t3code.ShipIt"
  osascript -e "quit app \"${app_name%.app}\"" || true
  # Fixed-string match: pgrep -f reads "(Nightly)" in the path as a regex group.
  running() { ps -axo command= | grep -qF "$installed/Contents/MacOS/"; }
  for _ in $(seq 1 30); do running || break; sleep 1; done
  if running; then
    echo "$app_name did not quit; the install stopped." >&2
    exit 1
  fi
  rm -rf "$backup"
  [[ -d "$installed" ]] && mv "$installed" "$backup"
  mv "$verify_dir/$app_name" "$installed"
  open "$installed"
  echo "Installed $version to $installed"
}

publish_mac() {
  shopt -s nullglob
  local assets=(release/*.zip release/*.blockmap release/nightly-mac.yml)
  if [[ ! -f release/nightly-mac.yml ]]; then
    echo "release/nightly-mac.yml is missing; the updater cannot find this build." >&2
    exit 1
  fi
  gh release create "v$version" "${assets[@]}" \
    --repo "$FORK_REPOSITORY" \
    --target "$sha" \
    --title "T3 Code Fork v$version (local)" \
    --notes "Local fork build from $sha." \
    --prerelease
}

if [[ "$target" == mac ]]; then
  build_mac
  case "$mac_step" in
    install) install_mac ;;
    publish) publish_mac ;;
  esac
  rm -rf "$verify_dir"
  exit 0
fi

# Server -----------------------------------------------------------------------------------------

if [[ -n "$host" ]]; then
  case "$(ssh "$host" uname -sm)" in
    "Linux x86_64") platform=linux-x64 ;;
    "Linux aarch64") platform=linux-arm64 ;;
    *) echo "$host is not a Linux x64 or arm64 machine." >&2; exit 1 ;;
  esac
fi

# The newest CI release that servers can install: it has SHA256SUMS. Its name ends with
# "(<12-character commit>)".
release_tag="$(ci_field sums tag)"
release_name="$(ci_field sums name)"
[[ -n "$release_tag" ]] || { echo "No fork release has SHA256SUMS." >&2; exit 1; }
release_version="${release_tag#v}"
release_sha="${release_name##*(}"
release_sha="${release_sha%)}"
if [[ ! "$release_sha" =~ ^[0-9a-f]{12}$ ]]; then
  echo "Could not read the commit of release $release_tag from its name \"$release_name\"." >&2
  exit 1
fi
git cat-file -e "$release_sha^{commit}" 2>/dev/null || git fetch --quiet origin main
if ! git diff --quiet "$release_sha" -- "${NATIVE_INPUTS[@]}"; then
  echo "This checkout changes native package inputs since $release_tag (${NATIVE_INPUTS[*]})." >&2
  echo "The archive keeps the native packages of the release, so wait for a release with this change." >&2
  exit 1
fi

work="$(mktemp -d)"
version_backup="$work/package-versions"
mkdir -p "$version_backup"
# Put back the package.json files that carry the version, also after a failure.
restore_versions() {
  local file
  for file in apps/server/package.json apps/desktop/package.json apps/web/package.json packages/contracts/package.json; do
    cp "$version_backup/${file//\//_}" "$file"
  done
  rm -rf "$work"
}
for file in apps/server/package.json apps/desktop/package.json apps/web/package.json packages/contracts/package.json; do
  cp "$file" "$version_backup/${file//\//_}"
done
trap restore_versions EXIT

# `--build-sea` needs an official Node build; Homebrew builds Node without it. Use the Node that
# the executable embeds (the exact engines.node version), as the release workflow does.
sea_node_version="$(node -p 'require("./package.json").engines.node')"
[[ "$sea_node_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "package.json engines.node must be an exact version, got '$sea_node_version'." >&2
  exit 1
}
host_arch="$(uname -m)"
[[ "$host_arch" == x86_64 ]] && host_arch=x64
node_name="node-v$sea_node_version-$(uname -s | tr '[:upper:]' '[:lower:]')-$host_arch"
node_dir="${XDG_CACHE_HOME:-$HOME/.cache}/t3-fork/$node_name"
if [[ ! -x "$node_dir/bin/node" ]]; then
  mkdir -p "$(dirname "$node_dir")"
  curl -fsSL -o "$work/$node_name.tar.gz" "https://nodejs.org/dist/v$sea_node_version/$node_name.tar.gz"
  curl -fsSL -o "$work/SHASUMS256.txt" "https://nodejs.org/dist/v$sea_node_version/SHASUMS256.txt"
  (cd "$work" && grep " $node_name.tar.gz\$" SHASUMS256.txt | shasum -a 256 -c --quiet -)
  tar -xzf "$work/$node_name.tar.gz" -C "$(dirname "$node_dir")"
fi

node scripts/update-release-package-versions.ts "$version"
vp run --filter t3 build
PATH="$node_dir/bin:$PATH" node apps/server/scripts/cli.ts build-exe --target "$platform"

base_archive="t3-$release_version-$platform.tar.gz"
curl -fsSL -o "$work/SHA256SUMS" "https://github.com/$FORK_REPOSITORY/releases/download/$release_tag/SHA256SUMS"
curl -fsSL -o "$work/$base_archive" "https://github.com/$FORK_REPOSITORY/releases/download/$release_tag/$base_archive"
(cd "$work" && grep " $base_archive\$" SHA256SUMS | shasum -a 256 -c --quiet -)

stem="t3-$version-$platform"
mkdir -p "$work/$stem"
tar -xzf "$work/$base_archive" -C "$work/$stem" --strip-components=1
cp apps/server/dist-exe/"t3-$platform" "$work/$stem/t3"
chmod 755 "$work/$stem/t3"
rm -rf "$work/$stem/client"
cp -R apps/server/dist/client "$work/$stem/client"
find "$work/$stem/client" -name '*.map' -delete
mkdir -p release
archive="$repo_root/release/$stem.tar.gz"
# No macOS metadata files or extended attributes in the archive for Linux.
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$archive" -C "$work" "$stem"
echo "Built $archive"
[[ -n "$host" ]] || exit 0

# The last step of the server: `t3 update` checks that the new `t3` runs and reports the version,
# points the `t3` launcher and the service at it and restarts the service. It does not go back by
# itself, so the script waits for the server to report the new version and goes back when it does not.
remote_archive="/tmp/$stem.tar.gz"
scp -q "$archive" "$host:$remote_archive"
if ! ssh "$host" bash -s -- "$version" "$remote_archive" <<'REMOTE'; then
set -euo pipefail
version="$1"
archive="$2"
versions="${T3CODE_HOME:-$HOME/.t3}/runtime/versions"
mkdir -p "$versions"
staging="$(mktemp -d "$versions/.staging-XXXXXX")"
trap 'rm -rf "$staging" "$archive"' EXIT
tar -xzf "$archive" -C "$staging" --strip-components=1
printf '%s\n' "$version" >"$staging/.install-complete"
rm -rf "${versions:?}/$version"
mv "$staging" "$versions/$version"
# Through the launcher link of scripts/install.sh, `t3 update` also points `t3` at the new version.
launcher="$HOME/.local/bin/t3"
[[ -x "$launcher" ]] || launcher="$versions/$version/t3"

# server-runtime.json is one line of JSON that the running server writes.
runtime_state="${T3CODE_HOME:-$HOME/.t3}/userdata/server-runtime.json"
state_field() {
  local json
  json="$(cat "$runtime_state" 2>/dev/null)" || return 1
  [[ "$json" == *"\"$1\":\""* ]] || return 1
  json="${json#*\"$1\":\"}"
  printf '%s' "${json%%\"*}"
}
previous="$(state_field serverVersion || true)"

"$launcher" update "$version" --yes

for _ in $(seq 1 30); do
  sleep 3
  origin="$(state_field origin || true)"
  if [[ -n "$origin" ]] &&
    curl -fsS --max-time 3 "$origin/.well-known/t3/environment" 2>/dev/null |
    grep -qF "\"serverVersion\":\"$version\""; then
    echo "The server reports $version."
    exit 0
  fi
done

echo "The server did not report $version within 90 seconds. Check the service log: $launcher service status" >&2
if [[ -z "$previous" || "$previous" == "$version" || ! -d "$versions/$previous" ]]; then
  echo "No earlier version to go back to in $versions." >&2
  exit 1
fi
echo "Going back to $previous." >&2
if "$launcher" update "$previous" --yes --allow-downgrade; then
  echo "The server is back on $previous." >&2
else
  echo "The rollback failed. Run this on the server: $launcher update $previous --yes --allow-downgrade" >&2
fi
exit 1
REMOTE
  echo "The deploy of $version to $host failed. See the messages above." >&2
  exit 1
fi
echo "Deployed $version to $host"
