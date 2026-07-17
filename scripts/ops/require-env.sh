#!/usr/bin/env bash
set -euo pipefail

if (( $# == 0 )); then
  echo "usage: $0 VARIABLE [VARIABLE ...]" >&2
  exit 64
fi

missing=()
for name in "$@"; do
  if [[ ! "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo "invalid environment variable name: $name" >&2
    exit 64
  fi
  if [[ -z "${!name:-}" ]]; then
    missing+=("$name")
  fi
done

if (( ${#missing[@]} > 0 )); then
  printf 'required environment variable is unset or empty: %s\n' "${missing[@]}" >&2
  exit 1
fi
