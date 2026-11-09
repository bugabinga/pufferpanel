# Host-owned reviewer visual image; never build the candidate's copy of this file.
# The base is pinned by digest; Chromium and fonts are that Alpine branch's current security builds, recorded per review.
# The panel binary is the candidate's own musl build from the just-primed gate image; it does not run in the glibc tests image.
FROM docker.io/library/node:26.12.1-alpine@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797
RUN apk add --no-cache chromium font-dejavu
COPY --chmod=0555 --from=localhost/pufferpanel-maintainer-tests /pufferpanel/pufferpanel /opt/annie/pufferpanel
# The build context inherits the host scripts' umask 077; the non-root container user must still read and run both.
COPY --chmod=0444 ui-driver.mjs /opt/annie/ui-driver.mjs
