---
status: accepted
---

# Lightweight Browser-Side Imaging and Zero Core Pixel Bloat

We remove server-side DICOM and TCGA-BRCA whole-slide ingestion pipelines, `dcmjs`, `@cornerstonejs/codec-openjpeg`, `jpeg-js`, `openseadragon`, the 14 imaging/pathology maintenance scripts, and multi-gigabyte local pixel archives. Radiology and pathology clinical workflows remain intact in structured form (orders, billing hooks, versioned structured **Reports**, and **Report Acknowledgement** gates) with zero pixel weight in **Mini HIS Core** or Cloudflare Workers. Optional `mod-imaging` and `mod-pathology` modules dynamically lazy-load lightweight browser Canvas viewers consuming pre-baked WebP/PNG keyframes or external URL / Cloudflare R2 (10 GB free, zero egress) static assets—keeping all rendering computation in the user's browser.

## Considered Options

- **Keep server-side DICOM/WSI transcoding and local pixel storage**: Bloats dependencies, breaks Cloudflare Free deployment constraints, and creates gigabyte setup friction for contributors and agents.
- **Remove visual medical imaging entirely with no extension point**: Limits future multimodal clinical agent exploration.

## Consequences

- Fresh clones require zero pixel downloads and Cloudflare Workers bundle zero imaging libraries.
- Visual cases can attach lightweight static assets or external R2 tiles purely through **Hospital Data Pack** references when `mod-imaging` or `mod-pathology` is enabled.
