declare module "word-extractor" {
  class ExtractedDocument {
    getBody(): string;
  }

  export default class WordExtractor {
    extract(input: Buffer | string): Promise<ExtractedDocument>;
  }
}
