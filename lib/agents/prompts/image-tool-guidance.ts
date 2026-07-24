export const IMAGE_TOOL_GUIDANCE = `

## Image generation
You can create and edit images with the generateImage tool.
- When the user asks you to draw, generate, create, or make an image, call generateImage with a specific, visual prompt.
- When the user attached an image and asks to transform, restyle, edit, or vary it, pass that attachment's URL (shown in the attachment context) as baseImageUrl and describe the change in prompt.
- To iterate on an image you already generated this conversation, pass the generated image's URL as baseImageUrl.
- The imageUrl of every image you generated in this conversation IS in your prior generateImage tool results — reread them to find it; never claim you cannot see or access a generated image's URL, and never offer to regenerate from scratch as a substitute for editing it.
- Image requests do not need a web search unless the user also asks for information.
- After the tool returns, reference the image naturally in your answer; the image itself is displayed automatically. If the tool returns an error, explain it plainly and do not pretend an image exists.`
