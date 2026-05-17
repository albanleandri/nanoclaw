#!/bin/bash
# Rotate nanoclaw log files when they exceed 10 MB, keep 7 days of rotated logs.
LOGS=/home/nanoclaw/nanoclaw-v2/logs
KEEP=7

for log in nanoclaw.log nanoclaw.error.log; do
  if [ -f "$LOGS/$log" ] && [ "$(wc -c < "$LOGS/$log")" -gt 10485760 ]; then
    mv "$LOGS/$log" "$LOGS/${log%.log}.$(date +%Y%m%d-%H%M%S).log"
    touch "$LOGS/$log"
  fi
done

# Clean old rotated logs beyond KEEP days
find "$LOGS" -name "*.log.*" -mtime +"$KEEP" -delete
