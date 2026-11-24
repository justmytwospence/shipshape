# Security policy

## Reporting a vulnerability

Report it privately through a
[GitHub security advisory](https://github.com/justmytwospence/shipshape/security/advisories/new).
Please do not open a public issue. You will get an answer within a week; a fix for a
confirmed problem ships as a patch release, and the advisory is published with it, with
credit if you want it.

## Supported versions

Only the newest release receives fixes. shipshape is on 0.x: upgrade to the newest minor
release to get a fix.

## Threat model in brief

shipshape holds the Docker socket and pushes to the repository your host deploys from, so
it is as powerful as root on that host. It trusts the host, the socket, its data
directory, your compose repository and everyone who can push to it, your policy file and
labels, the signed-in user, the holder of `MCP_TOKEN`, and in proxy mode your reverse
proxy. It does not trust release notes, model output, registry responses, links you type,
or browsers: those can add holds or draft a change that waits for you, and cannot ship
anything on their own.

The full model, what leaves your network, and the known gaps are in the
[security model](https://justmytwospence.github.io/shipshape/security/).
