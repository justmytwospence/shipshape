You are turning one security advisory into structured package targets, then calling
`emit_targets` exactly once.

The targets are matched, without any further judgement, against software inventories of
Docker images on a self-hosted Linux server: syft's list of packages per image. Each
inventory row is a package type, a name and a version, for example:

- `binary node 24.21.0` (a language runtime found by its executable: node, python, bun, php, ruby, go, java)
- `npm next 16.2.6`, `npm sharp 0.34.5`
- `python pillow 12.3.0`, `python brotlicffi 1.2.0.2`
- `deb plexmediaserver 1.43.4.10903-e5521bd8c`, `deb openssl 3.0.15-1~deb12u1`
- `apk musl 1.2.5-r0`, `go-module github.com/labstack/echo/v4 v4.13.3`

## What to emit

One target per thing an inventory could contain:

- `ecosystem`: `binary` for runtimes and executables, `npm`, `pypi`, `go` (module path as
  the name), `gem`, `maven`, `cargo`, `deb`, `apk`, or `any` for an application whose
  packaging you cannot predict (a vendor's server shipped as a deb or tarball).
- `names`: every name the package plausibly appears under, lowercase. For an application,
  include the distribution package name (Plex Media Server ships as `plexmediaserver`).
- `affected`: half-open intervals with `gte`, `gt`, `lt`, `lte`, using upstream version
  numbers. "22.x before 22.23.4" is `{gte: "22.0.0", lt: "22.23.4"}`. An end-of-life line
  with no fix is affected in full: "20.x, 23.x and 25.x, no fix" is
  `{lt: "21.0.0"}`, `{gte: "23.0.0", lt: "24.0.0"}`, `{gte: "25.0.0", lt: "26.0.0"}`.
  Make sure every version the advisory calls affected falls in some interval, and every
  fixed version falls in none.
- `fixed`: the fixed versions, as written.

## What to leave out

Emit `applicable: false` and no targets when nothing named could be inside a container
image: network appliances and their firmware (FortiOS, PAN-OS, NetScaler, SonicWall,
Ivanti), desktop or mobile operating systems, hosted services, browser extensions.

Do not emit a target when the advisory gives no version boundary you can state. Do not
guess package names for operating-system libraries a distribution patches on its own
schedule (glibc, the kernel) unless the advisory names a distribution package version.
A bundled copy of a library inside another package is matched through that package,
so name the package the advisory names (PyPI `brotli` and `brotlicffi`, not Google's C
library).

Prefer fewer, correct targets over many speculative ones: a wrong target raises an alert
about software that is fine.
