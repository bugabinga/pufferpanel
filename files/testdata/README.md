# Archive test fixtures

`valid-rar5.rar` is an unmodified copy of `github.com/mholt/archiver/v3` v3.5.1 `testdata/sample.rar`.

Source license: MIT, retained in [`LICENSE-archiver-MIT`](LICENSE-archiver-MIT).

`valid.7z` is an unmodified copy of `github.com/bodgit/sevenzip` v1.6.1 `testdata/t0.7z`.

Source module checksum: `h1:kikg2pUMYC9ljU7W9SaqHXhym5HyKm8/M/jd31fYan4=`.

Source license: BSD-3-Clause, retained in [`LICENSE-sevenzip-BSD`](LICENSE-sevenzip-BSD).

`dictionary-512m.rar` is derived from the licensed `valid-rar5.rar` source fixture.

Its first compressed RAR5 file-header dictionary exponent was changed from 32MiB to 512MiB, its unpacked-size-unknown flag set, and its header CRC32 recomputed according to the RAR5 header format parsed by `github.com/nwaples/rardecode/v2` v2.2.0.

The fixture remains a valid single-volume RAR5 header and must be rejected before packed-data decoding or dictionary allocation.

SHA-256:

- `valid-rar5.rar`: `bcf90e753971b927c753f84706f9d1ba8f69f60d3351ff770fa119ee9914c241`
- `valid.7z`: `8b409e4c0422b8f0d2ecea5096aed768e6975d894943498e0431767ba6caacf0`
- `dictionary-512m.rar`: `0080b77bb7d3004582d259e7546f28bbbad9b97e6405f188be2331c202bf02ca`
