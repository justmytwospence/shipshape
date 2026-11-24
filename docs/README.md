# shipshape documentation

The site at <https://justmytwospence.github.io/shipshape/>: Astro Starlight, built on its
own `package.json`, deployed to GitHub Pages from `main` by `.github/workflows/docs.yml`.

```sh
npm --prefix docs ci
npm run docs:dev      # http://localhost:4321/shipshape/
npm run docs:build    # fails on any broken internal link
```

The build downloads a font for the social-preview images (`astro-og-canvas`), so it needs
network access.

Every page needs a `description` in its frontmatter: it is the search snippet, the
`llms.txt` summary and the text of the page's social-preview image.

## Base path and assets

1. Links in `.md`/`.mdx`: absolute, with the base and a trailing slash:
   `[policy file](/shipshape/reference/policy/#reviewmodel)`. Never relative (`../`), never
   without `/shipshape`. `npm run build` fails otherwise.
2. Frontmatter links (`hero.actions[].link`): the same form; the validator does not check
   frontmatter, so copy them from a page link that passes.
3. Links in `.astro` components: `` `${import.meta.env.BASE_URL}guides/forks/` `` (`BASE_URL`
   is `/shipshape/` with `trailingSlash: 'always'`).
4. Images: put them in `docs/src/assets/` and reference them relatively from Markdown
   (`![...](../../assets/screenshots/x.png)`) or import them (`import shot from
   '../../assets/screenshots/x.png'` and `<Image src={shot} alt="..." />` from
   `astro:assets`), so Astro optimises them and the path never depends on the base. Files in
   `docs/public/` (favicon, `og-mark.png`) are referenced with the base:
   `/shipshape/favicon.svg`; Starlight's `favicon` option takes the path *without* the base
   (`/favicon.svg`) and adds it.
5. Code from the repository: `import compose from
   '../../../../examples/compose/quickstart/compose.yaml?raw'` then `<Code code={compose}
   lang="yaml" title="compose.yaml" />`. Never paste it.
6. Heading anchors are what the code links to: never rename `## When a rebase conflicts`,
   `## Retiring a fork` (forks guide) or a `### \`VAR\`` heading in the environment
   reference without updating the code; `test/docs-reference.test.ts` fails if one is
   missing.
