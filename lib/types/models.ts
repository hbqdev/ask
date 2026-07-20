export interface Model {
  id: string
  name: string
  provider: string
  providerId: string
  providerOptions?: Record<string, any>
  // Whether the model accepts image input directly. When true, attached
  // images are sent to the model as-is (its own vision); when false/unset,
  // the model receives the VLM-extracted text instead. See
  // lib/config/model-vision.ts.
  vision?: boolean
}
