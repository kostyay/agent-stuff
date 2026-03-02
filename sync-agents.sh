#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILES_DIR="${SCRIPT_DIR}/profiles"

if [[ ! -d "${PROFILES_DIR}" ]]; then
  echo "error: profiles/ directory not found at ${PROFILES_DIR}" >&2
  exit 1
fi

synced=0

for profile_file in "${PROFILES_DIR}"/AGENTS.agent-*.md; do
  [[ -f "${profile_file}" ]] || continue

  # Extract profile name: AGENTS.agent-work.md -> agent-work
  basename="$(basename "${profile_file}")"
  profile="${basename#AGENTS.}"  # agent-work.md
  profile="${profile%.md}"       # agent-work

  target_dir="${HOME}/.pi/${profile}"
  target="${target_dir}/AGENTS.md"

  if [[ ! -d "${target_dir}" ]]; then
    echo "skip: ${target_dir} does not exist (profile '${profile}' not set up)"
    continue
  fi

  # Remove existing file/symlink before creating new one
  if [[ -e "${target}" || -L "${target}" ]]; then
    rm "${target}"
  fi

  ln -s "${profile_file}" "${target}"
  echo "linked: ${profile_file} -> ${target}"
  ((synced++))
done

if [[ ${synced} -eq 0 ]]; then
  echo "warning: no profiles were synced"
else
  echo "done: synced ${synced} profile(s)"
fi
