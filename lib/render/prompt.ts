/**
 * Returns the prompt section that instructs the LLM to optionally embed
 * inline image groups as ```spec fenced blocks within the response body.
 */
export function getImageSpecPrompt(): string {
  return `
INLINE IMAGE EMBEDDING:
Whenever the search results contain images relevant to the answer,
embed one or more inline image groups anywhere in the markdown body using \`\`\`spec fenced code blocks.
Default to including at least one image group when relevant images are available (check the "images"
array in tool output), and use several groups for multi-part answers, each placed right where it
illustrates the surrounding text (not only at the top). Prefer 2–4 images per group when good options
exist; a single strong image is fine when only one fits. Visual context communicates faster and more
clearly than prose.

Skip images only for genuinely abstract or text-only topics where no picture helps.
Never include irrelevant or decorative images, and never fabricate URLs.

AVAILABLE COMPONENTS FOR IMAGES:
- Grid: { columns: 1 | 2 | 3 | 4, gap?: "xs" | "sm" | "md" | "lg" } - A fixed-column container that reserves cell widths upfront so streaming images don't reflow.
- Image: { src: string, sourceUrl?: string, title?: string, description?: string, aspectRatio?: "1:1" | "16:9" | "4:3" }

IMAGE SPEC RULES:
1. Only use image URLs taken verbatim from the search tool's "images" array — NEVER fabricate or guess URLs.
2. Map tool output fields to Image props as follows, copying values EXACTLY without rewording:
   - image.url → "src"
   - image.sourceUrl → "sourceUrl" (omit if not present in the tool output — do NOT invent)
   - image.title → "title" (omit if not present)
   - image.description → "description" (omit if not present)
3. The "aspectRatio" field SHOULD reflect the natural orientation of the subject: "1:1" for square (logos, portraits), "16:9" for wide (landscapes, scenes), "4:3" for standard photos. Images within the same Grid should generally use the SAME aspectRatio so they render at identical heights.
4. Always wrap image groups in a Grid. Set "columns" to the exact number of Image children (1–4). For 1 image use columns=1, for 2 use columns=2, etc. Choose the number of images based on the situation — the variety and relevance of available images and how much visual context genuinely helps the answer.
5. You MAY emit multiple \`\`\`spec image blocks, each placed at the position in the markdown where they are contextually relevant (e.g. right after the heading or paragraph they illustrate).
6. Each image spec block must contain ONLY JSONL patches — no commentary inside.

Example (inline image group embedded in markdown body):

## Mount Fuji

Mount Fuji is Japan's tallest peak.

\`\`\`spec
{"op":"add","path":"/root","value":"grid"}
{"op":"add","path":"/elements/grid","value":{"type":"Grid","props":{"columns":3,"gap":"sm"},"children":["img1","img2","img3"]}}
{"op":"add","path":"/elements/img1","value":{"type":"Image","props":{"src":"https://cdn.example.com/fuji-1.jpg","sourceUrl":"https://en.wikipedia.org/wiki/Mount_Fuji","title":"Mount Fuji - Wikipedia","description":"Snow-capped peak at sunrise","aspectRatio":"4:3"},"children":[]}}
{"op":"add","path":"/elements/img2","value":{"type":"Image","props":{"src":"https://cdn.example.com/fuji-2.jpg","sourceUrl":"https://travel.example.com/mount-fuji","title":"Mount Fuji Travel Guide","aspectRatio":"4:3"},"children":[]}}
{"op":"add","path":"/elements/img3","value":{"type":"Image","props":{"src":"https://cdn.example.com/fuji-3.jpg","title":"Cherry blossoms in spring","aspectRatio":"4:3"},"children":[]}}
\`\`\`

It rises 3,776 meters above sea level...
`
}
