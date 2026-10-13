# Fork

This repository is a bugabinga-maintained fork of [PufferPanel](https://github.com/pufferpanel/pufferpanel).
`upstream` is `https://github.com/pufferpanel/pufferpanel.git`, while `origin` is `git@github.com:bugabinga/pufferpanel.git`.
The upstream `LICENSE` remains unchanged.
This document records fork-specific technical behavior rather than an upstream contribution proposal.

## Build and regeneration

The Go module requires Go 1.27.2 in [`go.mod`](../go.mod).
Swagger generation uses the pinned module tool through `go tool swag` in [`Dockerfile`](../Dockerfile).
Frontend workspaces use Yarn Classic 1.22.22 as declared in [`client/package.json`](../client/package.json).
From `client/`, run `yarn workspace frontend update:ace` to regenerate vendored Ace assets.
[`client/frontend/scripts/update-ace.sh`](../client/frontend/scripts/update-ace.sh) copies only regular non-symlink source files into regular non-symlink existing destination files and fails when an expected source file is absent.
The Ace source package is pinned to 1.44.0 in [`client/frontend/package.json`](../client/frontend/package.json).
Vendored Ace assets live in [`client/frontend/public/js/ace/`](../client/frontend/public/js/ace/) and retain their upstream license in [`client/frontend/public/js/ace/LICENSE`](../client/frontend/public/js/ace/LICENSE).
Run Go tests, including race tests, plus frontend test, lint, and build gates after dependency or generated-asset updates.

## Runtime and compatibility

Native-image and rootless-container compatibility are outside official upstream support.
Run services under a dedicated runtime user.
Granting that user access to a container socket grants control of every container reachable through that socket.
Backups and uploads are destructive-capable workflows, so stop affected workloads and verify backups before extracting or replacing archive data.
Restore first extracts and validates an archive in an OS-temporary staging directory, then removes live root children and copies staged data through confined file servers.
Missing, corrupt, malformed, traversal, or over-limit archives therefore leave live files unchanged and retain the backup.
A write or out-of-space failure during final replacement can leave a partial live replacement; the backup remains intact.
The archive data writer can leave a partial destination file when a read error occurs.
Current tracks are selected manually and do not update the host automatically.
The template-tester image retains Ubuntu 22.04 because the official Mono packages failed dependency resolution on Ubuntu 26.04.
Go 1.27.2, Node 26.10.0, Java, Mono, and the 32-bit runtime libraries were verified in that compatibility image.

## Archive behavior

[`files/compression.go`](../files/compression.go) migrated archive handling to `github.com/mholt/archives` and routes every built-in RAR extractor, automatic or forced value or pointer, through a dedicated reader with a 256 MiB dictionary cap.
Forced `archives.Rar` accepts `Password`; its `Name`, `FS`, and `ContinueOnError` options are explicitly unsupported because they would bypass the source `FileServer` or cannot preserve extraction error handling.
Archive extraction has fixed limits rather than operator-sizing settings: 1 GiB compressed input, 4 GiB total extracted data, 1 GiB per file, 100000 paths, 4096-byte paths, a 10-minute deadline, and a 256 MiB RAR dictionary.
The deadline bounds archive-operation context checks but does not guarantee absolute CPU scheduling or interruption of every header parser.
Archive entries with unsafe paths, non-regular types, or link targets are rejected or skipped before writing.
The TAR hardlink regression is covered by `TestExtractSkipsLinks` in [`files/compression_test.go`](../files/compression_test.go).
The tested archive fixtures cover RAR5 and 7z, while ZIPX is recognized from ZIP content rather than its extension.
Raw LZMA compression streams are not supported as archives.
No previously advertised archive extension is silently removed by this migration.
