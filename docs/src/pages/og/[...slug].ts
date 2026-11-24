import { getCollection } from 'astro:content'
import { OGImageRoute } from 'astro-og-canvas'

const entries = await getCollection('docs')
const pages = Object.fromEntries(entries.map(({ data, id }) => [id === '' ? 'index' : id, { data }]))

export const { getStaticPaths, GET } = await OGImageRoute({
  param: 'slug',
  pages,
  getImageOptions: (_path, page: (typeof pages)[string]) => ({
    title: page.data.title,
    description: page.data.description,
    bgGradient: [[19, 22, 28]],
    border: { color: [0, 110, 179], width: 24, side: 'inline-start' },
    padding: 80,
    logo: { path: './public/og-mark.png', size: [96] },
    font: {
      title: { size: 72, weight: 'Bold', color: [226, 230, 236] },
      description: { size: 36, color: [192, 199, 210] },
    },
  }),
})
