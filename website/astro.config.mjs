import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://preciousidam.github.io",
  base: "/roku-codex-toolkit",
  build: { format: "directory" },
  integrations: [
    starlight({
      title: "Roku Codex Toolkit",
      description: "Project-neutral Codex plugins for Roku development, automation, and evidence-aware verification.",
      favicon: "/favicon.svg",
      social: [
        { icon: "github", label: "GitHub", href: "https://github.com/preciousidam/roku-codex-toolkit" },
      ],
      customCss: ["./src/styles/custom.css"],
      sidebar: [
        {
          label: "Start here",
          items: [
            { label: "Overview", slug: "" },
            { label: "Getting started", slug: "getting-started" },
            { label: "Troubleshooting", slug: "troubleshooting" },
          ],
        },
        {
          label: "Plugins and reference",
          items: [
            { label: "Plugin guide", slug: "marketplace" },
            { label: "Reference index", slug: "reference" },
          ],
        },
        {
          label: "Safety and evidence",
          items: [
            { label: "Security", slug: "security" },
            { label: "Hardware validation", slug: "hardware-validation" },
            { label: "Stabilization audit", slug: "stabilization-audit" },
          ],
        },
        {
          label: "Project",
          items: [
            { label: "Tooling comparison", slug: "tooling-comparison" },
            { label: "Contributing", slug: "contributing" },
            { label: "Portal decision", slug: "docs-portal" },
          ],
        },
        {
          label: "Releases",
          items: [
            { label: "v0.2.0", slug: "v0-2-0" },
            { label: "v0.1.0", slug: "v0-1-0" },
            { label: "npm distribution", slug: "npm-distribution" },
            { label: "License evaluation", slug: "license-evaluation" },
          ],
        },
      ],
    }),
  ],
});
