# Shared visual policy

Read this file for every generated asset.

## Story fidelity

- Use only facts present in the structured handoff and its explicitly named dependency images.
- Never carry a place, ethnic or regional identity, period, brand, character, costume, prop, or title from an example into another story.
- Do not infer an exact age, height, weight, ethnicity, uniform, brand, readable document text, or location when the source did not establish it.
- Preserve upstream asset IDs. When the supplied board explains an asset's wearing, operation, states, or ownership relationship, label those facts explicitly rather than suppressing the necessary demonstration or inventing new assets.

## Visual baseline

Unless the user or handoff specifies another style, use photorealistic live-action cinematic realism: natural human proportions, physically credible materials, restrained color, realistic light, skin and fabric texture. Express the intended style positively instead of appending a generic list of forbidden looks.

“IMAX”, “film still”, or a named lens family may be used only as non-binding visual vocabulary when it supports the requested story style. Do not claim that a generated bitmap was physically photographed with that equipment.

## Board semantics

- Character, scene, and prop outputs are production reference boards. They explain declared identity, space, material, state, and applicable use; they are not substitutes for video generation.
- Multiple views, necessary state demonstrations, and explicitly requested ownership comparisons express only the declared asset facts, not new story events.
- Titles, view labels, information fields, and material/state notes are presentation aids organized naturally from the original templates and supplied facts. The JSON handoff remains the semantic source of truth. `exactText` lists only user-requested verbatim copy; an empty list does not prohibit text.
- Pass user-requested exact text into the prompt; rendering is not guaranteed. Do not perform automatic text recognition or claim exact typography was achieved. The user judges the returned image.
- Do not encode machine identifiers, hashes, or binding data only inside the image.

## First output and manual selection

Save and display the first returned image, then hand off its real file for registration. Do not automatically inspect visual content, recognize text, score, decide pass/fail, create visual observations or QA receipts, reject, regenerate, or ask for per-image confirmation. The user decides satisfaction and can later request an edit to a specific image.

Technical validation remains: real image bytes/format, dimensions from the file, contained paths, asset identity, image and recipe hashes, and formal Core registration. These facts do not prove visual quality. Keep historical QA files and verdicts untouched for compatibility only; absence of those files is not a prerequisite failure. Never substitute an empty receipt or renamed quality certificate.

Image generation is stochastic. Do not claim “100% consistent”, exact typography, dimensions, or an exact model without appropriate evidence; this flow performs no automatic visual approval. Technical dimensions and execution mode come only from actual file/tool metadata.
