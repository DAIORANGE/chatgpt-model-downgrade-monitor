# Changelog

## 1.5.0

- Added turn-level Fetch + WebSocket evidence aggregation to prevent fragmented duplicate records.
- Added evidence completeness tracking and clearer explanations for requested, assistant, resolved, and server-route model fields.
- Rebuilt PoW visualization around one canonical series shared by the full chart and floating mini waveform.
- Added semantic PoW point colors, path-following pulse animation, richer hover details, and reload-safe PoW-to-turn persistence.
- Redesigned the floating monitor bar and model comparison panel with stronger semantic status colors.
- Improved archive readability, typography, model-flow symmetry, assistant avatar placement, and dialogue visual hierarchy.
- Clarified RTT/downlink wording and kept PoW explicitly framed as auxiliary observational data rather than an IP quality score.

## 1.4.1

- Added public-project userscript metadata (`@homepageURL`, `@supportURL`, `@downloadURL`, `@updateURL`).
- Added bilingual userscript name/description metadata.
- Added a visible GitHub project link in the monitor header and settings page.
- Added bilingual public README files and explicit acknowledgements to ChatGPT Route Inspector and GPT-Monitor.
- No intended change to the core model-observation logic from v1.4.0.

## 1.4.0

- Added multi-theme UI and improved Japanese-style desktop-tool visual hierarchy.
- Added draggable concept explainers for PoW, model evidence, RTT/downlink and status logic.
- Reworked status copy to explain why a result appears and which evidence triggered it.
- Reworked settings into user-facing language and added selectable alert sounds, volume and preview.
- Improved PoW visualization and explanations.
