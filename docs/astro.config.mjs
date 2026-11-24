// @ts-check
import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'
import tailwindcss from '@tailwindcss/vite'
import mermaid from 'astro-mermaid'
import starlightLinksValidator from 'starlight-links-validator'
import starlightLlmsTxt from 'starlight-llms-txt'

const REPO = 'https://github.com/justmytwospence/shipshape'

export default defineConfig({
  site: 'https://justmytwospence.github.io',
  base: '/shipshape',
  trailingSlash: 'always',
  integrations: [
    // Before starlight, so its rehype step sees ```mermaid fences first.
    mermaid({ theme: 'neutral', autoTheme: true }),
    starlight({
      title: 'shipshape',
      description:
        'Docker image updates for a compose homelab kept in git: reads the changelog, ships what nothing holds, deploys, verifies and rolls back.',
      logo: { light: './src/assets/mark.svg', dark: './src/assets/mark-dark.svg', alt: 'shipshape' },
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: REPO }],
      editLink: { baseUrl: `${REPO}/edit/main/docs/` },
      lastUpdated: true,
      customCss: ['./src/styles/global.css'],
      components: { Head: './src/components/Head.astro' },
      sidebar: [
        { label: 'Start here', items: ['start/quick-start', 'start/requirements', 'start/first-update'] },
        {
          label: 'Concepts',
          items: [
            'concepts/how-it-works',
            'concepts/classes-and-holds',
            'concepts/review',
            'concepts/shipping',
            'concepts/deploy-and-rollback',
            'concepts/restore-points',
            'concepts/drafted-changes',
            'concepts/security-incidents',
          ],
        },
        {
          label: 'Guides',
          items: [
            'guides/sign-in',
            'guides/reverse-proxy',
            'guides/docker-permissions',
            'guides/git-hosts',
            'guides/models',
            'guides/notifications',
            'guides/own-builds',
            'guides/forks',
            'guides/mcp',
            'guides/backup',
            'guides/upgrading',
            'guides/migrating-from-v1',
          ],
        },
        {
          label: 'Reference',
          items: [
            'reference/environment',
            'reference/labels',
            'reference/policy',
            'reference/notifications',
            'reference/http',
            'reference/cli',
            'reference/image',
          ],
        },
        {
          label: 'More',
          items: [
            'compare',
            'security',
            'troubleshooting',
            'faq',
            'development',
            { label: 'Changelog', link: `${REPO}/blob/main/CHANGELOG.md`, attrs: { target: '_blank' } },
          ],
        },
      ],
      plugins: [starlightLinksValidator({ errorOnLocalLinks: true }), starlightLlmsTxt({ projectName: 'shipshape' })],
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
    // Pages import examples/ and src/policy-starter.ts from the repository root.
    server: { fs: { allow: ['..'] } },
  },
})
