import { describe, expect, it } from 'vitest'

import { extractSpecContent } from '@/features/thread/model/spec'

function fence(lines: object[]): string {
  return ['```spec', ...lines.map(l => JSON.stringify(l)), '```'].join('\n')
}

const add = (path: string, value: unknown) => ({ op: 'add', path, value })

function button(text: string, query = text) {
  return {
    type: 'Button',
    props: { text, variant: 'link', icon: 'arrow-right' },
    on: { press: { action: 'submitQuery', params: { query } } },
    children: []
  }
}

function relatedFence(queries: string[]): string {
  const ids = queries.map((_, i) => `q${i + 1}`)
  return fence([
    add('/root', 'main'),
    add('/elements/main', {
      type: 'Stack',
      props: { direction: 'vertical', gap: 'sm' },
      children: ['header', 'questions']
    }),
    add('/elements/header', {
      type: 'Heading',
      props: { title: 'Related', icon: 'related' },
      children: []
    }),
    add('/elements/questions', {
      type: 'Stack',
      props: { direction: 'vertical', gap: 'xs' },
      children: ids
    }),
    ...queries.map((q, i) => add(`/elements/${ids[i]}`, button(q)))
  ])
}

function image(src: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'Image',
    props: { src, aspectRatio: '4:3', ...extra },
    children: []
  }
}

function imageFence(images: ReturnType<typeof image>[]): string {
  const ids = images.map((_, i) => `img${i + 1}`)
  return fence([
    add('/root', 'grid'),
    add('/elements/grid', {
      type: 'Grid',
      props: { columns: 3, gap: 'sm' },
      children: ids
    }),
    ...images.map((img, i) => add(`/elements/${ids[i]}`, img))
  ])
}

describe('extractSpecContent', () => {
  it('reads the related queries of a Heading + 3 Buttons fence in order', () => {
    const text = `Answer.\n\n${relatedFence(['First?', 'Second?', 'Third?'])}`
    expect(extractSpecContent(text)).toEqual({
      related: ['First?', 'Second?', 'Third?'],
      images: []
    })
  })

  it('dedupes related queries and keeps at most 5', () => {
    const text = relatedFence(['a', 'b', 'a', 'c', 'd', 'e', 'f'])
    expect(extractSpecContent(text).related).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('ignores Buttons whose action is not submitQuery or whose query is blank', () => {
    const other = {
      ...button('Open'),
      on: { press: { action: 'openUrl', params: { query: 'nope' } } }
    }
    const blank = button('Blank', '  ')
    const text = fence([
      add('/root', 'main'),
      add('/elements/main', {
        type: 'Stack',
        props: {},
        children: ['b1', 'b2', 'b3']
      }),
      add('/elements/b1', other),
      add('/elements/b2', blank),
      add('/elements/b3', button('Kept'))
    ])
    expect(extractSpecContent(text).related).toEqual(['Kept'])
  })

  it('reads a Button bound to a list of actions and skips one with none', () => {
    const listed = {
      ...button('Listed'),
      on: {
        press: [
          { action: 'track', params: {} },
          { action: 'submitQuery', params: { query: 'Listed' } }
        ]
      }
    }
    const { on: _unused, ...unbound } = button('Unbound')
    const text = fence([
      add('/root', 'main'),
      add('/elements/main', {
        type: 'Stack',
        props: {},
        children: ['b1', 'b2', 'b1']
      }),
      add('/elements/b1', listed),
      add('/elements/b2', unbound)
    ])
    expect(extractSpecContent(text).related).toEqual(['Listed'])
  })

  it('reads an Image with its title and source URL', () => {
    const text = `## Fuji\n\n${imageFence([
      image('https://cdn.example.com/fuji.jpg', {
        title: 'Mount Fuji',
        sourceUrl: 'https://en.wikipedia.org/wiki/Mount_Fuji'
      })
    ])}\n\nIt is tall.`
    expect(extractSpecContent(text)).toEqual({
      related: [],
      images: [
        {
          src: 'https://cdn.example.com/fuji.jpg',
          title: 'Mount Fuji',
          sourceUrl: 'https://en.wikipedia.org/wiki/Mount_Fuji'
        }
      ]
    })
  })

  it('keeps only http(s) image sources', () => {
    const text = imageFence([
      image('http://a.test/1.png'),
      image('data:image/png;base64,AAAA'),
      image('/uploads/2.png')
    ])
    expect(extractSpecContent(text).images).toEqual([
      { src: 'http://a.test/1.png' }
    ])
  })

  it('keeps only an http(s) source page, else the image opens itself', () => {
    const text = imageFence([
      image('https://a.test/1.png', { sourceUrl: 'javascript:alert(1)' }),
      image('https://a.test/2.png', { sourceUrl: 'ask://ask?q=planted' }),
      image('https://a.test/3.png', { sourceUrl: 'HTTPS://b.test/page' })
    ])
    expect(extractSpecContent(text).images).toEqual([
      { src: 'https://a.test/1.png' },
      { src: 'https://a.test/2.png' },
      { src: 'https://a.test/3.png', sourceUrl: 'HTTPS://b.test/page' }
    ])
  })

  it('collects from several fences, images first then related', () => {
    const text = [
      imageFence([image('https://a.test/1.png')]),
      'Middle.',
      relatedFence(['Next?'])
    ].join('\n\n')
    expect(extractSpecContent(text)).toEqual({
      related: ['Next?'],
      images: [{ src: 'https://a.test/1.png' }]
    })
  })

  it('ignores an unterminated trailing fence', () => {
    const unfinished = relatedFence(['First?']).replace(/\n```$/, '')
    expect(extractSpecContent(`Answer.\n\n${unfinished}`)).toEqual({
      related: [],
      images: []
    })
  })

  it('skips malformed JSONL without throwing', () => {
    const text = [
      '```spec\n{"op":"add","path":"/root",\nnot json at all\n```',
      relatedFence(['Still read?'])
    ].join('\n\n')
    expect(extractSpecContent(text)).toEqual({
      related: ['Still read?'],
      images: []
    })
  })

  it('is empty for text with no spec fence', () => {
    expect(extractSpecContent('Plain answer.')).toEqual({
      related: [],
      images: []
    })
  })
})
