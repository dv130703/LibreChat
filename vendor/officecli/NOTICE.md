# Third-party notice

`vendor/officecli/` is a fork of [OfficeCLI](https://github.com/iOfficeAI/OfficeCLI)
(iOfficeAI), licensed under the Apache License, Version 2.0 — see `LICENSE`
in this directory. Per §4(b) of that license, files modified for this fork
carry the change inline as a code comment rather than a blanket list here;
search for comments referencing this repo's `officecli-harness/` for the
specific behavioral changes (markdown-leak rejection, table-header-bold
default, direct-formatted-heading rejection) added on top of upstream.

Recorded here for this repo's own third-party-dependency tracking:

| Field | Value |
|---|---|
| Project | OfficeCLI |
| Upstream | https://github.com/iOfficeAI/OfficeCLI |
| License | Apache License 2.0 |
| Vendored as | Full source fork (not a pinned binary release) |
| Modifications | See `git log -- vendor/officecli/src` for the exact diff against whatever upstream commit this was forked from |
