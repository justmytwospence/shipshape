# Contributing

Thanks for looking. shipshape is maintained by one person, so the most useful things are
clear bug reports, small focused pull requests, and questions that turn into better docs.

## Before you start

- Open an issue first for anything larger than a bug fix, so we agree on the shape before
  you spend time on it.
- Security problems go to a
  [private advisory](https://github.com/justmytwospence/shipshape/security/advisories/new),
  not an issue.

## Development

Node 26 (`.nvmrc`), git, and the Docker compose CLI plugin (no daemon is needed for the
tests).

    npm ci --ignore-scripts
    npm test               # the whole suite, about 20 seconds
    npm run typecheck      # src/ and test/
    npm run check          # Biome: lint and format
    npm run dev:ui         # the UI on http://127.0.0.1:8081 with an empty sandbox
    npm run dev:ui -- --demo   # the same with a demo repository and history

`npm run dev:ui` never touches a real repository or the Docker daemon: it runs on a
throwaway database and checkout, with no credentials and no scheduler. A change to the
interface is checked by eye at phone and desktop sizes, light and dark; see
[Development](https://justmytwospence.github.io/shipshape/development/).

A change that users can see updates the documentation page that describes it, in
`docs/` (`npm run docs:dev`).

## Commits

- [Conventional commits](https://www.conventionalcommits.org/): `fix(deploy): ...`,
  `feat(ui): ...`, imperative, about 60 characters. The changelog is generated from them.
- One logical change per commit, with its tests.
- Sign off every commit (`git commit -s`), which certifies the
  [Developer Certificate of Origin](https://developercertificate.org/).

## License of contributions

shipshape is licensed under the FSL-1.1-ALv2 (see LICENSE.md). By contributing, you
license your contribution to the project under the
[Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0), the license
every release of shipshape becomes two years after it ships, and you certify the DCO for it.

## AI-assisted contributions

Welcome, on the same terms as any other: you understand every line you send, you have run
the tests and looked at the result, and the pull request says which tools you used. A pull
request whose author cannot explain it will be closed.
