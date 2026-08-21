#!/usr/bin/env bash
# Removes the ban records created by a non-browser request against /api/files.
# Reads MONGO_URI from the project .env; prints nothing sensitive.
set -euo pipefail
cd "$(dirname "$0")/.."
URI=$(grep -m1 '^MONGO_URI=' .env | cut -d= -f2- | tr -d '"'"'"' \r')
# Two stores hold bans in different Keyv namespaces and BOTH must go:
#   BANS:<id>  - getLogStores(ViolationTypes.BAN), written by banViolation
#   ban:<id>   - the banCache in checkBan.js, re-read on every request
mongosh "$URI" --quiet --eval '
  const r = db.logs.deleteMany({ key: { $regex: /^(BANS|ban):/ } });
  print("ban records deleted: " + r.deletedCount);
  print("remaining: " + db.logs.countDocuments({ key: { $regex: /^(BANS|ban):/ } }));
'
