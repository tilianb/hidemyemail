# Autofill attribution

Portions of `src/detection.ts` and matching cases in `test/detection.test.ts`
are adapted from DuckDuckGo Autofill.

Copyright (c) 2021 Duck Duck Go, Inc.
Licensed under the Apache License, Version 2.0. See `DUCKDUCKGO_LICENSE.md`,
included in the source tree and built extension ZIP.

Upstream revision: `34eb540473a90d25e11942e9c72a18c2430d4f50`.

Sources:
- https://github.com/duckduckgo/duckduckgo-autofill/blob/34eb540473a90d25e11942e9c72a18c2430d4f50/src/Form/matching-config/matching-config-source.js
  (`ddgMatcher.emailAddress` only, not the third-party `vendorRegex` table)
- https://github.com/duckduckgo/duckduckgo-autofill/blob/34eb540473a90d25e11942e9c72a18c2430d4f50/src/Form/matching-config/selectors-css.js
- https://github.com/duckduckgo/duckduckgo-autofill/blob/34eb540473a90d25e11942e9c72a18c2430d4f50/src/Form/matching.test.js

Modified for HideMyEmail: selected email-language rules and search/filter/code
exclusions, tighter word boundaries, camel-case metadata normalization, and
local regression cases. French and Japanese literal labels supplement the
selected DDG-authored rules. No Apple ID inference, field-value matching,
vendor regex table, device adapter, telemetry, or automatic submission is used.
Accessible-label resolution is a local implementation supporting multiple IDs
and root-local lookup.

These adapted portions remain subject to Apache-2.0. HideMyEmail's original
code remains MIT-licensed. No Bitwarden implementation is included.
