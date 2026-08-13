# Documentation portal decision

## Decision

The documentation portal is an isolated Astro Starlight workspace under `website/`. Repository
Markdown remains canonical and is copied into Starlight's generated content directory before each
development preview or production build. Portal-only navigation pages live under `website/content`.

The toolkit continues to support Node.js 18 and Python 3.9. Current Astro and Starlight require a
newer Node runtime, so the website has its own `package.json`, lockfile, and Node 22.12+ requirement.
Website dependencies are never included in the `roku-codex-toolkit` npm tarball.

GitHub Pages is the preferred eventual host because this is a public GitHub repository, the output
is entirely static, and deployment can use GitHub Actions with no runtime secrets. The included
workflow template is intentionally inactive. Enabling Pages or copying that template into
`.github/workflows` requires separate approval.

## Alternatives considered

| Option | Decision | Tradeoff |
| --- | --- | --- |
| GitHub Pages with Starlight | Preferred | Fits the repository workflow and static output; requires an isolated Node 22 documentation build |
| VitePress | Not selected | Good Markdown-first option, but current development also requires Node 22 and offers less documentation-specific structure for this portal |
| Docusaurus | Not selected | Strong versioning and internationalization, but heavier than the current content and current releases require a newer Node runtime than the toolkit |
| Hand-written static HTML | Not selected | Minimal dependencies, but navigation, search, metadata, accessibility, and link integrity become bespoke maintenance |
| Separate website repository | Deferred | Useful if marketing ownership or deployment cadence diverges; currently increases synchronization risk |

## Information architecture

- **Start here:** installation, first device, first flow, and troubleshooting.
- **Plugins:** feature matrix and a generated-link reference to the two plugins, five skills, MCP
  tools, schemas, and examples.
- **Safety:** security policy, stabilization audit, and hardware-validation boundaries.
- **Project:** tooling comparison, contributor setup, and packaging decisions.
- **Releases:** current and historical release-boundary documents.

## Local preview and checks

From `website/`, use `npm ci` once, then `npm run dev` for a local preview. `npm run check` performs
the production build and audits the generated HTML for internal broken links, page titles, language,
main landmarks, headings, and image alternative text. CI runs this check independently on Node
22.12 without changing the toolkit's Node 18 validation matrix.

The static audit is a baseline, not a substitute for browser and assistive-technology testing. Before
the first public deployment, manually verify keyboard navigation, visible focus, responsive layouts,
light/dark contrast, zoom, reduced motion, search, and screen-reader landmarks in the production
preview.

## Deployment boundary

`website/deploy/github-pages.yml` is a reviewed template, not an active workflow. After explicit
publication approval:

1. Enable GitHub Pages with GitHub Actions as the source.
2. Copy the template to `.github/workflows/docs-pages.yml` in a focused deployment pull request.
3. Protect the `github-pages` environment and review the workflow permissions.
4. Require the documentation CI job and preview the production artifact before merging.
5. Deploy only from `main`; do not expose credentials or runtime configuration because the site is
   static.

The initial project URL uses the `/roku-codex-toolkit/` base path. A custom domain can be introduced
later without changing canonical repository links.
