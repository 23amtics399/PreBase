# PreBase

PreBase is a platform to build AI Chatbots from your own content, running entirely on Cloudflare Workers + D1 + Workers AI.

## Smart Knowledge Ingestion (Opt-in)

PreBase supports **Smart Knowledge Ingestion** to improve your bot's retrieval accuracy. This feature provides AI-assisted retrieval enrichment using Groq (`qwen/qwen3.8-27b`) to generate valuable search metadata for your uploaded documents.

* **What it does**: When you upload a document, Smart Enrichment uses Groq Qwen to generate hypothetical questions, keywords, topics, and negative constraints that match the document's content. This semantic metadata is indexed alongside your document in SQLite FTS5, dramatically improving search accuracy for vague or conceptually related questions.
* **Opt-in by default**: Smart Enrichment is completely optional. You must explicitly enable it (e.g., passing `enrichment=true` when uploading) for it to process your documents.
* **Privacy & Data Usage**: When enabled, the chunked text of your uploaded documents is sent to the Groq API (`qwen/qwen3.8-27b`) for processing.
* **Original Content is Authoritative**: Groq is only used to generate *metadata for search*. Your original document content is never modified, overwritten, or rewritten. The chatbot's generative model (Cloudflare Workers AI IBM Granite) will only ever read and cite your exact original uploaded text.
* **Graceful Degradation**: If the Groq API is down, rate-limited, or fails to enrich a chunk, your document is still ingested and searchable using standard text matching. Normal knowledge retrieval is never broken by an enrichment failure.
