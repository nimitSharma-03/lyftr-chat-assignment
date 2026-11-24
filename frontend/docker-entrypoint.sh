#!/bin/sh
set -e
# Write runtime config so the API URL can be changed without rebuilding.
if [ -n "${API_URL:-}" ]; then
  printf 'window.__APP_CONFIG__ = { API_URL: "%s" };\n' "$API_URL" > /usr/share/nginx/html/config.js
fi
exec nginx -g 'daemon off;'
