#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1
PORT=${PORT:-5178} node serve.mjs
