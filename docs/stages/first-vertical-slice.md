# First Vertical Slice

This stage turns ApplyGo from an architecture portal into a locally testable product: private candidate evidence, manual job ingestion, deterministic eligibility signals, and evidence-grounded fit analysis.

## What you can test

1. create a separate profile for yourself, your wife, or another trusted user
2. upload a PDF résumé, text file, or Markdown file
3. paste longer career notes that are not suitable for a résumé
4. review every extracted statement before it can be used
5. paste a real job description
6. inspect the stored job, normalized signals, fit score, evidence references, gaps, questions, model/provider metadata, and latency

## Where private information lives

Private files do **not** belong in Git or GitHub Secrets.

| Data | Storage | Committed? |
|---|---|---|
| résumé PDFs and notes | `data/private/<user>/<profile>/` or Docker private volume | no |
| candidate records, jobs, assessments | local SQLite or PostgreSQL database | no |
| API keys and runtime configuration | local `.env`, host secret manager, or deployment secret store | no |
| source code, schemas, tests, docs | Git repository | yes |
| CI test data | synthetic fixtures only | yes |

GitHub Secrets are suitable for CI or a deployed instance, but they are not a candidate-document database. Never store a résumé, career history, or application result in a GitHub secret.

## Local setup

```bash
git clone https://github.com/jasonsheinkopf/ApplyGo.git
cd ApplyGo
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
cp .env.example .env
applygo serve
```

Open `http://127.0.0.1:8000`.

The default model provider is `mock`. It makes the complete product flow testable without spending API credits. The mock path is deterministic and only considers evidence that has been explicitly confirmed and marked usable.

## Using a hosted model

Edit `.env`:

```dotenv
APPLYGO_MODEL_PROVIDER=openai
APPLYGO_MODEL_NAME=<supported-model-name>
OPENAI_API_KEY=<your-api-key>
```

or:

```dotenv
APPLYGO_MODEL_PROVIDER=anthropic
APPLYGO_MODEL_NAME=<supported-model-name>
ANTHROPIC_API_KEY=<your-api-key>
```

A consumer ChatGPT or Claude subscription is not assumed to provide application API access. Programmatic execution uses an API key or a supported local endpoint.

## Using a local model

Run an Ollama-compatible server, then configure:

```dotenv
APPLYGO_MODEL_PROVIDER=ollama
APPLYGO_MODEL_NAME=<installed-model>
OLLAMA_BASE_URL=http://localhost:11434/v1
OLLAMA_API_KEY=ollama
```

## Docker with PostgreSQL

```bash
cp .env.example .env
docker compose up --build
```

This uses named Docker volumes for PostgreSQL and private uploaded files. Deleting the repository directory does not automatically delete those volumes.

## Validation framework

Each model/provider should be run against the same profile/job cases. Record:

- hard-eligibility correctness
- unsupported-claim count
- evidence-reference validity
- missing-information detection
- recommendation consistency
- latency
- token usage
- estimated cost
- user corrections and final accept/reject decision

The first committed tests use synthetic data only. Real candidate documents remain private and should be used through the running application, not as fixtures.

## Current limitations

- PDF extraction is text-based and does not yet handle complex visual layouts or scanned PDFs
- imported paragraphs are evidence candidates, not automatically verified facts
- the first job-ingestion path accepts pasted descriptions rather than scraping a URL
- authentication is not yet suitable for public internet exposure
- database schema creation currently uses SQLAlchemy metadata; formal migrations are a follow-up
- browser application execution is deliberately excluded from this slice

Do not expose the current local server directly to the public internet. The next deployment step must add authentication, authorization, encrypted transport, and a reviewed storage design.
