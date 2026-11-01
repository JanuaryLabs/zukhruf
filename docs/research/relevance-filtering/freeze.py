# Freezes files: writes <file>.sha256 and <file>.frozenAt (UTC) and makes the file read-only.
# Usage: python3 -I freeze.py <file>...
import hashlib, os, stat, sys
from datetime import datetime, timezone

for path in sys.argv[1:]:
    digest = hashlib.sha256(open(path, 'rb').read()).hexdigest()
    base = os.path.splitext(path)[0]
    open(base + '.sha256', 'w').write(digest + '\n')
    open(base + '.frozenAt', 'w').write(datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ') + '\n')
    os.chmod(path, stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)
    print(path, digest)
