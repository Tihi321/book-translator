/** Document IR: what every format adapter reads into and writes from. */

/** `vn`: a Scriptorium visual-novel book folder (see formats/vn.ts). */
export type DocFormat = 'epub' | 'docx' | 'txt' | 'md' | 'pdf' | 'vn'

export type BlockKind = 'heading' | 'para' | 'item' | 'caption' | 'cell' | 'toc' | 'meta'

/**
 * An inline formatting tag that was replaced by a numbered placeholder in `Block.text`:
 * `<n>...</n>` for a `pair` (bold, italic, link, run with other properties) and `<n/>` for a `void` (line break, image, note mark).
 */
export interface InlineTag {
  n: number
  kind: 'pair' | 'void'
  /** Adapter-specific: the original element serialization (EPUB) or the run properties (DOCX). */
  data: unknown
}

export interface Block {
  id: string
  kind: BlockKind
  /** Text with inline placeholders. */
  text: string
  tags: InlineTag[]
  /** Heading level (1 = top), set by adapters that can tell (PDF). */
  level?: number
}

export interface Section {
  id: string
  title?: string
  blocks: Block[]
}

export interface DocumentIR {
  format: DocFormat
  meta: {
    title?: string
    language?: string
    /** Names that must stay as they are in the translation (the characters of a visual novel): seeded into the glossary. */
    names?: string[]
  }
  sections: Section[]
}

/** Options for `FormatAdapter.write`. */
export interface WriteOptions {
  /** Target language code (`hr`, `ar`...): written to language attributes, and picks the text direction. */
  targetLanguage?: string
  /** Called for a translation the adapter could not use (the source text was written instead). */
  onWarning?: (message: string) => void
  /**
   * Visual-novel folders: localized character names, from the lower-cased source name to the name to write (speaker tags, `ON SCREEN:` lines and the
   * bible's character bullets). Unset or empty: the folder is written byte for byte as it was.
   */
  names?: Record<string, string>
  /** EPUB: `title` replaces the cover image by a plain title page made from the translated title and the author (default `source`: the original image, with its alt text translated). */
  cover?: 'source' | 'title'
}

export interface FormatAdapter {
  /** Default extension of the written file, with dot (`.epub`). Unset: same as the source file. */
  outputExt?: string
  read(path: string): Promise<DocumentIR>
  /**
   * Writes the translated document. `translations` maps block id to translated text (with the same placeholders).
   * Blocks without a translation keep the source text. `srcPath` is the original file, edited in place where the format allows.
   */
  write(ir: DocumentIR, translations: Map<string, string>, srcPath: string, outPath: string, opts?: WriteOptions): Promise<void>
}
